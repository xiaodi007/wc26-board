import { db } from "../db.js";

export type Label = "home" | "draw" | "away";
export type ThreeWay = Record<Label, number>;

export interface CurrentOddsRow {
  fixtureKey: string;
  kickoffUtc: string;
  live: boolean; // 已开球且未过完赛窗口(约 2.5h);PM/Kalshi 盘中仍交易,体彩已停售
  match: string;
  homeTeam: string;
  awayTeam: string;
  sourceOdds: Record<string, ThreeWay>;
  polymarket: ThreeWay | null;
  kalshi: ThreeWay | null;
  pinnacle: ThreeWay | null;
  sporttery: ThreeWay | null;
  bookAvg: ThreeWay | null;
  books: number;
}

interface FixtureRow {
  fixture_key: string;
  home_team: string;
  away_team: string;
  kickoff_utc: string;
}

interface LatestRow {
  fixture_key: string;
  source: string;
  outcome_label: string;
  prob_implied: number | null;
}

export const LABELS: Label[] = ["home", "draw", "away"];

function emptyThreeWay(): Partial<ThreeWay> {
  return {};
}

export function normalizeThreeWay(input: Partial<ThreeWay>): ThreeWay | null {
  if (!LABELS.every((label) => Number.isFinite(input[label]) && Number(input[label]) > 0)) {
    return null;
  }
  const sum = LABELS.reduce((acc, label) => acc + Number(input[label]), 0);
  if (!Number.isFinite(sum) || sum <= 0) return null;
  return {
    home: Number(input.home) / sum,
    draw: Number(input.draw) / sum,
    away: Number(input.away) / sum,
  };
}

export function averageThreeWay(rows: ThreeWay[]): ThreeWay | null {
  if (rows.length === 0) return null;
  return {
    home: rows.reduce((sum, row) => sum + row.home, 0) / rows.length,
    draw: rows.reduce((sum, row) => sum + row.draw, 0) / rows.length,
    away: rows.reduce((sum, row) => sum + row.away, 0) / rows.length,
  };
}

// 书商共识用中位数:单家离群/过期盘(实测 marathonbet 出现过 ±37pp 异常)不拖偏共识
export function medianThreeWay(rows: ThreeWay[]): ThreeWay | null {
  if (rows.length === 0) return null;
  const med = (values: number[]): number => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };
  // 每向取中位后加总未必为 1,再归一
  return normalizeThreeWay({
    home: med(rows.map((row) => row.home)),
    draw: med(rows.map((row) => row.draw)),
    away: med(rows.map((row) => row.away)),
  });
}

export function formatThreeWay(row: ThreeWay | null): string {
  if (!row) return "-";
  return LABELS.map((label) => `${(row[label] * 100).toFixed(1)}%`).join(" / ");
}

// 窗口放宽到开球前 2.5h:进行中比赛不消失(盘中概率正是看点),完赛自然滑出
const LIVE_WINDOW_H = 2.5;

const fixturesStmt = db.prepare(
  `WITH candidates AS (
     SELECT
       e.fixture_key,
       e.home_team,
       e.away_team,
       e.kickoff_utc,
       ROW_NUMBER() OVER (
         PARTITION BY e.fixture_key
         ORDER BY
           CASE
             WHEN EXISTS (
               SELECT 1 FROM market bm
               WHERE bm.event_id=e.id
                 AND bm.source NOT IN ('polymarket','kalshi','sporttery')
             ) THEN 0
             WHEN e.id NOT LIKE 'pm-%' AND e.id NOT LIKE 'sporttery-%' THEN 1
             WHEN e.id LIKE 'pm-%' THEN 2
             ELSE 3
           END,
           datetime(e.kickoff_utc),
           e.id
       ) AS rn,
       MIN(datetime(e.kickoff_utc)) OVER (PARTITION BY e.fixture_key) AS first_kickoff
     FROM event e
     WHERE datetime(e.kickoff_utc) >= datetime('now', '-${LIVE_WINDOW_H} hours')
   )
   SELECT fixture_key, home_team, away_team, kickoff_utc
   FROM candidates
   WHERE rn=1
   ORDER BY first_kickoff
   LIMIT ?`
);

const completedFixturesStmt = db.prepare(
  `WITH candidates AS (
     SELECT
       e.fixture_key,
       e.home_team,
       e.away_team,
       e.kickoff_utc,
       ROW_NUMBER() OVER (
         PARTITION BY e.fixture_key
         ORDER BY
           CASE
             WHEN EXISTS (
               SELECT 1 FROM market bm
               WHERE bm.event_id=e.id
                 AND bm.source NOT IN ('polymarket','kalshi','sporttery')
             ) THEN 0
             WHEN e.id NOT LIKE 'pm-%' AND e.id NOT LIKE 'sporttery-%' THEN 1
             WHEN e.id LIKE 'pm-%' THEN 2
             ELSE 3
           END,
           datetime(e.kickoff_utc),
           e.id
       ) AS rn,
       MIN(datetime(e.kickoff_utc)) OVER (PARTITION BY e.fixture_key) AS first_kickoff
     FROM event e
     WHERE datetime(e.kickoff_utc) < datetime('now', '-${LIVE_WINDOW_H} hours')
   )
   SELECT fixture_key, home_team, away_team, kickoff_utc
   FROM candidates
   WHERE rn=1
   ORDER BY first_kickoff DESC
   LIMIT ?`
);

const latestStmtCache = new Map<number, ReturnType<typeof db.prepare>>();

function latestStmtFor(count: number): ReturnType<typeof db.prepare> {
  const cached = latestStmtCache.get(count);
  if (cached) return cached;
  const placeholders = Array.from({ length: count }, () => "?").join(",");
  const stmt = db.prepare(
    `WITH latest AS (
       SELECT outcome_id, MAX(ts) AS ts
       FROM snapshot
       GROUP BY outcome_id
     )
     SELECT e.fixture_key, m.source, o.outcome_label, s.prob_implied
     FROM event e
     JOIN market m ON m.event_id=e.id
     JOIN outcome o ON o.market_id=m.id
     JOIN latest l ON l.outcome_id=o.id
     JOIN snapshot s ON s.outcome_id=o.id AND s.ts=l.ts
     WHERE e.fixture_key IN (${placeholders})
       AND o.outcome_label IN ('home', 'draw', 'away')
       AND m.market_type IN ('1x2', 'home_win_binary', 'draw_binary', 'away_win_binary', 'sporttery_had')
     ORDER BY e.fixture_key, m.source, o.outcome_label`
  );
  latestStmtCache.set(count, stmt);
  return stmt;
}

function getLatestRowsByFixture(fixtures: FixtureRow[]): Map<string, LatestRow[]> {
  const keys = fixtures.map((fixture) => fixture.fixture_key);
  if (!keys.length) return new Map();
  const rows = (latestStmtFor(keys.length) as unknown as { all: (...params: string[]) => LatestRow[] }).all(...keys);
  const byFixture = new Map<string, LatestRow[]>();
  for (const row of rows) {
    const group = byFixture.get(row.fixture_key) ?? [];
    group.push(row);
    byFixture.set(row.fixture_key, group);
  }
  return byFixture;
}

function assembleOddsRows(fixtures: FixtureRow[]): CurrentOddsRow[] {
  const latestByFixture = getLatestRowsByFixture(fixtures);

  return fixtures.map((fixture) => {
    const latest = latestByFixture.get(fixture.fixture_key) ?? [];
    const bySource = new Map<string, Partial<ThreeWay>>();
    for (const row of latest) {
      if (!LABELS.includes(row.outcome_label as Label) || row.prob_implied === null) continue;
      const source = bySource.get(row.source) ?? emptyThreeWay();
      source[row.outcome_label as Label] = row.prob_implied;
      bySource.set(row.source, source);
    }

    const normalized = new Map<string, ThreeWay>();
    for (const [source, probs] of bySource) {
      const threeWay = normalizeThreeWay(probs);
      if (threeWay) normalized.set(source, threeWay);
    }

    // book_avg 只取传统书商;预测市场(PM/Kalshi)与体彩单列
    const bookRows = [...normalized.entries()]
      .filter(([source]) => source !== "polymarket" && source !== "kalshi" && source !== "sporttery")
      .map(([, probs]) => probs);

    const kickoffMs = Date.parse(fixture.kickoff_utc);
    const live = Number.isFinite(kickoffMs) && kickoffMs <= Date.now() && Date.now() < kickoffMs + LIVE_WINDOW_H * 3600_000;

    return {
      fixtureKey: fixture.fixture_key,
      kickoffUtc: fixture.kickoff_utc,
      live,
      match: `${fixture.home_team} vs ${fixture.away_team}`,
      homeTeam: fixture.home_team,
      awayTeam: fixture.away_team,
      sourceOdds: Object.fromEntries(normalized) as Record<string, ThreeWay>,
      polymarket: normalized.get("polymarket") ?? null,
      kalshi: normalized.get("kalshi") ?? null,
      pinnacle: normalized.get("pinnacle") ?? null,
      sporttery: normalized.get("sporttery") ?? null,
      bookAvg: medianThreeWay(bookRows),
      books: bookRows.length,
    };
  });
}

export function getCurrentOdds(limit = 8): CurrentOddsRow[] {
  const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 50) : 8;
  return assembleOddsRows(fixturesStmt.all(safeLimit) as FixtureRow[]);
}

export function getCompletedOdds(limit = 20): CurrentOddsRow[] {
  const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20;
  return assembleOddsRows(completedFixturesStmt.all(safeLimit) as FixtureRow[]);
}
