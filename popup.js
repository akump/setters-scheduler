import { parseSchedulePdf } from "./parser.js";
import { parseTourneyPdf } from "./parser-tourney.js";
import { getAllTeamEntries, resolveTeamGames } from "./parser-tourney-core.js";

// Populated by populateTeamSelect() for the tourney format: maps each
// dropdown option's value (its display string, e.g. "Alex Sucks - Co4C1"
// when the plain name isn't unique) back to the {name, league} to resolve.
let tourneyTeamEntries = new Map();

const statusEl = document.getElementById("status");
const appEl = document.getElementById("app");
const teamSelect = document.getElementById("team-select");
const calendarSelect = document.getElementById("calendar-select");
const selectAllEl = document.getElementById("select-all");
const gameListEl = document.getElementById("game-list");
const addBtn = document.getElementById("add-btn");
const resultEl = document.getElementById("result");

const STORAGE_KEY = "lastTeamNumber";
const TOURNEY_STORAGE_KEY = "lastTeamName";
const CALENDAR_STORAGE_KEY = "lastCalendarId";

let parsed = null; // { format: "weekly" | "tourney", data }
let venueTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
// Whether background.js already holds a valid token: null while the silent
// sign-in check is still pending, then true/false once it resolves.
// Interactive sign-in opens a focus-stealing window that closes this popup
// before it can show the result of "Add to Google Calendar" — so that
// button only ever adds events once we know we're signed in; while signed
// out, it just signs in (in a click the user can repeat once it's done)
// instead.
let signedIn = null;

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
  statusEl.hidden = !text;
}

// Only used for the static "no PDF open" message below, so building the
// link via DOM methods (rather than extending setStatus to accept HTML) is
// safe even though other setStatus calls interpolate untrusted text
// (e.message from PDF fetch/parse errors).
function setStatusWithLink(before, url, linkText, after) {
  statusEl.textContent = "";
  statusEl.append(before);
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = linkText;
  statusEl.append(a, after);
  statusEl.classList.remove("error");
  statusEl.hidden = false;
}

function isPdfUrl(url) {
  return /\.pdf(\?|#|$)/i.test(url || "");
}

// Injected into the PDF's own tab so the fetch is same-origin regardless of
// scheme (http(s):// or file://). Runs in the page's MAIN world.
function grabPdfAsBase64() {
  return (async () => {
    try {
      const res = await fetch(location.href);
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const buf = await res.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = "";
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(
          null,
          bytes.subarray(i, i + chunkSize),
        );
      }
      return { ok: true, base64: btoa(binary) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  })();
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function loadActivePdf() {
  // Same reasoning as the timers below: chrome.tabs.query resolves almost
  // instantly, so showing this unconditionally (or hardcoding it into
  // popup.html) just flashes it on screen for an instant.
  const checkingStatusTimer = setTimeout(
    () => setStatus("Checking the current tab…"),
    1000,
  );
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } finally {
    clearTimeout(checkingStatusTimer);
  }
  if (!tab || !isPdfUrl(tab.url)) {
    setStatusWithLink(
      "Open the schedule PDF in this tab first (find it at ",
      "https://cherrygrovesportscenter.com/Leagues/Schedules",
      "cherrygrovesportscenter.com/Leagues/Schedules",
      "), then click the extension icon again.",
    );
    return null;
  }

  // Same reasoning as parsingStatusTimer below: reading a typical PDF via
  // executeScript is often fast enough that showing this unconditionally
  // just flashes it on screen for an instant.
  const readingStatusTimer = setTimeout(() => setStatus("Reading PDF…"), 1000);
  let injection;
  try {
    [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: grabPdfAsBase64,
    });
  } catch (e) {
    setStatus(
      `Couldn't read the PDF (${e.message}). If this is a local file, enable "Allow access to file URLs" for this extension in chrome://extensions.`,
      true,
    );
    return null;
  } finally {
    clearTimeout(readingStatusTimer);
  }

  const outcome = injection?.result;
  if (!outcome || !outcome.ok) {
    setStatus(
      `Couldn't read the PDF: ${outcome?.error || "unknown error"}`,
      true,
    );
    return null;
  }

  // The weekly-format parse is plain text/regex work that usually finishes
  // in a few milliseconds, so showing "Parsing schedule…" unconditionally
  // just flashes it on screen for an instant. Only show it once parsing has
  // actually taken a moment, so quick parses skip the flash and slow ones
  // (e.g. the tournament fallback, which renders pages to canvas) still get
  // real feedback.
  const parsingStatusTimer = setTimeout(
    () => setStatus("Parsing schedule…"),
    1000,
  );
  // Two schedule formats are supported: the weekly roster+grid format, and
  // the single-night tournament-bracket format (no roster, teams named
  // directly in free-form matchup text). Try the cheap text-only parse
  // first; only fall back to the tournament parser (which also renders each
  // page to a canvas to sample red/black text color) if no roster is found.
  try {
    try {
      const weekly = await parseSchedulePdf(
        base64ToArrayBuffer(outcome.base64),
      );
      if (weekly.roster.length > 0) return { format: "weekly", data: weekly };
    } catch (e) {
      // fall through to the tournament-format parser
    }
    const tourney = await parseTourneyPdf(base64ToArrayBuffer(outcome.base64));
    return { format: "tourney", data: tourney };
  } catch (e) {
    setStatus(`Couldn't parse the PDF as a schedule: ${e.message}`, true);
    return null;
  } finally {
    clearTimeout(parsingStatusTimer);
  }
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function isSunday(date) {
  return new Date(date.year, date.month - 1, date.day).getDay() === 0;
}

// Weeknight leagues run evening (PM) slots, so bare hours 1-11 mean PM and a
// bare 12 means noon. Sunday leagues in this venue instead run late morning
// into afternoon (11am-ish start), so 11 and 12 stay as-is and only 1-10
// roll forward into the afternoon.
function to24Hour(hour, sunday) {
  if (sunday) return hour >= 11 ? hour : hour + 12;
  return hour === 12 ? 12 : hour + 12;
}

const VENUE_ADDRESS =
  "Setters Cincy Indoor and Outdoor Volleyball, 4005 Hopper Hill Rd, Cincinnati, OH 45255";

function startAndEndStrings(date, time, sunday, durationMinutes) {
  const hour24 = to24Hour(time.hour, sunday);
  const dateStr = `${date.year}-${pad2(date.month)}-${pad2(date.day)}`;
  const startStr = `${dateStr}T${pad2(hour24)}:${pad2(time.minute)}:00`;

  const startMinutesTotal = hour24 * 60 + time.minute + durationMinutes;
  const endHour = Math.floor(startMinutesTotal / 60) % 24;
  const endMinute = startMinutesTotal % 60;
  const endStr = `${dateStr}T${pad2(endHour)}:${pad2(endMinute)}:00`;

  return { startStr, endStr };
}

function buildEvent(game, myTeam, opponent, durationMinutes) {
  const { date, time, court } = game;
  const { startStr, endStr } = startAndEndStrings(
    date,
    time,
    isSunday(date),
    durationMinutes,
  );

  const isDoubleHeader = game.doubleHeaderTeam === myTeam.number;
  const doubleHeaderNote = isDoubleHeader ? " (double header)" : "";
  const description = [
    `${myTeam.teamName} vs ${opponent.teamName}.`,
    isDoubleHeader
      ? "Double header — doesn't count toward standings."
      : null,
    "Added by the Setters Scheduler extension.",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    summary: `${opponent.teamName} vs ${myTeam.teamName} (${court})${doubleHeaderNote}`,
    location: VENUE_ADDRESS,
    description,
    start: { dateTime: startStr, timeZone: venueTimeZone },
    end: { dateTime: endStr, timeZone: venueTimeZone },
  };
}

// Black (regular, standalone) matches are a fixed-length 3-games-to-21
// booking, always 55 minutes. Red (tournament/bracket) matches are always
// 40 minutes. Neither is paced by the bracket's round cadence — both are
// fixed lengths for this venue.
const STANDALONE_DURATION_MINUTES = 55;
const TOURNAMENT_DURATION_MINUTES = 40;

// Tournament nights in this venue run evening slots regardless of the day
// of week they land on (unlike the recurring Sunday leagues in the weekly
// format), so times are always treated as PM here.
function buildTourneyEvent(entry, myTeamName) {
  const g = entry.game;
  const { date, time, court, league } = g;
  const { startStr, endStr } = startAndEndStrings(
    date,
    time,
    false,
    g.isTournament ? TOURNAMENT_DURATION_MINUTES : STANDALONE_DURATION_MINUTES,
  );

  let opponentLabel;
  let tentativeNote = "";
  if (g.kind === "match") {
    opponentLabel =
      g.teamA.toLowerCase() === myTeamName.toLowerCase() ? g.teamB : g.teamA;
  } else if (g.kind === "winner-vs") {
    if (entry.tentative) {
      opponentLabel = g.opponent;
      tentativeNote = ` (if you win your ${entry.dependsOnTime} match)`;
    } else {
      opponentLabel = `Winner of ${g.refTime} match`;
    }
  } else {
    opponentLabel = "Finals";
    tentativeNote = " (if you reach the finals)";
  }

  const summary = `${opponentLabel} vs ${myTeamName} (${court})${tentativeNote}`;
  const description = [
    `Tournament match: ${myTeamName} vs ${opponentLabel}.`,
    `League: ${league}.`,
    entry.tentative
      ? `Tentative — only happens if ${myTeamName} wins the earlier round.`
      : null,
    "Added by the Setters Scheduler extension.",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    summary,
    location: VENUE_ADDRESS,
    description,
    start: { dateTime: startStr, timeZone: venueTimeZone },
    end: { dateTime: endStr, timeZone: venueTimeZone },
  };
}

function renderGameRow(label, sub, checked, badgeText) {
  const li = document.createElement("li");
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = checked;
  checkbox.className = "game-checkbox";
  const textWrap = document.createElement("div");
  const main = document.createElement("div");
  main.className = "game-main";
  if (badgeText) main.dataset.badge = badgeText;
  main.textContent = label;
  const subEl = document.createElement("div");
  subEl.className = "game-sub";
  subEl.textContent = sub;
  textWrap.append(main, subEl);
  li.append(checkbox, textWrap);
  return { li, checkbox };
}

function formatTime12h(time, date, sunday) {
  const hour24 = to24Hour(time.hour, sunday);
  const ampm = hour24 < 12 || hour24 === 24 ? "am" : "pm";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${pad2(time.minute)}${ampm}`;
}

function renderWeeklyGames() {
  gameListEl.innerHTML = "";
  const { roster, games, durationMinutes } = parsed.data;
  const teamNum = parseInt(teamSelect.value, 10);
  const myTeam = roster.find((r) => r.number === teamNum);
  if (!myTeam) return [];

  const rosterByNum = new Map(roster.map((r) => [r.number, r]));
  const myGames = games
    .filter((g) => g.team1 === teamNum || g.team2 === teamNum)
    .filter((g) => g.date && g.time)
    .sort((a, b) => a.week - b.week);

  const entries = [];

  for (const g of myGames) {
    const oppNum = g.team1 === teamNum ? g.team2 : g.team1;
    const opponent = rosterByNum.get(oppNum) || { teamName: `Team ${oppNum}` };
    const dateStr = `${g.date.month}/${g.date.day}/${g.date.year}`;
    const label = `Week ${g.week}: ${opponent.teamName}`;
    const sub = `${dateStr} · ${formatTime12h(g.time, g.date, isSunday(g.date))} · ${g.court}`;
    const { li, checkbox } = renderGameRow(
      label,
      sub,
      true,
      g.doubleHeaderTeam === teamNum ? "double header" : null,
    );
    gameListEl.appendChild(li);
    entries.push({
      checkbox,
      buildEvent: () => buildEvent(g, myTeam, opponent, durationMinutes),
    });
  }

  return entries;
}

function renderTourneyGames() {
  gameListEl.innerHTML = "";
  const { games } = parsed.data;
  const selected = tourneyTeamEntries.get(teamSelect.value);
  if (!selected) return [];
  const { name: teamName, league: teamLeague } = selected;

  const resolved = resolveTeamGames(games, teamName, teamLeague);
  const entries = [];

  for (const entry of resolved) {
    const g = entry.game;
    const dateStr = g.date
      ? `${g.date.month}/${g.date.day}/${g.date.year}`
      : "";
    let label;
    if (g.kind === "match") {
      const opponent =
        g.teamA.toLowerCase() === teamName.toLowerCase() ? g.teamB : g.teamA;
      label = `${teamName} vs ${opponent}`;
    } else if (g.kind === "winner-vs") {
      label = entry.tentative
        ? `${teamName} vs ${g.opponent} (if you win)`
        : `${teamName} vs Winner of ${g.refTime} match`;
    } else {
      label = `${g.league} Finals${entry.tentative ? " (tentative)" : ""}`;
    }
    const sub = `${dateStr} · ${formatTime12h(g.time, g.date, false)} · ${g.court} · ${g.league}`;
    const { li, checkbox } = renderGameRow(
      label,
      sub,
      true,
      entry.tentative ? "tentative" : null,
    );
    gameListEl.appendChild(li);
    entries.push({
      checkbox,
      buildEvent: () => buildTourneyEvent(entry, teamName),
    });
  }

  return entries;
}

function renderGames() {
  return parsed.format === "weekly"
    ? renderWeeklyGames()
    : renderTourneyGames();
}

function updateAddButton(entryCount) {
  if (entryCount === 0) {
    addBtn.disabled = true;
    addBtn.classList.remove("google-signin");
    addBtn.textContent = "Add to Google Calendar";
    return;
  }
  // signedIn is null while the silent sign-in check (kicked off in init) is
  // still pending. Stay in this neutral, disabled state rather than
  // guessing "Sign in with Google" and then immediately swapping to "Add to
  // Google Calendar" a moment later if a session turns out to already be
  // active — that guess-then-correct order is exactly the flash we want to
  // avoid.
  if (signedIn === null) {
    addBtn.disabled = true;
    addBtn.classList.remove("google-signin");
    addBtn.textContent = "Add to Google Calendar";
    return;
  }
  addBtn.disabled = false;
  addBtn.classList.toggle("google-signin", !signedIn);
  addBtn.textContent = signedIn
    ? "Add to Google Calendar"
    : "Sign in with Google";
}

// Silent (interactive: false) by default so simply opening the popup never
// pops a sign-in window — that only happens once the user actually clicks
// "Sign in with Google"/"Add to Google Calendar" below.
async function loadCalendarList(interactive) {
  const response = await chrome.runtime.sendMessage({
    type: "LIST_CALENDARS",
    interactive,
  });
  const calendars = response?.ok ? response.calendars : [];
  if (calendars.length === 0) return false;

  calendarSelect.innerHTML = "";
  for (const cal of calendars) {
    const opt = document.createElement("option");
    opt.value = cal.id;
    opt.textContent = cal.primary ? `${cal.summary} (primary)` : cal.summary;
    calendarSelect.appendChild(opt);
  }

  const stored = await chrome.storage.local.get(CALENDAR_STORAGE_KEY);
  const lastCalendarId = stored[CALENDAR_STORAGE_KEY];
  if (lastCalendarId && calendars.some((c) => c.id === lastCalendarId)) {
    calendarSelect.value = lastCalendarId;
  }
  return true;
}

async function populateTeamSelect() {
  teamSelect.innerHTML = "";

  if (parsed.format === "weekly") {
    for (const r of parsed.data.roster) {
      const opt = document.createElement("option");
      opt.value = r.number;
      opt.textContent = `${r.teamName} (${r.personName})`;
      teamSelect.appendChild(opt);
    }
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const lastTeam = stored[STORAGE_KEY];
    if (lastTeam && parsed.data.roster.some((r) => r.number === lastTeam)) {
      teamSelect.value = String(lastTeam);
    }
    return;
  }

  const teamEntries = getAllTeamEntries(parsed.data.games);
  tourneyTeamEntries = new Map(teamEntries.map((e) => [e.display, e]));
  for (const entry of teamEntries) {
    const opt = document.createElement("option");
    opt.value = entry.display;
    opt.textContent = entry.display;
    teamSelect.appendChild(opt);
  }
  const stored = await chrome.storage.local.get(TOURNEY_STORAGE_KEY);
  const lastTeam = stored[TOURNEY_STORAGE_KEY];
  if (lastTeam && tourneyTeamEntries.has(lastTeam)) {
    teamSelect.value = lastTeam;
  }
}

function saveSelectedTeam() {
  if (parsed.format === "weekly") {
    chrome.storage.local.set({ [STORAGE_KEY]: parseInt(teamSelect.value, 10) });
  } else {
    chrome.storage.local.set({ [TOURNEY_STORAGE_KEY]: teamSelect.value });
  }
}

async function init() {
  parsed = await loadActivePdf();
  if (!parsed) return;

  if (parsed.format === "weekly" && parsed.data.roster.length === 0) {
    setStatus("Couldn't find a team roster in this PDF.", true);
    return;
  }
  if (parsed.format === "tourney" && parsed.data.games.length === 0) {
    setStatus("Couldn't find any games in this PDF.", true);
    return;
  }

  setStatus("");
  appEl.hidden = false;

  await populateTeamSelect();

  let entries = renderGames();
  updateAddButton(entries.length);

  // Silent only — don't prompt sign-in just for opening the popup. If a
  // session is already active this fills in the real list and marks us
  // signed in; otherwise everything stays in the signed-out state until
  // the user explicitly asks to sign in via the add button below.
  loadCalendarList(false).then((ok) => {
    signedIn = ok;
    updateAddButton(entries.length);
  });

  teamSelect.addEventListener("change", () => {
    saveSelectedTeam();
    entries = renderGames();
    updateAddButton(entries.length);
  });
  calendarSelect.addEventListener("change", () => {
    chrome.storage.local.set({ [CALENDAR_STORAGE_KEY]: calendarSelect.value });
  });
  selectAllEl.addEventListener("change", () => {
    for (const e of entries) e.checkbox.checked = selectAllEl.checked;
  });

  addBtn.addEventListener("click", async () => {
    // Not signed in yet: this click's only job is to establish a session.
    // Doing this as its own step (rather than falling into an interactive
    // sign-in partway through adding events) matters because the
    // interactive Google sign-in window steals focus and closes this
    // popup — if that happened mid-add, the result would never make it
    // back to the UI. Once signed in, a fresh click follows the normal
    // path below, and by then the token is cached so it won't need an
    // interactive prompt (no popup-closing risk) and can report results.
    if (!signedIn) {
      addBtn.disabled = true;
      addBtn.textContent = "Signing in…";
      resultEl.textContent = "";
      const ok = await loadCalendarList(true);
      signedIn = ok;
      updateAddButton(entries.length);
      if (!signedIn) {
        resultEl.textContent = "Sign-in didn't complete. Try again.";
        resultEl.classList.add("error");
      }
      return;
    }

    const chosen = entries
      .filter((e) => e.checkbox.checked)
      .map((e) => e.buildEvent());
    if (chosen.length === 0) {
      resultEl.textContent = "No games selected.";
      resultEl.classList.add("error");
      return;
    }
    addBtn.disabled = true;
    addBtn.textContent = "Adding…";
    resultEl.textContent = "";

    const response = await chrome.runtime.sendMessage({
      type: "ADD_EVENTS",
      calendarId: calendarSelect.value || "primary",
      events: chosen,
    });
    const results = response?.results || [];
    const added = results.filter((r) => r.ok && !r.skipped).length;
    const skipped = results.filter((r) => r.ok && r.skipped).length;
    const failed = results.length - added - skipped;

    const parts = [];
    if (added > 0) parts.push(`added ${added}`);
    if (skipped > 0) parts.push(`${skipped} already on calendar`);
    if (failed > 0) parts.push(`${failed} failed`);
    resultEl.textContent = parts.join(", ") + ".";

    if (failed === 0) {
      resultEl.classList.remove("error");
    } else {
      const firstError = results.find((r) => !r.ok)?.error;
      if (firstError) resultEl.textContent += ` ${firstError}`;
      resultEl.classList.add("error");
    }
    updateAddButton(entries.length);
  });
}

init();
