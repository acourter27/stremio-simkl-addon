# stremio-simkl-addon

A Stremio addon that automatically syncs your watch history to [Simkl](https://simkl.com) whenever you play a movie or episode in Stremio.

## How it works

Stremio fetches subtitles from addons immediately before playback starts. This addon registers as a (no-op) subtitle provider and uses each incoming subtitle request as a "play" signal. The movie or episode is then instantly posted to Simkl's `/sync/history` API, marking it as watched on your profile.

```
Stremio plays content
    └─► GET /<token>/subtitles/<type>/<id>.json
            ├─► responds { subtitles: [] }   (no-op, zero latency impact)
            └─► POST api.simkl.com/sync/history  (background, fire-and-forget)
```

## Setup

### 1 – Prerequisites

| Requirement | Notes |
|---|---|
| A Simkl account | Free at simkl.com |
| A Simkl OAuth app | Create at <https://simkl.com/settings/developer/> |
| Docker + Docker Compose | For the Docker path |
| Node.js ≥ 18 | For the bare-metal path only |

Set the **Redirect URI** in your Simkl app to `<BASE_URL>/auth/callback`.

### 2 – Configure credentials

```sh
cp .env.example .env
# Fill in SIMKL_CLIENT_ID, SIMKL_CLIENT_SECRET, BASE_URL
```

### 3a – Run with Docker (recommended)

```sh
docker compose up -d
```

Token data is stored in the `addon-data` Docker volume and survives container
restarts and image rebuilds.

### 3b – Run without Docker

```sh
npm install
npm start
# → listening on http://localhost:7000
```

### 4 – Install the addon

1. Open `http://localhost:7000/configure` in your browser.
2. Click **Connect to Simkl** and complete the OAuth flow.
3. Copy the personal manifest URL and install it in Stremio
   (Settings → Addons → paste the URL).

Each user gets a unique install URL containing an opaque 40-char hex token.
Your actual Simkl credentials are stored only on the server side.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `SIMKL_CLIENT_ID` | – | Simkl OAuth app client ID |
| `SIMKL_CLIENT_SECRET` | – | Simkl OAuth app client secret |
| `BASE_URL` | `http://localhost:7000` | Public URL of this server (no trailing slash) |
| `PORT` | `7000` | Port to listen on |
| `DATA_DIR` | app root | Directory where `tokens.json` is written (set to `/data` inside Docker) |

## File structure

```
├── Dockerfile
├── docker-compose.yml
├── index.js          Main Express server (OAuth routes + Stremio addon routes)
├── simkl.js          Simkl API client (OAuth, sync/history)
├── db.js             JSON-file token store (addon token → Simkl access token)
├── public/
│   └── configure.html  Setup UI
└── .env.example      Environment variable template
```

## Supported content

| Type | ID format received from Stremio | Synced to Simkl as |
|---|---|---|
| Movie | `tt1234567` | Movie via IMDB ID |
| Series episode | `tt1234567:1:2` (imdb:season:ep) | Episode via show IMDB ID + season + episode number |

Only IMDB-prefixed IDs (`tt…`) are processed; others are silently ignored.

## License

MIT
