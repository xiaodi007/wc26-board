import Database from "better-sqlite3";
import { DB_PATH } from "./config.js";
import { fixtureKey, fixtureTeamDayKey, isSameFixtureWindow } from "./fixtures.js";

// schema 来源: deepseek-pro 设计稿(sui-research/sources/raw/wc26-deepseek-2026-06-12.md §1.4)
// snapshot 只追加;market/outcome 是维表;event_id 可空(冠军盘等赛事级市场不挂单场)
const SCHEMA = `
CREATE TABLE IF NOT EXISTS event (
  id TEXT PRIMARY KEY,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  kickoff_utc TEXT NOT NULL,
  fixture_key TEXT,
  status TEXT DEFAULT 'scheduled',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS market (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT REFERENCES event(id),
  market_type TEXT NOT NULL,
  spec TEXT,
  source TEXT NOT NULL,
  source_market_id TEXT,
  condition_id TEXT,
  UNIQUE(source, source_market_id)
);
CREATE TABLE IF NOT EXISTS outcome (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_id INTEGER NOT NULL REFERENCES market(id),
  outcome_label TEXT NOT NULL,
  UNIQUE(market_id, outcome_label)
);
CREATE TABLE IF NOT EXISTS snapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  outcome_id INTEGER NOT NULL REFERENCES outcome(id),
  ts TEXT NOT NULL,
  raw_price TEXT,
  prob_implied REAL,
  bid REAL,
  ask REAL,
  volume REAL,
  source_updated_ts TEXT
);
CREATE INDEX IF NOT EXISTS idx_snapshot_outcome_ts ON snapshot(outcome_id, ts);
CREATE INDEX IF NOT EXISTS idx_snapshot_ts ON snapshot(ts);
CREATE TABLE IF NOT EXISTS market_metric_snapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_id INTEGER NOT NULL REFERENCES market(id),
  ts TEXT NOT NULL,
  source TEXT NOT NULL,
  source_market_id TEXT,
  condition_id TEXT,
  liquidity REAL,
  liquidity_clob REAL,
  volume_24h REAL,
  volume_total REAL,
  spread REAL,
  best_bid REAL,
  best_ask REAL,
  last_trade_price REAL,
  holder_depth_top INTEGER,
  holder_concentration REAL,
  active_traders_24h INTEGER,
  trade_count_24h INTEGER,
  holders_sampled INTEGER DEFAULT 0,
  trades_sampled INTEGER DEFAULT 0,
  source_updated_ts TEXT
);
CREATE INDEX IF NOT EXISTS idx_market_metric_market_ts ON market_metric_snapshot(market_id, ts);
CREATE INDEX IF NOT EXISTS idx_market_metric_condition_ts ON market_metric_snapshot(condition_id, ts);
CREATE INDEX IF NOT EXISTS idx_market_metric_ts ON market_metric_snapshot(ts);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS ai_analysis (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fixture_key TEXT NOT NULL,
  ts TEXT DEFAULT (datetime('now')),
  model TEXT,
  system_prompt TEXT,
  user_prompt TEXT NOT NULL,
  response TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_analysis_fixture ON ai_analysis(fixture_key, ts);
CREATE TABLE IF NOT EXISTS alert_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT DEFAULT (datetime('now')),
  kind TEXT NOT NULL,
  dedup_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  detail TEXT
);
`;

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(SCHEMA);

function ensureColumn(table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

ensureColumn("event", "fixture_key", "TEXT");
ensureColumn("market", "condition_id", "TEXT");
db.exec("CREATE INDEX IF NOT EXISTS idx_event_fixture_key ON event(fixture_key)");
db.exec("CREATE INDEX IF NOT EXISTS idx_market_event_source ON market(event_id, source)");
db.exec("CREATE INDEX IF NOT EXISTS idx_market_event_type ON market(event_id, market_type)");

interface EventFixtureRow {
  id: string;
  home_team: string;
  away_team: string;
  kickoff_utc: string;
  fixture_key: string | null;
  sources: string | null;
}

const stmtBackfillFixtureKey = db.prepare(`UPDATE event SET fixture_key=? WHERE id=?`);
const eventsMissingFixtureKey = db
  .prepare(`SELECT id, home_team, away_team, kickoff_utc FROM event WHERE fixture_key IS NULL OR fixture_key=''`)
  .all() as { id: string; home_team: string; away_team: string; kickoff_utc: string }[];
const backfillFixtureKeys = db.transaction(() => {
  for (const ev of eventsMissingFixtureKey) {
    stmtBackfillFixtureKey.run(fixtureKey(ev.home_team, ev.away_team, ev.kickoff_utc), ev.id);
  }
});
backfillFixtureKeys();

function sourceSet(row: Pick<EventFixtureRow, "sources">): Set<string> {
  return new Set((row.sources ?? "").split(",").map((s) => s.trim()).filter(Boolean));
}

function hasBookSource(row: Pick<EventFixtureRow, "id" | "sources">): boolean {
  return [...sourceSet(row)].some((source) => !["polymarket", "kalshi", "sporttery"].includes(source));
}

function canonicalPriority(row: Pick<EventFixtureRow, "id" | "sources">): number {
  const sources = sourceSet(row);
  if (hasBookSource(row)) return 0;
  if (!row.id.startsWith("pm-") && !row.id.startsWith("sporttery-")) return 1;
  if (row.id.startsWith("pm-") || sources.has("polymarket")) return 2;
  if (sources.has("kalshi")) return 3;
  if (row.id.startsWith("sporttery-") || sources.has("sporttery")) return 4;
  return 5;
}

function rowTime(row: Pick<EventFixtureRow, "kickoff_utc">): number {
  const t = Date.parse(row.kickoff_utc);
  return Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER;
}

function chooseCanonicalRow(rows: EventFixtureRow[]): EventFixtureRow {
  return [...rows].sort((a, b) => canonicalPriority(a) - canonicalPriority(b) || rowTime(a) - rowTime(b) || a.id.localeCompare(b.id))[0];
}

const stmtEventsWithSources = db.prepare(
  `SELECT e.id, e.home_team, e.away_team, e.kickoff_utc, e.fixture_key, group_concat(DISTINCT m.source) AS sources
   FROM event e
   LEFT JOIN market m ON m.event_id=e.id
   GROUP BY e.id`
);
const stmtUpdateFixtureKey = db.prepare(`UPDATE event SET fixture_key=? WHERE id=?`);
const stmtUpdateAnalysisFixtureKey = db.prepare(`UPDATE ai_analysis SET fixture_key=? WHERE fixture_key=?`);

function syncFixtureKey(row: EventFixtureRow, nextKey: string): void {
  const prevKey = row.fixture_key;
  if (prevKey !== nextKey) {
    stmtUpdateFixtureKey.run(nextKey, row.id);
    if (prevKey) stmtUpdateAnalysisFixtureKey.run(nextKey, prevKey);
    row.fixture_key = nextKey;
  }
}

function canonicalizeClusters(rows: EventFixtureRow[]): void {
  const byTeamDay = new Map<string, EventFixtureRow[]>();
  for (const row of rows) {
    const groupKey = fixtureTeamDayKey(row.home_team, row.away_team, row.kickoff_utc);
    byTeamDay.set(groupKey, [...(byTeamDay.get(groupKey) ?? []), row]);
  }

  for (const group of byTeamDay.values()) {
    const sorted = [...group].sort((a, b) => rowTime(a) - rowTime(b) || a.id.localeCompare(b.id));
    let cluster: EventFixtureRow[] = [];
    const flush = (): void => {
      if (cluster.length === 0) return;
      const canonical = chooseCanonicalRow(cluster);
      const nextKey = fixtureKey(canonical.home_team, canonical.away_team, canonical.kickoff_utc);
      for (const row of cluster) syncFixtureKey(row, nextKey);
      cluster = [];
    };

    for (const row of sorted) {
      const prev = cluster[cluster.length - 1];
      if (prev && !isSameFixtureWindow(prev.kickoff_utc, row.kickoff_utc)) flush();
      cluster.push(row);
    }
    flush();
  }
}

const backfillApproximateFixtureKeys = db.transaction(() => {
  canonicalizeClusters(stmtEventsWithSources.all() as EventFixtureRow[]);
});
backfillApproximateFixtureKeys();

const stmtUpsertEvent = db.prepare(
  `INSERT INTO event (id, home_team, away_team, kickoff_utc, fixture_key, status) VALUES (?, ?, ?, ?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET
     home_team=excluded.home_team,
     away_team=excluded.away_team,
     kickoff_utc=excluded.kickoff_utc,
     fixture_key=excluded.fixture_key,
     status=excluded.status`
);
const stmtFindMarket = db.prepare(`SELECT id FROM market WHERE source=? AND source_market_id=?`);
const stmtInsertMarket = db.prepare(
  `INSERT INTO market (event_id, market_type, spec, source, source_market_id) VALUES (?, ?, ?, ?, ?)`
);
const stmtSetMarketConditionId = db.prepare(`UPDATE market SET condition_id=? WHERE id=? AND (condition_id IS NULL OR condition_id<>?)`);
const stmtFindOutcome = db.prepare(`SELECT id FROM outcome WHERE market_id=? AND outcome_label=?`);
const stmtInsertOutcome = db.prepare(`INSERT INTO outcome (market_id, outcome_label) VALUES (?, ?)`);
const stmtInsertSnapshot = db.prepare(
  `INSERT INTO snapshot (outcome_id, ts, raw_price, prob_implied, bid, ask, volume, source_updated_ts)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
);
const stmtInsertMarketMetric = db.prepare(
  `INSERT INTO market_metric_snapshot (
     market_id, ts, source, source_market_id, condition_id, liquidity, liquidity_clob,
     volume_24h, volume_total, spread, best_bid, best_ask, last_trade_price,
     holder_depth_top, holder_concentration, active_traders_24h, trade_count_24h,
     holders_sampled, trades_sampled, source_updated_ts
   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const stmtSetMeta = db.prepare(
  `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`
);
const stmtGetMeta = db.prepare(`SELECT value FROM meta WHERE key=?`);

function canonicalFixtureKeyFor(id: string, home: string, away: string, kickoffUtc: string): string {
  const current: EventFixtureRow = {
    id,
    home_team: home,
    away_team: away,
    kickoff_utc: kickoffUtc,
    fixture_key: fixtureKey(home, away, kickoffUtc),
    sources: null,
  };
  const rows = (stmtEventsWithSources.all() as EventFixtureRow[]).filter(
    (row) =>
      fixtureTeamDayKey(row.home_team, row.away_team, row.kickoff_utc) === fixtureTeamDayKey(home, away, kickoffUtc) &&
      isSameFixtureWindow(row.kickoff_utc, kickoffUtc)
  );
  const canonical = chooseCanonicalRow([...rows.filter((row) => row.id !== id), current]);
  return fixtureKey(canonical.home_team, canonical.away_team, canonical.kickoff_utc);
}

export function upsertEvent(id: string, home: string, away: string, kickoffUtc: string, status = "scheduled"): void {
  const nextKey = canonicalFixtureKeyFor(id, home, away, kickoffUtc);
  stmtUpsertEvent.run(id, home, away, kickoffUtc, nextKey, status);
  canonicalizeClusters((stmtEventsWithSources.all() as EventFixtureRow[]).filter((row) => row.fixture_key === nextKey || isSameFixtureWindow(row.kickoff_utc, kickoffUtc)));
}

const marketCache = new Map<string, number>();
export function getOrCreateMarket(
  source: string,
  sourceMarketId: string,
  marketType: string,
  eventId: string | null = null,
  spec: string | null = null
): number {
  const key = `${source}|${sourceMarketId}`;
  const cached = marketCache.get(key);
  if (cached !== undefined) return cached;
  const row = stmtFindMarket.get(source, sourceMarketId) as { id: number } | undefined;
  const id = row ? row.id : Number(stmtInsertMarket.run(eventId, marketType, spec, source, sourceMarketId).lastInsertRowid);
  marketCache.set(key, id);
  return id;
}

export function setMarketConditionId(marketId: number, conditionId: string | null | undefined): void {
  if (!conditionId) return;
  stmtSetMarketConditionId.run(conditionId, marketId, conditionId);
}

const outcomeCache = new Map<string, number>();
export function getOrCreateOutcome(marketId: number, label: string): number {
  const key = `${marketId}|${label}`;
  const cached = outcomeCache.get(key);
  if (cached !== undefined) return cached;
  const row = stmtFindOutcome.get(marketId, label) as { id: number } | undefined;
  const id = row ? row.id : Number(stmtInsertOutcome.run(marketId, label).lastInsertRowid);
  outcomeCache.set(key, id);
  return id;
}

export interface SnapshotRow {
  outcomeId: number;
  rawPrice: string;
  probImplied: number | null;
  bid?: number | null;
  ask?: number | null;
  volume?: number | null;
  sourceUpdatedTs?: string | null;
}

export const insertSnapshots = db.transaction((rows: SnapshotRow[]) => {
  const ts = new Date().toISOString();
  for (const r of rows) {
    stmtInsertSnapshot.run(
      r.outcomeId, ts, r.rawPrice, r.probImplied,
      r.bid ?? null, r.ask ?? null, r.volume ?? null, r.sourceUpdatedTs ?? null
    );
  }
  return rows.length;
});

export interface MarketMetricSnapshotRow {
  marketId: number;
  source: string;
  sourceMarketId?: string | null;
  conditionId?: string | null;
  liquidity?: number | null;
  liquidityClob?: number | null;
  volume24h?: number | null;
  volumeTotal?: number | null;
  spread?: number | null;
  bestBid?: number | null;
  bestAsk?: number | null;
  lastTradePrice?: number | null;
  holderDepthTop?: number | null;
  holderConcentration?: number | null;
  activeTraders24h?: number | null;
  tradeCount24h?: number | null;
  holdersSampled?: boolean;
  tradesSampled?: boolean;
  sourceUpdatedTs?: string | null;
}

export const insertMarketMetricSnapshots = db.transaction((rows: MarketMetricSnapshotRow[]) => {
  const ts = new Date().toISOString();
  for (const r of rows) {
    stmtInsertMarketMetric.run(
      r.marketId,
      ts,
      r.source,
      r.sourceMarketId ?? null,
      r.conditionId ?? null,
      r.liquidity ?? null,
      r.liquidityClob ?? null,
      r.volume24h ?? null,
      r.volumeTotal ?? null,
      r.spread ?? null,
      r.bestBid ?? null,
      r.bestAsk ?? null,
      r.lastTradePrice ?? null,
      r.holderDepthTop ?? null,
      r.holderConcentration ?? null,
      r.activeTraders24h ?? null,
      r.tradeCount24h ?? null,
      r.holdersSampled ? 1 : 0,
      r.tradesSampled ? 1 : 0,
      r.sourceUpdatedTs ?? null
    );
  }
  return rows.length;
});

export function setMeta(key: string, value: string): void {
  stmtSetMeta.run(key, value);
}
export function getMeta(key: string): string | null {
  const row = stmtGetMeta.get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export interface AiAnalysisRow {
  id: number;
  fixture_key: string;
  ts: string;
  model: string | null;
  system_prompt: string | null;
  user_prompt: string;
  response: string;
}

const stmtInsertAnalysis = db.prepare(
  `INSERT INTO ai_analysis (fixture_key, model, system_prompt, user_prompt, response) VALUES (?, ?, ?, ?, ?)`
);
const stmtListAnalyses = db.prepare(
  `SELECT * FROM ai_analysis WHERE fixture_key=? ORDER BY ts DESC, id DESC LIMIT ?`
);

export function insertAnalysis(fixtureKey: string, model: string, systemPrompt: string, userPrompt: string, response: string): number {
  return Number(stmtInsertAnalysis.run(fixtureKey, model, systemPrompt, userPrompt, response).lastInsertRowid);
}

export function listAnalyses(fixtureKey: string, limit = 5): AiAnalysisRow[] {
  return stmtListAnalyses.all(fixtureKey, Math.min(Math.max(limit, 1), 20)) as AiAnalysisRow[];
}

export interface AlertRow {
  id: number;
  ts: string;
  kind: string;
  dedup_key: string;
  title: string;
  detail: string | null;
}

const stmtInsertAlert = db.prepare(
  `INSERT OR IGNORE INTO alert_log (kind, dedup_key, title, detail) VALUES (?, ?, ?, ?)`
);
const stmtListAlerts = db.prepare(`SELECT * FROM alert_log ORDER BY ts DESC, id DESC LIMIT ?`);
const stmtCountAlerts24h = db.prepare(`SELECT COUNT(*) AS n FROM alert_log WHERE ts >= datetime('now', '-1 day')`);

// 去重即落库:dedup_key 撞 UNIQUE 则忽略,返回是否为新事件
export function insertAlertIfNew(kind: string, dedupKey: string, title: string, detail: string | null = null): boolean {
  return stmtInsertAlert.run(kind, dedupKey, title, detail).changes > 0;
}

export function listRecentAlerts(limit = 10): AlertRow[] {
  return stmtListAlerts.all(Math.min(Math.max(limit, 1), 50)) as AlertRow[];
}

export function countAlerts24h(): number {
  return (stmtCountAlerts24h.get() as { n: number }).n;
}
