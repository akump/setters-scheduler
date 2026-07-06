// Pure parsing logic: takes rows of positioned text items (already grouped by
// pdf.js extraction) and turns them into roster + schedule data. Has no
// dependency on pdf.js or the chrome.* APIs so it can be unit tested directly
// with plain arrays of { y, page, items: [{str, x, y, width}] } rows.

const TIME_RE = /^(\d{1,2}):(\d{2})$/;
const MATCHUP_RE = /^(\d{1,3})\s*v\.?\s*(\d{1,3})$/i;
const WEEK_RE = /^Week\s*(\d+)/i;
const DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/;
const COURT_RE = /^Court\s*(\S+)$/i;
const ROSTER_NUM_RE = /^(\d{1,3})$/;

export function parseRoster(rows) {
  const roster = new Map();
  for (const row of rows) {
    const { items } = row;
    if (items.length < 2) continue;
    if (!ROSTER_NUM_RE.test(items[0].str)) continue;
    if (items.some((it) => TIME_RE.test(it.str) || MATCHUP_RE.test(it.str)))
      continue;

    const num = parseInt(items[0].str, 10);
    const rest = items.slice(1);
    if (rest.length === 0) continue;

    let splitIdx = rest.length;
    let maxGap = -Infinity;
    for (let i = 1; i < rest.length; i++) {
      const gap = rest[i].x - (rest[i - 1].x + rest[i - 1].width);
      if (gap > maxGap) {
        maxGap = gap;
        splitIdx = i;
      }
    }
    const teamName = rest
      .slice(0, splitIdx)
      .map((it) => it.str)
      .join(" ")
      .trim();
    const personName = rest
      .slice(splitIdx)
      .map((it) => it.str)
      .join(" ")
      .trim();
    if (teamName) roster.set(num, { number: num, teamName, personName });
  }
  return roster;
}

export function parseCourts(rows) {
  const courts = [];
  for (const row of rows) {
    for (const item of row.items) {
      const m = COURT_RE.exec(item.str);
      if (m) courts.push({ label: `Court ${m[1]}`, x: item.x });
    }
  }
  const seen = new Map();
  for (const c of courts) if (!seen.has(c.label)) seen.set(c.label, c.x);
  return [...seen.entries()]
    .map(([label, x]) => ({ label, x }))
    .sort((a, b) => a.x - b.x);
}

function resolveCourt(x, courts) {
  if (courts.length === 0) return null;
  if (courts.length === 1) return courts[0].label;
  let best = courts[0];
  let bestDist = Math.abs(x - courts[0].x);
  for (const c of courts.slice(1)) {
    const d = Math.abs(x - c.x);
    if (d < bestDist) {
      best = c;
      bestDist = d;
    }
  }
  return best.label;
}

function normalizeYear(y) {
  return y < 100 ? 2000 + y : y;
}

export function parseSchedule(rows, courts) {
  // A week's date label can appear on any row within that week's block (here,
  // the vertically-centered row), not necessarily before the games it
  // applies to. So: first pass assigns each row to a week band and collects
  // one date per week; second pass backfills every game from that week's
  // date, regardless of row order.
  const games = [];
  const dateByWeek = new Map();
  let currentWeek = null;

  for (const row of rows) {
    const { items } = row;
    let rowWeek = null;
    let rowDate = null;
    let rowTime = null;

    for (const item of items) {
      const wm = WEEK_RE.exec(item.str);
      if (wm) rowWeek = parseInt(wm[1], 10);
      const dm = DATE_RE.exec(item.str);
      if (dm)
        rowDate = { month: +dm[1], day: +dm[2], year: normalizeYear(+dm[3]) };
      const tm = TIME_RE.exec(item.str);
      if (tm) rowTime = { hour: +tm[1], minute: +tm[2] };
    }

    if (rowWeek !== null) currentWeek = rowWeek;
    if (rowDate && currentWeek !== null) dateByWeek.set(currentWeek, rowDate);

    for (const item of items) {
      const mm = MATCHUP_RE.exec(item.str);
      if (!mm) continue;
      games.push({
        week: currentWeek,
        date: null,
        time: rowTime,
        court: resolveCourt(item.x, courts),
        team1: parseInt(mm[1], 10),
        team2: parseInt(mm[2], 10),
      });
    }
  }

  for (const game of games) {
    game.date = dateByWeek.get(game.week) ?? null;
  }

  return { games };
}

export function mostCommonDurationMinutes(games) {
  const byDay = new Map();
  for (const g of games) {
    if (!g.time || !g.date) continue;
    const key = `${g.date.year}-${g.date.month}-${g.date.day}`;
    const mins = g.time.hour * 60 + g.time.minute;
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(mins);
  }
  const diffCounts = new Map();
  for (const mins of byDay.values()) {
    mins.sort((a, b) => a - b);
    for (let i = 1; i < mins.length; i++) {
      const d = mins[i] - mins[i - 1];
      if (d > 0) diffCounts.set(d, (diffCounts.get(d) || 0) + 1);
    }
  }
  let best = 60;
  let bestCount = 0;
  for (const [d, count] of diffCounts) {
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

export function findTitle(rows) {
  for (const row of rows.slice(0, 5)) {
    const text = row.items
      .map((it) => it.str)
      .join(" ")
      .trim();
    if (text && !/^Monday|^Court|^Week/i.test(text)) return text;
  }
  return "League Schedule";
}

const ROW_TOLERANCE = 3;

export function groupIntoRows(items, pageNum) {
  const sorted = [...items].sort((a, b) => b.y - a.y);
  const rows = [];
  for (const item of sorted) {
    let row = rows.find((r) => Math.abs(r.y - item.y) <= ROW_TOLERANCE);
    if (!row) {
      row = { y: item.y, page: pageNum, items: [] };
      rows.push(row);
    }
    row.items.push(item);
  }
  for (const row of rows) row.items.sort((a, b) => a.x - b.x);
  return rows;
}

export function parseSchedulePdfRows(rows) {
  const roster = parseRoster(rows);
  const courts = parseCourts(rows);
  const { games } = parseSchedule(rows, courts);
  const durationMinutes = mostCommonDurationMinutes(games);
  const title = findTitle(rows);

  return {
    title,
    roster: [...roster.values()].sort((a, b) => a.number - b.number),
    games,
    durationMinutes,
  };
}
