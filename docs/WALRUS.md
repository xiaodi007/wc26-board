# Walrus Public Data Layer

Walrus is used as the public, verifiable data layer for the demo. The feed is a
sanitized aggregate snapshot, not a database dump.

## What Is Published

The Walrus feed can include:

- market radar metrics;
- opportunity rankings;
- match-level aggregate data;
- source freshness;
- sampled/risk flags;
- public AI board digest;
- schema version and artifact hashes;
- manifest metadata and publish log references.

## What Is Never Published

The feed must not include:

- API keys or private keys;
- `.env` contents;
- full SQLite databases;
- logs;
- raw holder wallet addresses;
- personal bankroll or stake amounts;
- temporary AI provider keys;
- raw imported files.

## Local Export

```bash
npm run export:walrus
```

This writes JSON artifacts under `data/walrus-feed/`, which is ignored by Git.
The schema version is `wc26.market_radar.v1`.

Typical artifacts include:

- `radar-latest.json`
- `opportunities-latest.json`
- `ai-board-latest.json`
- `matches/*.json`
- `manifest-latest.json`

## Testnet Publishing

Publishing requires a Walrus publisher endpoint:

```bash
WALRUS_PUBLISHER_URL=https://publisher.walrus-testnet.walrus.space \
WALRUS_AGGREGATOR_URL=https://aggregator.walrus-testnet.walrus.space \
npm run publish:walrus:testnet:compact
```

The daemon can also publish compact snapshots when `WALRUS_ENABLED=true`.
`WALRUS_PUBLISH_MS` controls the cadence.

## In-App Proof

The `/walrus` page displays:

- latest manifest blob and object ids when available;
- network and schema metadata;
- artifact table with SHA-256 hashes;
- aggregator JSON links;
- Walruscan links;
- local JSON preview;
- remote Walrus blob preview;
- publish logs.

## Overflow Positioning

The track narrative is: AI-assisted sports market intelligence with verifiable
off-chain data snapshots. Walrus gives judges a concrete way to inspect the
public state behind the board without exposing private runtime data.
