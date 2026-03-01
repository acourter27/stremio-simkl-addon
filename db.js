/**
 * Simple JSON-file token store.
 *
 * Maps a random addon token (embedded in the user's install URL) to their
 * Simkl OAuth access token so the real credential never travels in the URL.
 *
 * Schema of tokens.json:
 * {
 *   "<addonToken>": {
 *     "simklAccessToken": "...",
 *     "simklUser": "...",      // username / email, informational only
 *     "createdAt": "ISO-8601"
 *   }
 * }
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_FILE = path.join(process.env.DATA_DIR || __dirname, 'tokens.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function save(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

/**
 * Persist a new Simkl access token and return the opaque addon token that
 * identifies this user's installation URL.
 */
function createToken(simklAccessToken, simklUser = '') {
  const db = load();
  const addonToken = crypto.randomBytes(20).toString('hex');
  db[addonToken] = {
    simklAccessToken,
    simklUser,
    createdAt: new Date().toISOString(),
  };
  save(db);
  return addonToken;
}

/**
 * Look up a stored record by addon token. Returns null if not found.
 */
function getRecord(addonToken) {
  return load()[addonToken] ?? null;
}

module.exports = { createToken, getRecord };
