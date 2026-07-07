// Pure parsing logic for the "tournament night" schedule format (a single
// day, courts running in parallel columns, matches sometimes chained via
// "Winner <time> vs. <team>" and terminating in "Finals <league>"). Distinct
// from parser-core.js, which handles the multi-week roster+grid format.
//
// Takes rows of positioned+colored text items (see extractColoredRows in
// parser-tourney.js) and returns the event date, courts, and games.
//
// Unlike the weekly-grid format, matches here are free-form multi-word text
// that can legitimately span several pdf.js text items (team names, "vs."),
// and two courts sit side-by-side on the same visual line — so a single
// y-row can contain two unrelated matches back to back. The gap between
// them isn't a reliable split signal (it shrinks to nothing when the left
// match's text happens to be long), so instead each row is split at "marker"
// items: a time token (e.g. "6:15") or a "Court N ..." header always marks
// the start of a new column segment.

const TIME_RE = /^(\d{1,2}):(\d{2})$/;
const DATE_RE = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/;
const COURT_RE = /^Court\s+(\d+)\b\s*(.*)$/i;
const COURT_START_RE = /^Court\s+\d+\b/i;

// Matches "Finals <league>", e.g. "Finals Co4C2".
const FINALS_RE = /^Finals\s+(\S+)\s*$/i;
// Matches "<league>: Win[ner] [Ct. [<n>]] <time> vs. <team>" — some sheets
// abbreviate "Winner" to "Win", and some reference a court without a number
// (e.g. "Win Ct. 9:55 vs. Team"). The digit group's trailing \s* (not \s+)
// matters: when there's no number, the whitespace before the time was
// already consumed by the \s* right after "Ct.", so a mandatory \s+ there
// would never match and the whole optional group would fail to backtrack
// into place.
const WINNER_RE =
  /^(\S+):\s*Win(?:ner)?\s+(?:Ct\.?\s*(\d+)?\s*)?(\d{1,2}:\d{2})\s+vs\.?\s+(.+)$/i;
// Matches "<league>: <teamA> vs. <teamB>".
const MATCH_RE = /^(\S+):\s*(.+?)\s+vs\.?\s+(.+)$/i;

// A gap at least this big is a normal word space; anything smaller (e.g. a
// glyph run butting up against an apostrophe) gets no space inserted.
const WORD_GAP_MIN = 1.5;

function normalizeYear(y) {
  return y < 100 ? 2000 + y : y;
}

function isSegmentMarker(item) {
  return TIME_RE.test(item.str) || COURT_START_RE.test(item.str);
}

// pdf.js usually gives the next column's leading time token as its own
// item, but occasionally glues it onto the end of the previous column's
// text run with no item boundary at all (e.g. "...vs Hope N Glory 7:35").
// Split those out so the marker-based segmentation below can still see it.
const FUSED_TRAILING_TIME_RE = /^(.*\S)\s+(\d{1,2}:\d{2})$/;

function splitFusedTrailingTime(item) {
  const m = FUSED_TRAILING_TIME_RE.exec(item.str);
  if (!m) return [item];
  const [, before, time] = m;
  const splitWidth = item.width * (before.length / item.str.length);
  return [
    { ...item, str: before, width: splitWidth },
    {
      ...item,
      str: time,
      x: item.x + splitWidth,
      width: item.width - splitWidth,
    },
  ];
}

// Splits a row's items at each marker (time token or "Court N" item), since
// those reliably indicate "a new column's content starts here" regardless
// of how much horizontal gap is left over from the previous column.
function splitIntoSegments(rawItems) {
  const items = rawItems.flatMap(splitFusedTrailingTime);
  const segments = [];
  let current = [];
  for (const it of items) {
    if (isSegmentMarker(it) && current.length) {
      segments.push(current);
      current = [];
    }
    current.push(it);
  }
  if (current.length) segments.push(current);
  return segments;
}

function segmentText(items) {
  let out = "";
  let prevEnd = null;
  for (const it of items) {
    if (prevEnd !== null && it.x - prevEnd >= WORD_GAP_MIN) out += " ";
    out += it.str;
    prevEnd = it.x + it.width;
  }
  return out.trim();
}

function majorityColor(items) {
  const counts = {};
  for (const it of items) counts[it.color] = (counts[it.color] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || "black";
}

function parseMatchSegment(items) {
  if (items.length < 2) return null;
  const timeMatch = TIME_RE.exec(items[0].str);
  if (!timeMatch) return null;
  const time = {
    hour: parseInt(timeMatch[1], 10),
    minute: parseInt(timeMatch[2], 10),
  };
  const restText = segmentText(items.slice(1));

  let m = FINALS_RE.exec(restText);
  if (m) {
    return { time, kind: "finals", league: m[1] };
  }

  m = WINNER_RE.exec(restText);
  if (m) {
    return {
      time,
      kind: "winner-vs",
      league: m[1],
      refCourt: m[2] ? parseInt(m[2], 10) : null,
      refTime: m[3],
      opponent: m[4].trim(),
    };
  }

  m = MATCH_RE.exec(restText);
  if (m) {
    return {
      time,
      kind: "match",
      league: m[1],
      teamA: m[2].trim(),
      teamB: m[3].trim(),
    };
  }

  return null;
}

function findEventDate(rows) {
  for (const row of rows.slice(0, 5)) {
    const m = DATE_RE.exec(segmentText(row.items));
    if (m) {
      return {
        month: parseInt(m[1], 10),
        day: parseInt(m[2], 10),
        year: normalizeYear(parseInt(m[3], 10)),
      };
    }
  }
  return null;
}

// A team name alone isn't always unique on a tournament night — the same
// name can legitimately be entered in more than one league (e.g. a group
// playing both a co-ed and a men's division). Each returned entry has a
// `name` (for matching/labeling games) and a `league` scope: null when the
// name is unique across the whole night, or the specific league when it
// isn't, so the dropdown can show "Name - League" to disambiguate and
// resolveTeamGames can filter to just that league's games.
export function getAllTeamEntries(games) {
  const leaguesByKey = new Map(); // lowercase name -> Set<league>
  const displayNameByKey = new Map(); // lowercase name -> original-cased name

  function record(name, league) {
    const key = name.trim().toLowerCase();
    if (!leaguesByKey.has(key)) leaguesByKey.set(key, new Set());
    leaguesByKey.get(key).add(league);
    if (!displayNameByKey.has(key)) displayNameByKey.set(key, name.trim());
  }

  for (const g of games) {
    if (g.kind === "match") {
      record(g.teamA, g.league);
      record(g.teamB, g.league);
    } else if (g.kind === "winner-vs") {
      record(g.opponent, g.league);
    }
  }

  const entries = [];
  for (const [key, leagues] of leaguesByKey) {
    const name = displayNameByKey.get(key);
    if (leagues.size === 1) {
      entries.push({ name, league: null, display: name });
    } else {
      for (const league of leagues) {
        entries.push({ name, league, display: `${name} - ${league}` });
      }
    }
  }
  entries.sort((a, b) => a.display.localeCompare(b.display));
  return entries;
}

function poolKey(court, league) {
  return `${court}|${league}`;
}

function minutesOf(time) {
  return time.hour * 60 + time.minute;
}

function parseTimeStr(str) {
  const m = TIME_RE.exec(str);
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}

function namesEqual(a, b) {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

// Resolves every game a team could play: direct scheduled matches, games
// where they're already the named (opponent-TBD) side of a "Winner X vs.
// Team" slot, and — chained forward through the bracket via matching
// (court, league, time) references — every later round they'd reach only
// by winning the round before it (marked tentative).
//
// Black (regular) matches are single standalone games even when the text
// happens to say "Winner ..."/"Finals" (that phrasing sometimes carries
// over from how the sheet was laid out, but doesn't mean elimination
// advancement for a black match). Only a red (tournament) game unlocks
// further chaining — a team whose entry match is black just gets that one
// game and never reaches a "Finals" line.
export function resolveTeamGames(games, teamName, teamLeague = null) {
  // When the same name is used in more than one league, teamLeague scopes
  // matching to just that one (see getAllTeamEntries).
  function matches(name, league) {
    return namesEqual(name, teamName) && (!teamLeague || league === teamLeague);
  }

  const anchors = new Map(); // poolKey -> Set<minutes>, red/tournament games only
  const anchorCourtsByLeague = new Map(); // league -> Set<court>

  // A league's semifinal-type rounds sometimes run on a different court
  // than where its shared "Finals <league>" is hosted, with no explicit
  // cross-reference tying them together (unlike "Winner Ct. N <time>",
  // which always names its court explicitly). But the same league code can
  // also legitimately label separate, unrelated brackets on different
  // courts that each resolve on their own. So: a court whose bracket has
  // its own local "Finals <league>" is assumed self-contained (its anchors
  // only reach that local finals); a court with NO local finals for that
  // league is assumed to feed an external one, and can reach any other
  // court's finals for the same league.
  const finalsCourtsByLeague = new Map(); // league -> Set<court>
  for (const g of games) {
    if (g.kind === "finals") {
      if (!finalsCourtsByLeague.has(g.league))
        finalsCourtsByLeague.set(g.league, new Set());
      finalsCourtsByLeague.get(g.league).add(g.court);
    }
  }

  const results = [];

  function addAnchor(court, league, minutes) {
    const key = poolKey(court, league);
    if (!anchors.has(key)) anchors.set(key, new Set());
    anchors.get(key).add(minutes);
    if (!anchorCourtsByLeague.has(league))
      anchorCourtsByLeague.set(league, new Set());
    anchorCourtsByLeague.get(league).add(court);
  }

  for (const g of games) {
    if (
      g.kind === "match" &&
      (matches(g.teamA, g.league) || matches(g.teamB, g.league))
    ) {
      results.push({ game: g, tentative: false });
      if (g.isTournament) addAnchor(g.court, g.league, minutesOf(g.time));
    } else if (g.kind === "winner-vs" && matches(g.opponent, g.league)) {
      results.push({ game: g, tentative: false });
      if (g.isTournament) addAnchor(g.court, g.league, minutesOf(g.time));
    }
  }

  // Chain forward through winner-vs/finals games using anchors, repeating
  // until a pass adds nothing new (handles multi-round brackets).
  let changed = true;
  while (changed) {
    changed = false;
    for (const g of games) {
      if (g.kind !== "winner-vs" && g.kind !== "finals") continue;
      if (results.some((r) => r.game === g)) continue;

      if (g.kind === "winner-vs") {
        const targetCourt = g.refCourt ? `Court ${g.refCourt}` : g.court;
        const targetKey = poolKey(targetCourt, g.league);
        const refMinutes = parseTimeStr(g.refTime);
        if (refMinutes !== null && anchors.get(targetKey)?.has(refMinutes)) {
          results.push({ game: g, tentative: true, dependsOnTime: g.refTime });
          if (g.isTournament) addAnchor(g.court, g.league, minutesOf(g.time));
          changed = true;
        }
      } else if (g.kind === "finals") {
        const anchorCourts = anchorCourtsByLeague.get(g.league);
        const finalsCourts = finalsCourtsByLeague.get(g.league) || new Set();
        const reachable =
          anchorCourts &&
          [...anchorCourts].some(
            (court) => court === g.court || !finalsCourts.has(court),
          );
        if (reachable) {
          results.push({ game: g, tentative: true, dependsOnTime: null });
          changed = true;
        }
      }
    }
  }

  results.sort((a, b) => minutesOf(a.game.time) - minutesOf(b.game.time));
  return results;
}

export function parseTourneySchedule(rows) {
  const eventDate = findEventDate(rows);

  // Court headers can appear at different x positions as we scan down the
  // page (e.g. "Court 1"/"Court 2" side by side, then further down "Court
  // 3"/"Court 4" at the same x positions again). Track one "current court"
  // per x-column, updating whenever a new header is seen in that column.
  const columnSlots = []; // { x, courtLabel, courtName }
  const games = [];

  for (const row of rows) {
    for (const segment of splitIntoSegments(row.items)) {
      const text = segmentText(segment);

      const courtMatch = COURT_RE.exec(text);
      if (courtMatch) {
        const x = segment[0].x;
        let slot = columnSlots.find((s) => Math.abs(s.x - x) < 40);
        if (!slot) {
          slot = { x, courtLabel: null, courtName: null };
          columnSlots.push(slot);
        }
        slot.x = x;
        slot.courtLabel = `Court ${courtMatch[1]}`;
        slot.courtName = courtMatch[2].trim() || null;
        continue;
      }

      const parsed = parseMatchSegment(segment);
      if (!parsed) continue;

      const rowX = segment[0].x;
      let slot = null;
      for (const s of columnSlots) {
        if (!slot || Math.abs(s.x - rowX) < Math.abs(slot.x - rowX)) slot = s;
      }

      games.push({
        ...parsed,
        isTournament: majorityColor(segment) === "red",
        court: slot?.courtLabel ?? null,
        courtName: slot?.courtName ?? null,
        date: eventDate,
      });
    }
  }

  return { eventDate, games };
}
