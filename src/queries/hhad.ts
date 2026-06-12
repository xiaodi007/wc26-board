import { db } from "../db.js";
import { LABELS, normalizeThreeWay, type Label, type ThreeWay } from "./currentOdds.js";

// 体彩让球胜平负(HHAD)最新盘口:让球线在 market.spec,原始 SP 在 raw_price JSON。

export interface HhadView {
  goalLine: string; // 如 "-1" = 主让一球
  sp: Record<Label, number | null>; // 原始 SP 赔率
  probs: ThreeWay | null; // 三向归一后
  sourceUpdatedTs: string | null;
}

const hhadStmt = db.prepare(
  `WITH latest AS (SELECT outcome_id, MAX(ts) AS ts FROM snapshot GROUP BY outcome_id)
   SELECT o.outcome_label AS label, s.prob_implied AS prob, s.raw_price AS raw, m.spec AS spec, s.source_updated_ts AS updated
   FROM market m
   JOIN event e ON e.id = m.event_id
   JOIN outcome o ON o.market_id = m.id
   JOIN latest l ON l.outcome_id = o.id
   JOIN snapshot s ON s.outcome_id = o.id AND s.ts = l.ts
   WHERE e.fixture_key = ? AND m.source = 'sporttery' AND m.market_type = 'sporttery_hhad'`
);

interface RawRow {
  label: string;
  prob: number | null;
  raw: string | null;
  spec: string | null;
  updated: string | null;
}

function assembleView(rows: RawRow[]): HhadView | null {
  if (rows.length === 0) return null;

  const partial: Partial<ThreeWay> = {};
  const sp: Record<Label, number | null> = { home: null, draw: null, away: null };
  let goalLine = "";
  let updated: string | null = null;
  for (const row of rows) {
    if (!LABELS.includes(row.label as Label)) continue;
    if (row.prob !== null) partial[row.label as Label] = row.prob;
    goalLine = row.spec ?? goalLine;
    updated = row.updated ?? updated;
    try {
      const raw = row.raw ? (JSON.parse(row.raw) as { sp?: number }) : null;
      sp[row.label as Label] = raw?.sp ?? null;
    } catch {
      /* raw_price 解析失败就只缺 SP 展示 */
    }
  }

  return { goalLine, sp, probs: normalizeThreeWay(partial), sourceUpdatedTs: updated };
}

export function getSportteryHhad(fixtureKey: string): HhadView | null {
  return assembleView(hhadStmt.all(fixtureKey) as RawRow[]);
}

// 主页批量视图:未开赛场次的最新 HHAD,按开球时间排序
export interface HhadBoardRow extends HhadView {
  fixtureKey: string;
  homeTeam: string;
  awayTeam: string;
  kickoffUtc: string;
}

const allHhadStmt = db.prepare(
  `WITH latest AS (SELECT outcome_id, MAX(ts) AS ts FROM snapshot GROUP BY outcome_id)
   SELECT e.fixture_key AS fixture_key, e.home_team AS home_team, e.away_team AS away_team, e.kickoff_utc AS kickoff_utc,
          o.outcome_label AS label, s.prob_implied AS prob, s.raw_price AS raw, m.spec AS spec, s.source_updated_ts AS updated
   FROM market m
   JOIN event e ON e.id = m.event_id
   JOIN outcome o ON o.market_id = m.id
   JOIN latest l ON l.outcome_id = o.id
   JOIN snapshot s ON s.outcome_id = o.id AND s.ts = l.ts
   WHERE m.source = 'sporttery' AND m.market_type = 'sporttery_hhad'
     AND datetime(e.kickoff_utc) >= datetime('now')
   ORDER BY datetime(e.kickoff_utc)`
);

interface RawBoardRow extends RawRow {
  fixture_key: string;
  home_team: string;
  away_team: string;
  kickoff_utc: string;
}

export function getAllSportteryHhad(): HhadBoardRow[] {
  const rows = allHhadStmt.all() as RawBoardRow[];
  const byFixture = new Map<string, RawBoardRow[]>();
  for (const row of rows) {
    const group = byFixture.get(row.fixture_key) ?? [];
    group.push(row);
    byFixture.set(row.fixture_key, group);
  }

  const result: HhadBoardRow[] = [];
  for (const group of byFixture.values()) {
    const view = assembleView(group);
    if (!view) continue;
    result.push({
      ...view,
      fixtureKey: group[0].fixture_key,
      homeTeam: group[0].home_team,
      awayTeam: group[0].away_team,
      kickoffUtc: group[0].kickoff_utc,
    });
  }
  return result.sort((a, b) => Date.parse(a.kickoffUtc) - Date.parse(b.kickoffUtc));
}
