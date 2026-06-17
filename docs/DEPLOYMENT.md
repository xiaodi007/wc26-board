# Demo Deployment Runbook

Last verified: 2026-06-17

This document records the current demo deployment so a future session can catch
up without rediscovering the server layout. Do not write VPS passwords, API
keys, private keys, `.env` contents, SQLite dumps, or logs into this file.

## Current Topology

- VPS: `ubuntu@43.135.135.137`
- Remote app path: `/home/ubuntu/apps/wc26-board`
- Public demo URL: `https://crossing-tide-extra-explicit.trycloudflare.com`
- Internal board port: `127.0.0.1:4626`
- Internal proxy port: `127.0.0.1:4627`
- Runtime: Docker Compose on Ubuntu 22.04
- Swap: a 2 GB `/swapfile` was added for safer Docker builds/runtime

The public URL is a Cloudflare quick tunnel. It is fine for demos, but it is not
stable production infrastructure: if the tunnel container is recreated, the URL
can change.

High ports such as `4627` timed out from the public internet because the cloud
security group did not expose them. The OS firewall was not the blocker. The
quick tunnel is the current workaround.

## Latest Deployment

- Latest app rebuild/restart: 2026-06-17 17:13 CST (09:13 UTC)
- Deployed change: fix review scores disappearing on fixture-key drift
  (`syncFixtureKey` now moves `match_result`/`match_event` with the canonical
  key; a startup self-heal re-points rows orphaned before the fix; `busy_timeout`
  added for the shared daemon/board SQLite connection — see commit
  `Fix review scores lost to fixture-key drift`). Also rotated `ODDS_API_KEY`:
  the previous key began returning `HTTP 401` around 2026-06-14 (free-tier quota
  exhausted), so no scores were collected for ~3 days and the review board showed
  completed matches with no result.
- Public demo URL unchanged (proxy/tunnel containers were left untouched):
  `https://crossing-tide-extra-explicit.trycloudflare.com`.
- Deploy method: `rsync` of `src` (runbook excludes), `sed` the remote `.env`
  `ODDS_API_KEY` line (a timestamped `.env.bak.*` was left on the VPS),
  `docker compose build` (npm ci layer cached), then
  `docker compose up -d daemon board` only.
- Verification: daemon recreated and logged `oddsapi: 52 events ... snapshots`
  with no `401`. `docker compose exec -T board npm run results` upserted
  `12/64` completed results (the matches missing since 2026-06-14; Sporttery
  fallback still returned remote `HTTP 567 Unknown Status`).
  `docker compose exec -T board npm run health` returned `9 pass, 1 warn,
  0 fail` — the warn remains Sporttery freshness; Odds API/PM/Kalshi fresh.
- Internal proxy (`:4627`) and the public tunnel both returned HTTP 200 for
  `/review?lang=zh` with 19 `rv-card-score has-score` cards (was 7 before the
  key rotation).
- Residual gap: `australia|turkey|2026-06-14T04:00:00Z` (and a stale
  `haiti|scotland` LIVE row) fall between the old key's death and the new key's
  `daysFrom=3` scores window, so they cannot be backfilled from The Odds API.

The previous Walrus testnet compact publish from 2026-06-13 13:34 CST remains
the latest recorded Walrus publish unless a new publish is run manually.

The first request after a container recreate can be slower due to cold startup
and SQLite cache warming. The Cloudflare quick tunnel still adds noticeable
latency compared with the internal board port.

## Remote Services

The remote Compose stack has four services:

| service | purpose |
| --- | --- |
| `daemon` | runs `npm run daemon` and continuously collects market data |
| `board` | runs `npm run board`; binds the app to `127.0.0.1:4626` |
| `board-proxy` | Caddy reverse proxy from `:4627` to `127.0.0.1:4626` |
| `board-tunnel` | Cloudflare quick tunnel to `http://127.0.0.1:4627` |

The generated runtime files live on the VPS, not in the repository:

- `/home/ubuntu/apps/wc26-board/Dockerfile`
- `/home/ubuntu/apps/wc26-board/compose.yml`
- `/home/ubuntu/apps/wc26-board/Caddyfile`
- `/home/ubuntu/apps/wc26-board/.env`

The VPS also has an unrelated existing Docker stack named like
`navi-vault-backend` on ports `3000`, `3309`, and `6381`. Do not stop or replace
that stack while working on this app.

## Useful Commands

SSH into the server:

```bash
ssh ubuntu@43.135.135.137
cd /home/ubuntu/apps/wc26-board
```

Check containers and logs:

```bash
docker compose ps
docker compose logs --tail=120 daemon
docker compose logs --tail=120 board
docker compose logs --tail=120 board-proxy
docker compose logs --tail=120 board-tunnel
```

Restart the app:

```bash
docker compose restart daemon board board-proxy board-tunnel
```

Rebuild after syncing code:

```bash
docker compose build
docker compose up -d
```

Run the app health check inside the container:

```bash
docker compose exec board npm run health
docker compose exec board npm run status
```

Check the proxy locally on the VPS:

```bash
curl -I http://127.0.0.1:4627
```

The tunnel URL can be found in the tunnel logs:

```bash
docker compose logs board-tunnel | grep -Eo 'https://[-a-z0-9]+\.trycloudflare\.com' | tail -1
```

## Refreshing The Deployment

From the local project directory, sync source while excluding generated/runtime
state:

```bash
rsync -az --delete \
  --exclude node_modules \
  --exclude .git \
  --exclude dist \
  --exclude logs \
  --exclude .env \
  --exclude Dockerfile \
  --exclude compose.yml \
  --exclude Caddyfile \
  --exclude 'data/*.db' \
  --exclude 'data/*.db-*' \
  --exclude data/imports \
  --exclude data/walrus-feed \
  ./ ubuntu@43.135.135.137:/home/ubuntu/apps/wc26-board/
```

For SQLite data, prefer a consistent backup over copying a hot database file:

```bash
sqlite3 data/wc26.db ".backup '/tmp/wc26.db'"
scp /tmp/wc26.db ubuntu@43.135.135.137:/home/ubuntu/apps/wc26-board/data/wc26.db
rm /tmp/wc26.db
```

Then rebuild/restart on the VPS:

```bash
ssh ubuntu@43.135.135.137
cd /home/ubuntu/apps/wc26-board
docker compose build
docker compose up -d
docker compose exec board npm run health
```

## Environment Notes

Remote `.env` should be based on `.env.example`, with real values added only on
the VPS. Keep it untracked. During the initial deployment, local
`HTTP_PROXY`/`HTTPS_PROXY` values were removed from the remote `.env` because
they broke Polymarket fetches inside the container.

Common variables:

- `ODDS_API_KEY`
- `PM_POLL_MS`
- `KALSHI_POLL_MS`
- `SPORTTERY_POLL_MS` (defaults to hourly polling)
- `API_FOOTBALL_KEY` for scorelines and match events; if absent, review pages
  try Sporttery public scores first, then fall back to odds-only review; The
  Odds API scores can provide scorelines only
- `API_FOOTBALL_BASE` (defaults to `https://v3.football.api-sports.io`)
- `RESULTS_POLL_MS` (defaults to 10 minutes)
- `ODDSAPI_POLL_MS`
- `AI_PROVIDER` and the chosen provider key
- `SERVERCHAN_KEY`
- `WALRUS_*`; for one-off public testnet publishing, the verified public
  endpoints are `https://publisher.walrus-testnet.walrus.space` and
  `https://aggregator.walrus-testnet.walrus.space`
- `WALRUS_PUBLISH_MS` for daemon compact-publish cadence when
  `WALRUS_ENABLED=true` (defaults to 60 minutes)
- `BOARD_PORT=4626`

The current demo `.env` does not persist `WALRUS_PUBLISHER_URL`. For one-off
compact publishes, use:

```bash
docker compose exec -T \
  -e WALRUS_PUBLISHER_URL=https://publisher.walrus-testnet.walrus.space \
  -e WALRUS_AGGREGATOR_URL=https://aggregator.walrus-testnet.walrus.space \
  board npm run publish:walrus:testnet:compact
```

AI provider keys are intentionally absent from the current demo `.env`. The
board therefore shows the copy-prompt fallback and `/api/analyze-board` returns
`no_api_key` until one of `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`,
`KIMI_API_KEY`/`MOONSHOT_API_KEY`, or `OPENAI_COMPAT_API_KEY` is added.

## Verification Checklist

Use this after a deploy or restart:

```bash
docker compose ps
docker compose exec board npm run health
docker compose exec board npm run status
curl -I http://127.0.0.1:4627
curl -s http://127.0.0.1:4627/api/walrus
curl -s http://127.0.0.1:4627/api/match-events?fk=<fixture_key>
```

Expected current health state after the initial VPS deployment was:

- `pass: 9`
- `warn: 1` if the VPS is still blocked by Sporttery `HTTP 567`; otherwise `0`
- `fail: 0`

Also open the public tunnel URL and check:

- root landing page renders in English by default and Chinese with `?lang=zh`
- live radar renders at `/radar` and `/radar?lang=en`
- priority match cards show PM funding distribution or a clear unavailable state
- `/review?lang=zh` loads the post-match odds replay page
- match detail pages load
- `/walrus?lang=zh` loads and `/api/walrus` shows latest manifest metadata
  with aggregator JSON links and Walruscan links when blob ids exist
- `/api/ai/providers` returns default provider metadata
- `/api/probability?limit=1` returns candidates/skipped JSON
- `/api/analyze-board?lang=zh` either returns a parsed plan when a provider key
  is configured or returns `no_api_key` without logging secret material
- AI Betting Plan provider selection auto-fills DeepSeek/Kimi/Anthropic defaults
- PM liquidity/participation panels show data or clear sampled/degraded states
- Sporttery freshness should recover automatically when the official endpoint
  accepts VPS requests again; until then health may keep one Sporttery warn
- no obvious mobile overflow on a narrow viewport

## Capacity Notes

The demo VPS has 2 CPU cores, 4 GB RAM, a 60 GB SSD system disk, and a
1536 GB/month traffic package with 30 Mbps peak bandwidth. That is enough for a
small demo audience. This app is mostly a lightweight Node board plus a polling
daemon backed by SQLite. The main constraints are Docker build memory and
external API latency, not steady-state CPU.

If demo traffic grows, move the tunnel/proxy to a real domain and put the board
behind a normal HTTPS reverse proxy. Keep the daemon single-instance unless the
database/write model is changed.
