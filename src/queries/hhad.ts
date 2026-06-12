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

export function getSportteryHhad(fixtureKey: string): HhadView | null {
  const rows = hhadStmt.all(fixtureKey) as RawRow[];
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
