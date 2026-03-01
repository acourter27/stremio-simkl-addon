/**
 * Stremio → Simkl Sync Addon
 * ==========================
 * A Stremio addon that scrobbles watch events to Simkl.
 *
 * How it works
 * ------------
 * Stremio fetches subtitles before playback begins. This addon registers as a
 * subtitle provider (returning an empty list) and uses each incoming subtitle
 * request as a signal that the user has started watching something. The
 * content is then immediately marked as watched on Simkl via the sync/history
 * API.
 *
 * User flow
 * ---------
 * 1. User visits /configure and clicks "Connect to Simkl".
 * 2. Simkl OAuth2 runs; the user is redirected back with a code.
 * 3. We exchange the code for an access token and store it locally, handing
 *    the user an opaque 40-char hex token as their install URL segment.
 * 4. The user installs the personalised URL in Stremio:
 *      <BASE_URL>/<addonToken>/manifest.json
 * 5. From now on, every play event in Stremio triggers a Simkl history sync.
 *
 * Environment variables (see .env.example)
 * -----------------------------------------
 * SIMKL_CLIENT_ID, SIMKL_CLIENT_SECRET, BASE_URL, PORT
 */

'use strict';

// Load .env if present (optional – production deployments inject vars directly)
try {
  require('fs').accessSync('.env');
  const lines = require('fs').readFileSync('.env', 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
} catch {
  // No .env file – that's fine
}

const express = require('express');
const crypto = require('crypto');
const path = require('path');

const simkl = require('./simkl');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 7000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

// ─── Stremio addon manifest ───────────────────────────────────────────────────

const MANIFEST = {
  id: 'community.stremio-simkl-sync',
  version: '1.0.3',
  name: 'Simkl Sync',
  description:
    'Automatically marks movies and episodes as watched on Simkl when you play them in Stremio.',
  logo: 'https://simkl.in/img/simkl/facebook-logo.png',
  // We register as both a subtitle and streams provider. Stremio fetches
  // streams before handing off to any external player (e.g. Infuse), so the
  // streams hook fires even when Stremio's own player never starts. The
  // subtitle hook remains as the signal for Stremio's internal player. Both
  // return empty responses so they cause no UX disruption.
  resources: ['subtitles', 'streams'],
  types: ['movie', 'series'],
  // Only engage for IMDB-prefixed IDs (tt…)
  idPrefixes: ['tt'],
  catalogs: [],
  behaviorHints: {
    configurable: true,
    configurationRequired: false,
  },
};

// ─── Middleware ───────────────────────────────────────────────────────────────

// CORS is required so Stremio's web app can reach the addon
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Configure / landing page ─────────────────────────────────────────────────

app.get('/', (req, res) => res.redirect('/configure'));

app.get('/configure', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'configure.html'));
});

// ─── OAuth 2.0 flow ───────────────────────────────────────────────────────────

// Short-lived in-memory state → timestamp map, guards against CSRF
const pendingStates = new Map();

function pruneStates() {
  const cutoff = Date.now() - 10 * 60 * 1000; // 10-minute window
  for (const [state, ts] of pendingStates) {
    if (ts < cutoff) pendingStates.delete(state);
  }
}

/** Step 1 – redirect the browser to Simkl's OAuth consent screen. */
app.get('/auth/login', (req, res) => {
  if (!process.env.SIMKL_CLIENT_ID || !process.env.SIMKL_CLIENT_SECRET) {
    return res
      .status(500)
      .send(
        'Server not configured. Set SIMKL_CLIENT_ID and SIMKL_CLIENT_SECRET environment variables.',
      );
  }

  pruneStates();
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, Date.now());

  res.redirect(simkl.getAuthorizationUrl(BASE_URL, state));
});

/** Step 2 – Simkl redirects back here with ?code=…&state=… */
app.get('/auth/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.redirect(`/configure?error=${encodeURIComponent(error)}`);
  }

  if (!state || !pendingStates.has(state)) {
    return res.status(400).send('Invalid or expired OAuth state. Please try again from /configure.');
  }
  pendingStates.delete(state);

  if (!code) {
    return res.status(400).send('No authorization code received from Simkl.');
  }

  try {
    const tokenData = await simkl.exchangeCode(BASE_URL, code);
    const userInfo = await simkl.getUserInfo(tokenData.access_token);
    const simklUser =
      userInfo?.account?.email || userInfo?.account?.name || 'unknown';

    const addonToken = db.createToken(tokenData.access_token, simklUser);
    const manifestUrl = `${BASE_URL}/${addonToken}/manifest.json`;

    res.redirect(
      `/configure?success=1&manifest=${encodeURIComponent(manifestUrl)}&user=${encodeURIComponent(simklUser)}`,
    );
  } catch (err) {
    console.error('[auth/callback]', err.message);
    res.redirect('/configure?error=auth_failed');
  }
});

// ─── Stremio addon routes (per-user, keyed by addonToken) ────────────────────

const addonRouter = express.Router({ mergeParams: true });

/** Configure – Stremio links here when the user clicks "Configure" on an installed addon. */
addonRouter.get('/configure', (req, res) => {
  const record = db.getRecord(req.params.token);
  if (!record) return res.redirect('/configure');

  const manifestUrl = `${BASE_URL}/${req.params.token}/manifest.json`;
  res.redirect(
    `/configure?success=1&manifest=${encodeURIComponent(manifestUrl)}&user=${encodeURIComponent(record.simklUser)}`,
  );
});

/** Manifest – identical for every user; token is only in the URL path. */
addonRouter.get('/manifest.json', (req, res) => {
  // Validate that the token exists so unknown tokens get an early 404
  const record = db.getRecord(req.params.token);
  if (!record) return res.status(404).json({ error: 'Unknown addon token.' });
  res.json(MANIFEST);
});

/**
 * Subtitles handler.
 *
 * Stremio calls:
 *   GET /:token/subtitles/:type/:id/:extra?.json
 *
 * For movies  – type=movie,  id=tt1234567
 * For series  – type=series, id=tt1234567:1:2  (imdbId:season:episode)
 *
 * We respond immediately with an empty list, then sync to Simkl in the
 * background so playback is never delayed by network latency.
 */
addonRouter.get('/subtitles/:type/:id/:extra?.json', (req, res) => {
  console.log(`[subtitles] ${req.params.type} ${req.params.id}`);
  res.json({ subtitles: [] });

  syncToSimkl(req.params).catch((err) =>
    console.error('[sync error]', err.message),
  );
});

/**
 * Streams handler.
 *
 * Stremio calls this endpoint right when the user initiates playback,
 * regardless of whether Stremio's internal player or an external player
 * (e.g. Infuse) will handle the stream. By registering here we capture
 * play events that would otherwise be invisible to the subtitle hook when
 * an external player is in use.
 *
 * We return an empty list so we never interfere with other stream addons.
 */
addonRouter.get('/stream/:type/:id/:extra?.json', (req, res) => {
  console.log(`[stream] ${req.params.type} ${req.params.id}`);
  res.json({ streams: [] });

  syncToSimkl(req.params).catch((err) =>
    console.error('[sync error]', err.message),
  );
});

app.use('/:token', addonRouter);

// ─── Sync logic ───────────────────────────────────────────────────────────────

// Deduplication: when using Stremio's internal player, both the streams
// endpoint and the subtitle endpoint fire for the same piece of content within
// seconds of each other. Track recent scrobbles so the second call is ignored.
const recentScrobbles = new Map();
const DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

function isDuplicate(token, type, id) {
  const key = `${token}:${type}:${id}`;
  const last = recentScrobbles.get(key);
  if (last && Date.now() - last < DEDUP_WINDOW_MS) return true;
  recentScrobbles.set(key, Date.now());
  return false;
}

async function syncToSimkl({ token, type, id }) {
  if (isDuplicate(token, type, id)) {
    console.log(`[sync] Skipping duplicate scrobble for ${type} ${id}`);
    return;
  }

  const record = db.getRecord(token);
  if (!record) {
    console.warn(`[sync] Unknown token: ${token}`);
    return;
  }

  const { simklAccessToken, simklUser } = record;

  if (type === 'movie') {
    // id = "tt1234567"
    if (!id.startsWith('tt')) return;
    await simkl.syncMovie(simklAccessToken, id);
    console.log(`[sync] movie ${id} → Simkl (user: ${simklUser})`);
  } else if (type === 'series') {
    // id = "tt1234567:1:2"  (imdbId:season:episode)
    const parts = id.split(':');
    if (parts.length < 3 || !parts[0].startsWith('tt')) return;
    const [imdbId, season, episode] = parts;
    await simkl.syncEpisode(simklAccessToken, imdbId, season, episode);
    console.log(
      `[sync] series ${imdbId} S${season}E${episode} → Simkl (user: ${simklUser})`,
    );
  }
}

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Stremio-Simkl addon listening on port ${PORT}`);
  console.log(`Configure at: ${BASE_URL}/configure`);
  if (!process.env.SIMKL_CLIENT_ID) {
    console.warn(
      'WARNING: SIMKL_CLIENT_ID is not set. Copy .env.example → .env and fill in credentials.',
    );
  }
});
