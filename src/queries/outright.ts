import { db } from "../db.js";
import { normalizeTeam } from "../teams.js";

// 夺冠概率读层:PM 与 Kalshi 两个预测市场按归一队名对齐,各带 24h 变化。
// 二元 yes 价直接当概率展示(不做跨队归一:longshot 噪声留给读者,两源互证更有信息量)。

export interface OutrightRow {
  team: string; // 展示名(优先 PM 标签)
  pm: number | null;
  pmDeltaPp: number | null; // 相对 ~24h 前(数据不足 24h 时相对最早快照)
  kalshi: number | null;
  kalshiDeltaPp: number | null;
}

const latestStmt = db.prepare(
  `WITH latest AS (SELECT outcome_id, MAX(ts) AS ts FROM snapshot GROUP BY outcome_id)
   SELECT o.outcome_label AS label, s.prob_implied AS prob
   FROM market m
   JOIN outcome o ON o.market_id = m.id
   JOIN latest l ON l.outcome_id = o.id
   JOIN snapshot s ON s.outcome_id = o.id AND s.ts = l.ts
   WHERE m.source = ? AND m.market_type = 'outright_winner' AND s.prob_implied IS NOT NULL`
);

// ~24h 前的值:取 now-24h 之前最近一条;一条都没有(库龄不足)退回最早一条
const pastStmt = db.prepare(
  `SELECT o.outcome_label AS label, s.prob_implied AS prob
   FROM market m
   JOIN outcome o ON o.market_id = m.id
   JOIN snapshot s ON s.outcome_id = o.id
   WHERE m.source = ? AND m.market_type = 'outright_winner' AND s.prob_implied IS NOT NULL
     AND s.ts = COALESCE(
       (SELECT MAX(ts) FROM snapshot s2 WHERE s2.outcome_id = o.id AND s2.ts <= datetime('now', '-24 hours')),
       (SELECT MIN(ts) FROM snapshot s3 WHERE s3.outcome_id = o.id)
     )`
);

interface LabelProb {
  label: string;
  prob: number;
}

function probMap(rows: LabelProb[]): Map<string, { label: string; prob: number }> {
  const map = new Map<string, { label: string; prob: number }>();
  for (const row of rows) map.set(normalizeTeam(row.label), { label: row.label, prob: row.prob });
  return map;
}

export function getOutrightBoard(limit = 10): OutrightRow[] {
  const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 64) : 10;
  const pmNow = probMap(latestStmt.all("polymarket") as LabelProb[]);
  const pmPast = probMap(pastStmt.all("polymarket") as LabelProb[]);
  const kNow = probMap(latestStmt.all("kalshi") as LabelProb[]);
  const kPast = probMap(pastStmt.all("kalshi") as LabelProb[]);

  const keys = new Set([...pmNow.keys(), ...kNow.keys()]);
  const rows: OutrightRow[] = [];
  for (const key of keys) {
    const pm = pmNow.get(key) ?? null;
    const k = kNow.get(key) ?? null;
    const pmPrev = pmPast.get(key) ?? null;
    const kPrev = kPast.get(key) ?? null;
    rows.push({
      team: pm?.label ?? k?.label ?? key,
      pm: pm?.prob ?? null,
      pmDeltaPp: pm && pmPrev ? (pm.prob - pmPrev.prob) * 100 : null,
      kalshi: k?.prob ?? null,
      kalshiDeltaPp: k && kPrev ? (k.prob - kPrev.prob) * 100 : null,
    });
  }

  return rows
    .sort((a, b) => Math.max(b.pm ?? 0, b.kalshi ?? 0) - Math.max(a.pm ?? 0, a.kalshi ?? 0))
    .slice(0, safeLimit);
}
