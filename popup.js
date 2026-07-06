import { parseSchedulePdf } from "./parser.js";

const statusEl = document.getElementById("status");
const appEl = document.getElementById("app");
const teamSelect = document.getElementById("team-select");
const calendarSelect = document.getElementById("calendar-select");
const selectAllEl = document.getElementById("select-all");
const gameListEl = document.getElementById("game-list");
const addBtn = document.getElementById("add-btn");
const resultEl = document.getElementById("result");

const STORAGE_KEY = "lastTeamNumber";
const CALENDAR_STORAGE_KEY = "lastCalendarId";

let parsed = null; // { title, roster, games, durationMinutes }
let venueTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
  statusEl.hidden = !text;
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
          bytes.subarray(i, i + chunkSize)
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
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !isPdfUrl(tab.url)) {
    setStatus(
      "Open the schedule PDF in this tab first, then click the extension icon again."
    );
    return null;
  }

  setStatus(`Reading ${tab.title || "PDF"}…`);
  let injection;
  try {
    [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: grabPdfAsBase64,
    });
  } catch (e) {
    setStatus(
      `Couldn't read the PDF (${e.message}). If this is a local file, enable "Allow access to file URLs" for this extension in chrome://extensions.`,
      true
    );
    return null;
  }

  const outcome = injection?.result;
  if (!outcome || !outcome.ok) {
    setStatus(`Couldn't read the PDF: ${outcome?.error || "unknown error"}`, true);
    return null;
  }

  setStatus("Parsing schedule…");
  try {
    const buf = base64ToArrayBuffer(outcome.base64);
    return await parseSchedulePdf(buf);
  } catch (e) {
    setStatus(`Couldn't parse the PDF as a schedule: ${e.message}`, true);
    return null;
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

function buildEvent(game, myTeam, opponent, durationMinutes) {
  const { date, time, court } = game;
  const hour24 = to24Hour(time.hour, isSunday(date));
  const dateStr = `${date.year}-${pad2(date.month)}-${pad2(date.day)}`;
  const startStr = `${dateStr}T${pad2(hour24)}:${pad2(time.minute)}:00`;

  const startMinutesTotal = hour24 * 60 + time.minute + durationMinutes;
  const endHour = Math.floor(startMinutesTotal / 60) % 24;
  const endMinute = startMinutesTotal % 60;
  const endStr = `${dateStr}T${pad2(endHour)}:${pad2(endMinute)}:00`;

  return {
    summary: `${opponent.teamName} vs ${myTeam.teamName} (${court})`,
    location: court || "",
    description: `League volleyball match: ${myTeam.teamName} vs ${opponent.teamName}.\nAdded by the Setters Scheduler extension.`,
    start: { dateTime: startStr, timeZone: venueTimeZone },
    end: { dateTime: endStr, timeZone: venueTimeZone },
  };
}

function renderGameRow(label, sub, checked) {
  const li = document.createElement("li");
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = checked;
  checkbox.className = "game-checkbox";
  const textWrap = document.createElement("div");
  const main = document.createElement("div");
  main.className = "game-main";
  main.textContent = label;
  const subEl = document.createElement("div");
  subEl.className = "game-sub";
  subEl.textContent = sub;
  textWrap.append(main, subEl);
  li.append(checkbox, textWrap);
  return { li, checkbox };
}

function formatTime12h(time, date) {
  const hour24 = to24Hour(time.hour, isSunday(date));
  const ampm = hour24 < 12 || hour24 === 24 ? "am" : "pm";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${pad2(time.minute)}${ampm}`;
}

function renderGames() {
  gameListEl.innerHTML = "";
  const teamNum = parseInt(teamSelect.value, 10);
  const myTeam = parsed.roster.find((r) => r.number === teamNum);
  if (!myTeam) return [];

  const rosterByNum = new Map(parsed.roster.map((r) => [r.number, r]));
  const myGames = parsed.games
    .filter((g) => g.team1 === teamNum || g.team2 === teamNum)
    .filter((g) => g.date && g.time)
    .sort((a, b) => a.week - b.week);

  const entries = [];

  for (const g of myGames) {
    const oppNum = g.team1 === teamNum ? g.team2 : g.team1;
    const opponent = rosterByNum.get(oppNum) || { teamName: `Team ${oppNum}` };
    const dateStr = `${g.date.month}/${g.date.day}/${g.date.year}`;
    const label = `Week ${g.week}: vs ${opponent.teamName}`;
    const sub = `${dateStr} · ${formatTime12h(g.time, g.date)} · ${g.court}`;
    const { li, checkbox } = renderGameRow(label, sub, true);
    gameListEl.appendChild(li);
    entries.push({ checkbox, buildEvent: () => buildEvent(g, myTeam, opponent, parsed.durationMinutes) });
  }

  addBtn.disabled = entries.length === 0;
  return entries;
}

async function loadCalendarList() {
  calendarSelect.innerHTML = "";
  const fallback = document.createElement("option");
  fallback.value = "primary";
  fallback.textContent = "Primary calendar";
  calendarSelect.appendChild(fallback);

  const response = await chrome.runtime.sendMessage({ type: "LIST_CALENDARS" });
  const calendars = response?.ok ? response.calendars : [];
  if (calendars.length === 0) return;

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
}

async function init() {
  parsed = await loadActivePdf();
  if (!parsed) return;

  if (parsed.roster.length === 0) {
    setStatus("Couldn't find a team roster in this PDF.", true);
    return;
  }

  setStatus("");
  appEl.hidden = false;

  teamSelect.innerHTML = "";
  for (const r of parsed.roster) {
    const opt = document.createElement("option");
    opt.value = r.number;
    opt.textContent = `${r.teamName} (${r.personName})`;
    teamSelect.appendChild(opt);
  }

  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const lastTeam = stored[STORAGE_KEY];
  if (lastTeam && parsed.roster.some((r) => r.number === lastTeam)) {
    teamSelect.value = String(lastTeam);
  }

  let entries = renderGames();
  loadCalendarList();

  teamSelect.addEventListener("change", () => {
    chrome.storage.local.set({ [STORAGE_KEY]: parseInt(teamSelect.value, 10) });
    entries = renderGames();
  });
  calendarSelect.addEventListener("change", () => {
    chrome.storage.local.set({ [CALENDAR_STORAGE_KEY]: calendarSelect.value });
  });
  selectAllEl.addEventListener("change", () => {
    for (const e of entries) e.checkbox.checked = selectAllEl.checked;
  });

  addBtn.addEventListener("click", async () => {
    const chosen = entries.filter((e) => e.checkbox.checked).map((e) => e.buildEvent());
    if (chosen.length === 0) return;
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
    addBtn.disabled = false;
    addBtn.textContent = "Add to Google Calendar";
  });
}

init();
