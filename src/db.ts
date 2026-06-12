import Database from "better-sqlite3";
import { DB_PATH } from "./config.js";
import { fixtureKey } from "./fixtures.js";

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
db.exec("CREATE INDEX IF NOT EXISTS idx_event_fixture_key ON event(fixture_key)");

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
const stmtFindOutcome = db.prepare(`SELECT id FROM outcome WHERE market_id=? AND outcome_label=?`);
const stmtInsertOutcome = db.prepare(`INSERT INTO outcome (market_id, outcome_label) VALUES (?, ?)`);
const stmtInsertSnapshot = db.prepare(
  `INSERT INTO snapshot (outcome_id, ts, raw_price, prob_implied, bid, ask, volume, source_updated_ts)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
);
const stmtSetMeta = db.prepare(
  `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`
);
const stmtGetMeta = db.prepare(`SELECT value FROM meta WHERE key=?`);

export function upsertEvent(id: string, home: string, away: string, kickoffUtc: string, status = "scheduled"): void {
  stmtUpsertEvent.run(id, home, away, kickoffUtc, fixtureKey(home, away, kickoffUtc), status);
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
