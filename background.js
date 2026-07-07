// Service worker: owns the Google OAuth token and talks to the Calendar API.
// Runs independently of the popup so the interactive sign-in window (which
// would otherwise steal focus and close the popup) doesn't abort the flow.
//
// Uses chrome.identity.launchWebAuthFlow with a "Web application" OAuth
// client rather than chrome.identity.getAuthToken, since getAuthToken
// requires a "Chrome Extension"-type client that Google has been phasing out
// for newer Cloud projects. launchWebAuthFlow works with a standard Web
// application client and a fixed https://<extension-id>.chromiumapp.org/
// redirect URI (see chrome.identity.getRedirectURL()).

const OAUTH_CLIENT_ID = "645680448424-4fjqf7g628l81nlg9uf6ligku19afa5d.apps.googleusercontent.com";
const OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
];

const CALENDAR_LIST_URL =
  "https://www.googleapis.com/calendar/v3/users/me/calendarList";

function eventsUrlFor(calendarId) {
  return `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
    calendarId
  )}/events`;
}

// In-memory cache, mirrored to chrome.storage.session so the token survives
// the service worker being suspended (MV3 workers unload after ~30s idle,
// which otherwise made auth appear to "reset" between popup opens).
let cachedToken = null; // { token, expiresAt }

async function loadCachedToken() {
  if (cachedToken) return cachedToken;
  const { authToken } = await chrome.storage.session.get("authToken");
  if (authToken) cachedToken = authToken;
  return cachedToken;
}

async function saveCachedToken(token) {
  cachedToken = token;
  await chrome.storage.session.set({ authToken: token });
}

async function clearCachedToken() {
  cachedToken = null;
  await chrome.storage.session.remove("authToken");
}

function buildAuthUrl(interactive) {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", OAUTH_CLIENT_ID);
  url.searchParams.set("response_type", "token");
  url.searchParams.set("redirect_uri", chrome.identity.getRedirectURL());
  url.searchParams.set("scope", OAUTH_SCOPES.join(" "));
  url.searchParams.set("prompt", interactive ? "consent" : "none");
  return url.toString();
}

async function launchGoogleAuth(interactive) {
  const resultUrl = await chrome.identity.launchWebAuthFlow({
    url: buildAuthUrl(interactive),
    interactive,
  });
  if (!resultUrl) throw new Error("No response from Google sign-in");

  const params = new URLSearchParams(new URL(resultUrl).hash.slice(1));
  const token = params.get("access_token");
  if (!token) throw new Error(params.get("error") || "Sign-in failed");

  const expiresIn = parseInt(params.get("expires_in") || "3600", 10);
  return { token, expiresAt: Date.now() + expiresIn * 1000 };
}

async function getAuthToken(interactive) {
  const existing = await loadCachedToken();
  if (existing && existing.expiresAt - 30_000 > Date.now()) {
    return existing.token;
  }
  try {
    await saveCachedToken(await launchGoogleAuth(false)); // try a silent refresh first
  } catch {
    if (!interactive) throw new Error("Not signed in");
    await saveCachedToken(await launchGoogleAuth(true));
  }
  return cachedToken.token;
}

// Looks for any event on the same calendar day with the exact same title.
// Google's "q" search is fuzzy/substring, so we widen the window to the
// whole day and then compare titles ourselves for an exact match.
async function findExistingEventByName(token, calendarId, event) {
  const dayStart = new Date(event.start.dateTime);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);

  const url = new URL(eventsUrlFor(calendarId));
  url.searchParams.set("timeMin", dayStart.toISOString());
  url.searchParams.set("timeMax", dayEnd.toISOString());
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("maxResults", "50");

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Calendar API ${res.status}: ${body}`);
  }
  const data = await res.json();
  return (data.items || []).some((item) => item.summary === event.summary);
}

async function createCalendarEvent(token, calendarId, event) {
  const res = await fetch(eventsUrlFor(calendarId), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(event),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Calendar API ${res.status}: ${body}`);
  }
  return res.json();
}

// Returns { ok: true, skipped: true } if an event with the exact same title
// already exists on the same day, so re-running "Add to Google Calendar"
// doesn't create duplicates.
async function addOneEvent(token, calendarId, event) {
  if (await findExistingEventByName(token, calendarId, event)) {
    return { ok: true, skipped: true };
  }
  await createCalendarEvent(token, calendarId, event);
  return { ok: true };
}

async function addEventsToCalendar(calendarId, events) {
  let token;
  try {
    token = await getAuthToken(true);
  } catch (e) {
    return {
      results: events.map(() => ({ ok: false, error: `Sign-in failed: ${e.message}` })),
    };
  }

  const results = [];
  for (const event of events) {
    try {
      results.push(await addOneEvent(token, calendarId, event));
    } catch (e) {
      // A stale token returns 401; drop it and retry once with a fresh
      // interactive sign-in.
      if (String(e.message).includes("401")) {
        try {
          await clearCachedToken();
          token = await getAuthToken(true);
          results.push(await addOneEvent(token, calendarId, event));
          continue;
        } catch (e2) {
          results.push({ ok: false, error: e2.message });
          continue;
        }
      }
      results.push({ ok: false, error: e.message });
    }
  }
  return { results };
}

async function listCalendars(interactive) {
  const token = await getAuthToken(interactive);
  const url = new URL(CALENDAR_LIST_URL);
  url.searchParams.set("minAccessRole", "writer");
  url.searchParams.set("fields", "items(id,summary,primary)");
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Calendar API ${res.status}: ${body}`);
  }
  const data = await res.json();
  const calendars = (data.items || []).map((c) => ({
    id: c.id,
    summary: c.summary,
    primary: !!c.primary,
  }));
  calendars.sort((a, b) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0));
  return calendars;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "ADD_EVENTS") {
    addEventsToCalendar(message.calendarId, message.events).then(sendResponse);
    return true; // keep the message channel open for the async response
  }
  if (message?.type === "LIST_CALENDARS") {
    listCalendars(!!message.interactive)
      .then((calendars) => sendResponse({ ok: true, calendars }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  return false;
});
