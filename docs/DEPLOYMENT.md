# Demo Deployment Runbook

Last verified: 2026-06-13

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

- Latest app rebuild/restart: 2026-06-13 13:33 CST
- Deployed change: AI Betting Plan compact card + modal on home/match pages,
  prompt language routing with English default and `?lang=zh` Chinese prompts,
  plus `/walrus` manifest/artifact links and local JSON data previews.
- Verification: `docker compose exec -T board npm run health` returned
  `10 pass, 0 warn, 0 fail`.
- `docker compose exec -T board npm run status` showed 140 source rows,
  70 fixtures, and next-24h matches available.
- Walrus testnet compact publish succeeded at 2026-06-13 13:34 CST using a
  one-off public publisher endpoint injection:
  manifest blob `xYuz11Otvz_gMjA5FJYDZQROBerh_sxTAolrp_MKC_o`, 4 artifacts,
  725,443 bytes, empty `walrus_latest_error`.
- AI smoke call to public `/api/analyze-board` with `1000` bankroll and `30`
  max loss correctly returned `503 no_api_key` because the demo `.env` has no
  provider key (`ANTHROPIC_API_KEY` missing). `/api/board-prompt` returns an
  English prompt by default and `/api/board-prompt?lang=zh` returns Chinese.
- Public quick-tunnel checks after deploy returned HTTP 200 for `/`,
  `/?lang=en`, `/match?...&lang=en`, `/walrus?lang=en`, `/api/walrus`, and
  `/api/board-prompt`. `/walrus?lang=en` includes Data Preview, Open
  `/api/walrus`, and artifact action links.

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
- `ODDSAPI_POLL_MS`
- `AI_PROVIDER` and the chosen provider key
- `SERVERCHAN_KEY`
- `WALRUS_*`; for one-off public testnet publishing, the verified public
  endpoints are `https://publisher.walrus-testnet.walrus.space` and
  `https://aggregator.walrus-testnet.walrus.space`
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
```

Expected current health state after the initial VPS deployment was:

- `pass: 10`
- `warn: 0`
- `fail: 0`

Also open the public tunnel URL and check:

- home page renders in Chinese and English with `?lang=zh` / `?lang=en`
- match detail pages load
- `/walrus?lang=zh` loads and `/api/walrus` shows latest manifest metadata
- `/api/analyze-board?lang=zh` either returns a parsed plan when a provider key
  is configured or returns `no_api_key` without logging secret material
- PM liquidity/participation panels show data or clear sampled/degraded states
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
