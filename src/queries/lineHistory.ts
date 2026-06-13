import { db } from "../db.js";
import { LABELS, normalizeThreeWay, type Label, type ThreeWay } from "./currentOdds.js";

// 单场概率时序:按 bucket 降采样(默认 30min),逐源三向归一。
// snapshot 是 5min 级原始数据,读取层永远不直接吐全量。

export interface HistoryPoint {
  ts: string; // bucket 起点 ISO
  probs: ThreeWay;
}

export interface JumpMark {
  ts: string;
  label: Label;
  deltaPp: number; // 相邻 bucket 变化,百分点
}

export interface SourceLineHistory {
  source: string;
  points: HistoryPoint[];
  jumps: JumpMark[];
}

export interface LineHistoryOptions {
  hours?: number; // 回看窗口,默认 24
  bucketMinutes?: number; // 降采样粒度,默认 30
  jumpPp?: number; // 突变阈值(百分点),默认 2
  sources?: string[]; // 默认全部
  fromTs?: string; // 固定窗口起点 ISO;优先于 hours
  toTs?: string; // 固定窗口终点 ISO
}

const MATCH_TYPES = "('1x2','home_win_binary','draw_binary','away_win_binary','sporttery_had')";

const historyStmt = db.prepare(
  `SELECT m.source AS source, o.outcome_label AS label,
          (CAST(strftime('%s', s.ts) AS INTEGER) / ?) * ? AS bucket_epoch,
          AVG(s.prob_implied) AS prob
   FROM snapshot s
   JOIN outcome o ON o.id = s.outcome_id
   JOIN market m ON m.id = o.market_id
   JOIN event e ON e.id = m.event_id
     WHERE e.fixture_key = ?
       AND o.outcome_label IN ('home', 'draw', 'away')
       AND m.market_type IN ${MATCH_TYPES}
       AND s.prob_implied IS NOT NULL
       AND s.ts >= ?
       AND s.ts <= ?
   GROUP BY m.source, o.outcome_label, bucket_epoch
   ORDER BY bucket_epoch`
);

interface RawRow {
  source: string;
  label: string;
  bucket_epoch: number;
  prob: number;
}

export function getLineHistory(fixtureKey: string, options: LineHistoryOptions = {}): SourceLineHistory[] {
  const hours = Number.isFinite(options.hours) && Number(options.hours) > 0 ? Math.min(Number(options.hours), 24 * 14) : 24;
  const bucketMinutes =
    Number.isInteger(options.bucketMinutes) && Number(options.bucketMinutes) > 0 ? Math.min(Number(options.bucketMinutes), 24 * 60) : 30;
  const jumpPp = Number.isFinite(options.jumpPp) && Number(options.jumpPp) > 0 ? Number(options.jumpPp) : 2;
  const bucketSec = bucketMinutes * 60;
  const fromTs = options.fromTs ?? new Date(Date.now() - hours * 3600_000).toISOString();
  const toTs = options.toTs ?? new Date().toISOString();

  const raw = historyStmt.all(bucketSec, bucketSec, fixtureKey, fromTs, toTs) as RawRow[];

  // source → bucket_epoch → partial ThreeWay
  const bySource = new Map<string, Map<number, Partial<ThreeWay>>>();
  for (const row of raw) {
    if (!LABELS.includes(row.label as Label)) continue;
    if (options.sources && !options.sources.includes(row.source)) continue;
    const buckets = bySource.get(row.source) ?? new Map<number, Partial<ThreeWay>>();
    const probs = buckets.get(row.bucket_epoch) ?? {};
    probs[row.label as Label] = row.prob;
    buckets.set(row.bucket_epoch, probs);
    bySource.set(row.source, buckets);
  }

  const result: SourceLineHistory[] = [];
  for (const [source, buckets] of bySource) {
    const points: HistoryPoint[] = [];
    for (const [epoch, partial] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
      const probs = normalizeThreeWay(partial); // 三向不齐的 bucket 丢弃(半截数据会画出假跳动)
      if (!probs) continue;
      points.push({ ts: new Date(epoch * 1000).toISOString(), probs });
    }

    const jumps: JumpMark[] = [];
    for (let i = 1; i < points.length; i++) {
      for (const label of LABELS) {
        const deltaPp = (points[i].probs[label] - points[i - 1].probs[label]) * 100;
        if (Math.abs(deltaPp) >= jumpPp) jumps.push({ ts: points[i].ts, label, deltaPp });
      }
    }
    result.push({ source, points, jumps });
  }

  return result.sort((a, b) => a.source.localeCompare(b.source));
}
