/**
 * Simkl API client.
 *
 * Covers:
 *   - OAuth 2.0 authorization URL generation
 *   - Authorization-code → access-token exchange
 *   - User info lookup
 *   - Syncing movies and episodes to watch history
 *
 * All API calls attach `simkl-api-key` (= client ID) as required by Simkl.
 * Reference: https://simkl.docs.apiary.io/
 */

const API_BASE = 'https://api.simkl.com';
const OAUTH_BASE = 'https://simkl.com/oauth';

function clientId() {
  return process.env.SIMKL_CLIENT_ID;
}

function clientSecret() {
  return process.env.SIMKL_CLIENT_SECRET;
}

function redirectUri(baseUrl) {
  return `${baseUrl}/auth/callback`;
}

/** Build the Simkl OAuth authorize URL. */
function getAuthorizationUrl(baseUrl, state) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId(),
    redirect_uri: redirectUri(baseUrl),
    state,
  });
  return `${OAUTH_BASE}/authorize?${params}`;
}

/** Exchange an authorization code for an access token. */
async function exchangeCode(baseUrl, code) {
  const res = await fetch(`${API_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      client_id: clientId(),
      client_secret: clientSecret(),
      redirect_uri: redirectUri(baseUrl),
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Simkl token exchange failed (${res.status}): ${text}`);
  }
  return res.json();
}

/** Fetch basic account info for the authenticated user. */
async function getUserInfo(accessToken) {
  const res = await fetch(`${API_BASE}/users/settings`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'simkl-api-key': clientId(),
    },
  });
  if (!res.ok) return null;
  return res.json();
}

/**
 * Common helper: POST to /sync/history with Bearer auth.
 * Returns true on success, false on failure (non-throwing so callers decide
 * how to handle errors).
 */
async function postHistory(accessToken, body) {
  const res = await fetch(`${API_BASE}/sync/history`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'simkl-api-key': clientId(),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Simkl sync/history failed (${res.status}): ${text}`);
  }
  return true;
}

/**
 * Mark a movie as watched.
 * @param {string} accessToken - Simkl OAuth access token
 * @param {string} imdbId      - IMDB ID, e.g. "tt0000000"
 */
async function syncMovie(accessToken, imdbId) {
  return postHistory(accessToken, {
    movies: [
      {
        ids: { imdb: imdbId },
        watched_at: new Date().toISOString(),
      },
    ],
  });
}

/**
 * Mark a single TV episode as watched.
 * @param {string} accessToken  - Simkl OAuth access token
 * @param {string} imdbId       - Show IMDB ID, e.g. "tt0000000"
 * @param {number|string} season
 * @param {number|string} episode
 */
async function syncEpisode(accessToken, imdbId, season, episode) {
  return postHistory(accessToken, {
    shows: [
      {
        ids: { imdb: imdbId },
        seasons: [
          {
            number: Number(season),
            episodes: [
              {
                number: Number(episode),
                watched_at: new Date().toISOString(),
              },
            ],
          },
        ],
      },
    ],
  });
}

module.exports = {
  getAuthorizationUrl,
  exchangeCode,
  getUserInfo,
  syncMovie,
  syncEpisode,
};
