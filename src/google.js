'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { HOME_DIR, ensureDirs } = require('./config');

const CLIENT_PATH = path.join(HOME_DIR, 'google-client.json');
const TOKEN_PATH = path.join(HOME_DIR, 'google-auth.json');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

/**
 * Deliberately minimal:
 *   gmail.metadata          headers only - subjects and senders, never bodies
 *                           or attachments, and no ability to send anything
 *   calendar.events.readonly read-only view of events
 */
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.metadata',
  'https://www.googleapis.com/auth/calendar.events.readonly'
];

// ---------------------------------------------------------------- credentials

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Restricts a file to the current user only - it holds an access token. */
function lockDown(file) {
  const user = process.env.USERNAME;
  if (!user) return;
  execFile('icacls', [file, '/inheritance:r', '/grant:r', `${user}:F`], { windowsHide: true }, () => {});
}

function writeSecret(file, data) {
  ensureDirs();
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  lockDown(file);
}

function loadClient() {
  const stored = readJson(CLIENT_PATH);
  if (stored && stored.clientId && stored.clientSecret) return stored;
  return null;
}

/**
 * Accepts either the raw client id/secret or the client_secret_*.json file
 * downloaded from the Google Cloud console.
 */
function saveClient({ clientId, clientSecret, fromFile }) {
  if (fromFile) {
    const parsed = readJson(fromFile);
    const node = parsed && (parsed.installed || parsed.web);
    if (!node || !node.client_id) {
      throw new Error(`${fromFile} does not look like a Google OAuth client JSON file.`);
    }
    clientId = node.client_id;
    clientSecret = node.client_secret;
  }
  if (!clientId || !clientSecret) throw new Error('Both a client ID and a client secret are required.');
  if (!/\.apps\.googleusercontent\.com$/.test(clientId.trim())) {
    throw new Error('That client ID does not look right - it should end in .apps.googleusercontent.com');
  }
  writeSecret(CLIENT_PATH, { clientId: clientId.trim(), clientSecret: clientSecret.trim() });
  return CLIENT_PATH;
}

function loadTokens() {
  return readJson(TOKEN_PATH);
}

function isConnected() {
  const tokens = loadTokens();
  return Boolean(tokens && tokens.refreshToken);
}

function connectionInfo() {
  const tokens = loadTokens();
  if (!tokens) return { connected: false, hasClient: Boolean(loadClient()) };
  return {
    connected: Boolean(tokens.refreshToken),
    hasClient: Boolean(loadClient()),
    account: tokens.account || null,
    connectedAt: tokens.connectedAt || null,
    scopes: tokens.scopes || []
  };
}

// ------------------------------------------------------------------ oauth flow

function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function openBrowser(url) {
  // rundll32 takes the URL as a single argument, so nothing re-parses the
  // query string the way cmd.exe would.
  execFile('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true }, () => {});
}

async function postForm(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString()
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error_description || body.error || `HTTP ${res.status}`);
  }
  return body;
}

const DONE_PAGE = (title, message) => `<!doctype html><meta charset="utf-8">
<title>${title}</title>
<body style="font:16px/1.6 system-ui;background:#0A0E1A;color:#E4EAF6;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center;max-width:32rem;padding:2rem">
<div style="width:56px;height:4px;background:#4C8DFF;margin:0 auto 1.5rem"></div>
<h1 style="font-size:1.4rem;margin:0 0 .5rem">${title}</h1>
<p style="color:#7E8CA8;margin:0">${message}</p></div>`;

/**
 * Runs the loopback OAuth flow: starts a local listener, opens the consent
 * screen in the browser, and waits for Google to redirect back with a code.
 * The user signs in themselves; nothing here ever sees their password.
 */
function authorize({ timeoutMs = 300000, onUrl } = {}) {
  const client = loadClient();
  if (!client) {
    throw new Error('No OAuth client saved yet. Run: ai-news-wallpaper connect google --credentials <client_secret.json>');
  }

  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  const state = base64url(crypto.randomBytes(16));

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      err ? reject(err) : resolve(value);
    };

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/') {
        res.writeHead(404).end();
        return;
      }

      const send = (code, html) => res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' }).end(html);

      if (url.searchParams.get('error')) {
        send(400, DONE_PAGE('Authorisation cancelled', 'You can close this tab and try again.'));
        return finish(new Error(`Google returned: ${url.searchParams.get('error')}`));
      }
      if (url.searchParams.get('state') !== state) {
        send(400, DONE_PAGE('Something went wrong', 'The state token did not match. Please start again.'));
        return finish(new Error('OAuth state mismatch - the callback did not come from the request we started.'));
      }

      const code = url.searchParams.get('code');
      if (!code) {
        send(400, DONE_PAGE('Something went wrong', 'No authorisation code was returned.'));
        return finish(new Error('No authorisation code in the callback.'));
      }

      try {
        const tokens = await postForm(TOKEN_URL, {
          code,
          client_id: client.clientId,
          client_secret: client.clientSecret,
          redirect_uri: `http://127.0.0.1:${server.address().port}`,
          grant_type: 'authorization_code',
          code_verifier: verifier
        });
        if (!tokens.refresh_token) {
          throw new Error('Google did not return a refresh token. Remove the app at https://myaccount.google.com/permissions and connect again.');
        }
        const saved = {
          refreshToken: tokens.refresh_token,
          accessToken: tokens.access_token,
          expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000,
          scopes: (tokens.scope || '').split(' ').filter(Boolean),
          connectedAt: Date.now()
        };
        writeSecret(TOKEN_PATH, saved);
        send(200, DONE_PAGE('Connected', 'ai-news-wallpaper is linked to your Google account. You can close this tab.'));
        finish(null, saved);
      } catch (err) {
        send(500, DONE_PAGE('Could not complete sign-in', String(err.message)));
        finish(err);
      }
    });

    const timer = setTimeout(() => finish(new Error('Timed out waiting for Google sign-in.')), timeoutMs);

    server.on('error', (err) => finish(err));
    server.listen(0, '127.0.0.1', () => {
      const params = new URLSearchParams({
        client_id: client.clientId,
        redirect_uri: `http://127.0.0.1:${server.address().port}`,
        response_type: 'code',
        scope: SCOPES.join(' '),
        access_type: 'offline',
        prompt: 'consent',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state
      });
      const url = `${AUTH_URL}?${params}`;
      if (onUrl) onUrl(url);
      openBrowser(url);
    });
  });
}

async function disconnect() {
  const tokens = loadTokens();
  if (tokens && tokens.refreshToken) {
    try {
      await postForm(REVOKE_URL, { token: tokens.refreshToken });
    } catch { /* already revoked or offline - still remove the local copy */ }
  }
  for (const file of [TOKEN_PATH]) {
    try { fs.unlinkSync(file); } catch { /* nothing to remove */ }
  }
  return true;
}

// --------------------------------------------------------------- api requests

let inFlightRefresh = null;

async function accessToken() {
  const tokens = loadTokens();
  if (!tokens || !tokens.refreshToken) throw new Error('Google account is not connected.');
  if (tokens.accessToken && tokens.expiresAt > Date.now() + 60000) return tokens.accessToken;

  if (!inFlightRefresh) {
    const client = loadClient();
    if (!client) throw new Error('OAuth client credentials are missing.');
    inFlightRefresh = postForm(TOKEN_URL, {
      client_id: client.clientId,
      client_secret: client.clientSecret,
      refresh_token: tokens.refreshToken,
      grant_type: 'refresh_token'
    }).then((fresh) => {
      const next = {
        ...tokens,
        accessToken: fresh.access_token,
        expiresAt: Date.now() + (fresh.expires_in || 3600) * 1000
      };
      writeSecret(TOKEN_PATH, next);
      return next.accessToken;
    }).finally(() => { inFlightRefresh = null; });
  }
  return inFlightRefresh;
}

async function apiGet(url) {
  const token = await accessToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: controller.signal
    });
    if (res.status === 401) throw new Error('Google rejected the token - reconnect with: ai-news-wallpaper connect google');
    if (res.status === 403) {
      const body = await res.json().catch(() => ({}));
      const reason = body.error && body.error.message ? body.error.message : 'permission denied';
      throw new Error(`Google API: ${reason}`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ----------------------------------------------------------------------- gmail

function headerValue(headers, name) {
  const found = (headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase());
  return found ? found.value : '';
}

/** "Priya Raman <priya@x.com>" -> "Priya Raman"; bare addresses keep the local part. */
function displayName(from) {
  const named = from.match(/^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/);
  if (named) return named[1].trim();
  const bare = from.match(/([^@\s<>]+)@/);
  return bare ? bare[1] : from.trim();
}

function shortTime(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const sameDay = new Date().toDateString() === date.toDateString();
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/**
 * Top unread inbox mail, most important first. Uses metadata format only, so
 * message bodies are never requested or received.
 */
async function fetchMail(limit = 4) {
  const list = await apiGet(`${GMAIL_API}/messages?labelIds=INBOX&labelIds=UNREAD&maxResults=${Math.max(limit * 3, 12)}`);
  const ids = (list.messages || []).map((m) => m.id);
  if (ids.length === 0) return { messages: [], unread: 0 };

  const headers = 'metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date';
  const detailed = await Promise.all(ids.map((id) =>
    apiGet(`${GMAIL_API}/messages/${id}?format=metadata&${headers}`).catch(() => null)
  ));

  const messages = detailed.filter(Boolean).map((msg) => {
    const labels = msg.labelIds || [];
    return {
      from: displayName(headerValue(msg.payload && msg.payload.headers, 'From')),
      subject: headerValue(msg.payload && msg.payload.headers, 'Subject') || '(no subject)',
      important: labels.includes('IMPORTANT'),
      starred: labels.includes('STARRED'),
      receivedAt: msg.internalDate ? Number(msg.internalDate) : null
    };
  });

  messages.sort((a, b) => {
    const rank = (m) => (m.starred ? 2 : 0) + (m.important ? 1 : 0);
    return rank(b) - rank(a) || (b.receivedAt || 0) - (a.receivedAt || 0);
  });

  return { messages: messages.slice(0, limit), unread: (list.resultSizeEstimate || ids.length) };
}

// -------------------------------------------------------------------- calendar

function eventTime(event) {
  const start = event.start || {};
  if (start.date) return { allDay: true, at: Date.parse(`${start.date}T00:00:00`) };
  return { allDay: false, at: start.dateTime ? Date.parse(start.dateTime) : null };
}

function durationLabel(event) {
  const start = event.start && event.start.dateTime ? Date.parse(event.start.dateTime) : null;
  const end = event.end && event.end.dateTime ? Date.parse(event.end.dateTime) : null;
  if (!start || !end) return '';
  const minutes = Math.round((end - start) / 60000);
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  return `${hours % 1 === 0 ? hours : hours.toFixed(1)} hr`;
}

/** Today's remaining events on the primary calendar. */
async function fetchAgenda(limit = 4) {
  const now = new Date();
  const endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 59, 999);

  const params = new URLSearchParams({
    timeMin: new Date(now.getTime() - 15 * 60000).toISOString(),
    timeMax: endOfDay.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: String(Math.max(limit * 2, 10))
  });

  const data = await apiGet(`${CALENDAR_API}/calendars/primary/events?${params}`);
  const events = (data.items || [])
    .filter((event) => event.status !== 'cancelled')
    .map((event) => {
      const when = eventTime(event);
      const guests = (event.attendees || []).filter((a) => !a.resource).length;
      return {
        title: event.summary || '(no title)',
        location: (event.location || '').split(',')[0].trim(),
        allDay: when.allDay,
        startsAt: when.at,
        duration: durationLabel(event),
        guests,
        accepted: !(event.attendees || []).some((a) => a.self && a.responseStatus === 'declined')
      };
    })
    .filter((event) => event.accepted);

  return { events: events.slice(0, limit), total: events.length };
}

/**
 * Everything the wallpaper needs from Google, with per-source failure so one
 * broken API never blocks the other or the rest of the render.
 */
async function fetchBrief({ mailCount = 4, eventCount = 4, includeMail = true, includeCalendar = true } = {}) {
  if (!isConnected()) return { connected: false, mail: null, agenda: null, errors: [] };

  const errors = [];
  const [mail, agenda] = await Promise.all([
    includeMail ? fetchMail(mailCount).catch((err) => { errors.push(`gmail: ${err.message}`); return null; }) : null,
    includeCalendar ? fetchAgenda(eventCount).catch((err) => { errors.push(`calendar: ${err.message}`); return null; }) : null
  ]);

  return { connected: true, mail, agenda, errors, account: (loadTokens() || {}).account || null };
}

module.exports = {
  SCOPES,
  CLIENT_PATH,
  TOKEN_PATH,
  saveClient,
  loadClient,
  authorize,
  disconnect,
  isConnected,
  connectionInfo,
  fetchMail,
  fetchAgenda,
  fetchBrief,
  shortTime
};
