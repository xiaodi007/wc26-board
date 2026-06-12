import { db } from "../db.js";

export type Label = "home" | "draw" | "away";
export type ThreeWay = Record<Label, number>;

export interface CurrentOddsRow {
  fixtureKey: string;
  kickoffUtc: string;
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

const fixturesStmt = db.prepare(
  `SELECT fixture_key, MIN(home_team) AS home_team, MIN(away_team) AS away_team, MIN(kickoff_utc) AS kickoff_utc
   FROM event
   WHERE datetime(kickoff_utc) >= datetime('now')
   GROUP BY fixture_key
   ORDER BY datetime(MIN(kickoff_utc))
   LIMIT ?`
);

const latestStmt = db.prepare(
  `WITH latest AS (
     SELECT outcome_id, MAX(ts) AS ts
     FROM snapshot
     GROUP BY outcome_id
   )
   SELECT m.source, o.outcome_label, s.prob_implied
   FROM market m
   JOIN event e ON e.id=m.event_id
   JOIN outcome o ON o.market_id=m.id
   JOIN latest l ON l.outcome_id=o.id
   JOIN snapshot s ON s.outcome_id=o.id AND s.ts=l.ts
   WHERE e.fixture_key=?
     AND o.outcome_label IN ('home', 'draw', 'away')
     AND m.market_type IN ('1x2', 'home_win_binary', 'draw_binary', 'away_win_binary', 'sporttery_had')
   ORDER BY m.source, o.outcome_label`
);

export function getCurrentOdds(limit = 8): CurrentOddsRow[] {
  const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 50) : 8;
  const fixtures = fixturesStmt.all(safeLimit) as FixtureRow[];

  return fixtures.map((fixture) => {
    const latest = latestStmt.all(fixture.fixture_key) as LatestRow[];
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

    return {
      fixtureKey: fixture.fixture_key,
      kickoffUtc: fixture.kickoff_utc,
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
