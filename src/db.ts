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
CREATE TABLE IF NOT EXISTS ai_board_analysis (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT DEFAULT (datetime('now')),
  locale TEXT DEFAULT 'en',
  fixture_key TEXT,
  model TEXT,
  system_prompt TEXT,
  user_prompt TEXT NOT NULL,
  response TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS alert_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT DEFAULT (datetime('now')),
  kind TEXT NOT NULL,
  dedup_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  detail TEXT
);
CREATE TABLE IF NOT EXISTS walrus_publish_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT DEFAULT (datetime('now')),
  status TEXT NOT NULL,
  network TEXT,
  manifest_blob_id TEXT,
  manifest_object_id TEXT,
  artifact_count INTEGER DEFAULT 0,
  total_bytes INTEGER DEFAULT 0,
  detail TEXT
);
CREATE TABLE IF NOT EXISTS match_result (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fixture_key TEXT NOT NULL,
  source TEXT NOT NULL,
  source_fixture_id TEXT,
  status TEXT,
  elapsed INTEGER,
  home_score INTEGER,
  away_score INTEGER,
  winner TEXT,
  last_update_ts TEXT,
  raw_json TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(fixture_key, source)
);
CREATE INDEX IF NOT EXISTS idx_match_result_fixture ON match_result(fixture_key, source);
CREATE TABLE IF NOT EXISTS match_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fixture_key TEXT NOT NULL,
  source TEXT NOT NULL,
  source_fixture_id TEXT,
  event_key TEXT NOT NULL,
  minute INTEGER,
  extra_minute INTEGER,
  team_side TEXT,
  team_name TEXT,
  player_name TEXT,
  assist_name TEXT,
  event_type TEXT,
  detail TEXT,
  score_home INTEGER,
  score_away INTEGER,
  raw_json TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(fixture_key, source, event_key)
);
CREATE INDEX IF NOT EXISTS idx_match_event_fixture ON match_event(fixture_key, minute, extra_minute, id);
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
ensureColumn("ai_board_analysis", "locale", "TEXT DEFAULT 'en'");
ensureColumn("ai_board_analysis", "fixture_key", "TEXT");
db.exec("CREATE INDEX IF NOT EXISTS idx_event_fixture_key ON event(fixture_key)");
db.exec("CREATE INDEX IF NOT EXISTS idx_market_event_source ON market(event_id, source)");
db.exec("CREATE INDEX IF NOT EXISTS idx_market_event_type ON market(event_id, market_type)");
db.exec("CREATE INDEX IF NOT EXISTS idx_ai_board_analysis_scope ON ai_board_analysis(locale, fixture_key, ts)");
db.prepare(
  `UPDATE ai_board_analysis
   SET locale='en'
   WHERE locale IS NULL OR locale=''`
).run();
db.prepare(
  `UPDATE ai_board_analysis
   SET locale='zh'
   WHERE system_prompt LIKE '你是一名%' OR system_prompt LIKE '%中文投注参考计划%'`
).run();
const stmtBackfillBoardFixtureKey = db.prepare(`UPDATE ai_board_analysis SET fixture_key=? WHERE id=?`);
for (const row of db.prepare(`SELECT id, user_prompt FROM ai_board_analysis WHERE fixture_key IS NULL OR fixture_key=''`).all() as { id: number; user_prompt: string }[]) {
  const keys = [...row.user_prompt.matchAll(/^###\s+(.+)$/gm)].map((m) => m[1].trim()).filter(Boolean);
  if (keys.length === 1) stmtBackfillBoardFixtureKey.run(keys[0], row.id);
}

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
const stmtUpdateBoardAnalysisFixtureKey = db.prepare(`UPDATE ai_board_analysis SET fixture_key=? WHERE fixture_key=?`);

function syncFixtureKey(row: EventFixtureRow, nextKey: string): void {
  const prevKey = row.fixture_key;
  if (prevKey !== nextKey) {
    stmtUpdateFixtureKey.run(nextKey, row.id);
    if (prevKey) stmtUpdateAnalysisFixtureKey.run(nextKey, prevKey);
    if (prevKey) stmtUpdateBoardAnalysisFixtureKey.run(nextKey, prevKey);
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
const stmtGetEventFixtureKey = db.prepare(`SELECT fixture_key FROM event WHERE id=?`);
const stmtFindEventByFixture = db.prepare(
  `SELECT id, home_team, away_team, kickoff_utc, fixture_key
   FROM event
   WHERE fixture_key=?
   ORDER BY
     CASE
       WHEN id NOT LIKE 'pm-%' AND id NOT LIKE 'sporttery-%' THEN 0
       WHEN id LIKE 'pm-%' THEN 1
       ELSE 2
     END,
     datetime(kickoff_utc),
     id
   LIMIT 1`
);
const stmtUpsertMatchResult = db.prepare(
  `INSERT INTO match_result (
     fixture_key, source, source_fixture_id, status, elapsed,
     home_score, away_score, winner, last_update_ts, raw_json
   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(fixture_key, source) DO UPDATE SET
     source_fixture_id=excluded.source_fixture_id,
     status=excluded.status,
     elapsed=excluded.elapsed,
     home_score=excluded.home_score,
     away_score=excluded.away_score,
     winner=excluded.winner,
     last_update_ts=excluded.last_update_ts,
     raw_json=excluded.raw_json`
);
const stmtUpsertMatchEvent = db.prepare(
  `INSERT INTO match_event (
     fixture_key, source, source_fixture_id, event_key, minute, extra_minute,
     team_side, team_name, player_name, assist_name, event_type, detail,
     score_home, score_away, raw_json
   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(fixture_key, source, event_key) DO UPDATE SET
     source_fixture_id=excluded.source_fixture_id,
     minute=excluded.minute,
     extra_minute=excluded.extra_minute,
     team_side=excluded.team_side,
     team_name=excluded.team_name,
     player_name=excluded.player_name,
     assist_name=excluded.assist_name,
     event_type=excluded.event_type,
     detail=excluded.detail,
     score_home=excluded.score_home,
     score_away=excluded.score_away,
     raw_json=excluded.raw_json`
);

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

export function eventFixtureKey(id: string): string | null {
  const row = stmtGetEventFixtureKey.get(id) as { fixture_key: string | null } | undefined;
  return row?.fixture_key ?? null;
}

export interface EventIdentityRow {
  id: string;
  home_team: string;
  away_team: string;
  kickoff_utc: string;
  fixture_key: string;
}

export function findEventByFixtureKey(fixtureKey: string): EventIdentityRow | null {
  return (stmtFindEventByFixture.get(fixtureKey) as EventIdentityRow | undefined) ?? null;
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

export interface MatchResultInput {
  fixtureKey: string;
  source: string;
  sourceFixtureId?: string | null;
  status?: string | null;
  elapsed?: number | null;
  homeScore?: number | null;
  awayScore?: number | null;
  winner?: string | null;
  lastUpdateTs?: string | null;
  rawJson?: string | null;
}

export interface MatchEventInput {
  fixtureKey: string;
  source: string;
  sourceFixtureId?: string | null;
  eventKey: string;
  minute?: number | null;
  extraMinute?: number | null;
  teamSide?: "home" | "away" | "unknown" | string | null;
  teamName?: string | null;
  playerName?: string | null;
  assistName?: string | null;
  eventType?: string | null;
  detail?: string | null;
  scoreHome?: number | null;
  scoreAway?: number | null;
  rawJson?: string | null;
}

export function upsertMatchResult(row: MatchResultInput): void {
  stmtUpsertMatchResult.run(
    row.fixtureKey,
    row.source,
    row.sourceFixtureId ?? null,
    row.status ?? null,
    row.elapsed ?? null,
    row.homeScore ?? null,
    row.awayScore ?? null,
    row.winner ?? null,
    row.lastUpdateTs ?? null,
    row.rawJson ?? null
  );
}

export const upsertMatchEvents = db.transaction((rows: MatchEventInput[]) => {
  for (const row of rows) {
    stmtUpsertMatchEvent.run(
      row.fixtureKey,
      row.source,
      row.sourceFixtureId ?? null,
      row.eventKey,
      row.minute ?? null,
      row.extraMinute ?? null,
      row.teamSide ?? null,
      row.teamName ?? null,
      row.playerName ?? null,
      row.assistName ?? null,
      row.eventType ?? null,
      row.detail ?? null,
      row.scoreHome ?? null,
      row.scoreAway ?? null,
      row.rawJson ?? null
    );
  }
  return rows.length;
});

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
const stmtInsertBoardAnalysis = db.prepare(
  `INSERT INTO ai_board_analysis (locale, fixture_key, model, system_prompt, user_prompt, response) VALUES (?, ?, ?, ?, ?, ?)`
);

export function insertAnalysis(fixtureKey: string, model: string, systemPrompt: string, userPrompt: string, response: string): number {
  return Number(stmtInsertAnalysis.run(fixtureKey, model, systemPrompt, userPrompt, response).lastInsertRowid);
}

export function listAnalyses(fixtureKey: string, limit = 5): AiAnalysisRow[] {
  return stmtListAnalyses.all(fixtureKey, Math.min(Math.max(limit, 1), 20)) as AiAnalysisRow[];
}

export interface AiBoardAnalysisRow {
  id: number;
  ts: string;
  locale: "zh" | "en" | string | null;
  fixture_key: string | null;
  model: string | null;
  system_prompt: string | null;
  user_prompt: string;
  response: string;
}

export function insertBoardAnalysis(args: {
  locale: "zh" | "en";
  fixtureKey?: string | null;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  response: string;
}): number {
  return Number(
    stmtInsertBoardAnalysis.run(args.locale, args.fixtureKey ?? null, args.model, args.systemPrompt, args.userPrompt, args.response).lastInsertRowid
  );
}

export function listBoardAnalyses(args: { locale?: "zh" | "en"; fixtureKey?: string | null; limit?: number } = {}): AiBoardAnalysisRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (args.locale) {
    clauses.push("locale=?");
    params.push(args.locale);
  }
  if ("fixtureKey" in args) {
    if (args.fixtureKey) {
      clauses.push("fixture_key=?");
      params.push(args.fixtureKey);
    } else {
      clauses.push("fixture_key IS NULL");
    }
  }
  const sql = `SELECT * FROM ai_board_analysis${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY ts DESC, id DESC LIMIT ?`;
  params.push(Math.min(Math.max(args.limit ?? 5, 1), 20));
  return db.prepare(sql).all(...params) as AiBoardAnalysisRow[];
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

export interface WalrusPublishLogRow {
  id: number;
  ts: string;
  status: "success" | "error" | string;
  network: string | null;
  manifest_blob_id: string | null;
  manifest_object_id: string | null;
  artifact_count: number;
  total_bytes: number;
  detail: string | null;
}

const stmtInsertWalrusPublishLog = db.prepare(
  `INSERT INTO walrus_publish_log (status, network, manifest_blob_id, manifest_object_id, artifact_count, total_bytes, detail)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
);
const stmtListWalrusPublishLog = db.prepare(`SELECT * FROM walrus_publish_log ORDER BY ts DESC, id DESC LIMIT ?`);

export function insertWalrusPublishLog(row: {
  status: "success" | "error";
  network?: string | null;
  manifestBlobId?: string | null;
  manifestObjectId?: string | null;
  artifactCount?: number;
  totalBytes?: number;
  detail?: string | null;
}): number {
  return Number(
    stmtInsertWalrusPublishLog.run(
      row.status,
      row.network ?? null,
      row.manifestBlobId ?? null,
      row.manifestObjectId ?? null,
      row.artifactCount ?? 0,
      row.totalBytes ?? 0,
      row.detail ?? null
    ).lastInsertRowid
  );
}

export function listWalrusPublishLog(limit = 10): WalrusPublishLogRow[] {
  return stmtListWalrusPublishLog.all(Math.min(Math.max(limit, 1), 50)) as WalrusPublishLogRow[];
}
