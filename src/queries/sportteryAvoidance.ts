import { getCurrentOdds, LABELS, type CurrentOddsRow, type Label } from "./currentOdds.js";

// 体彩 vs 国际共识的判定门槛,全仓库共用一处(实测单家书商会出现 ±37pp 离群,故用中位数 + >=5 家)。
export const SPORTTERY_EDGE_PP = 2;
export const SPORTTERY_MIN_BOOKS = 5;

export interface SportteryAvoidanceRow {
  kickoffUtc: string;
  match: string;
  outcome: string;
  sporttery: number;
  bookAvg: number;
  diffPp: number;
  books: number;
  note: string;
}

// 双向价差视图:avoid = 体彩隐含概率显著高于国际共识(回报相对差);
// value = 显著低于(体彩赔率相对国际盘偏高)。都是相对信号,不是建议。
export interface SportteryEdges {
  avoid: SportteryAvoidanceRow[];
  value: SportteryAvoidanceRow[];
}

export function getSportteryEdges(
  fixtures: CurrentOddsRow[],
  options: { thresholdPp?: number; minBooks?: number } = {}
): SportteryEdges {
  const thresholdPp = Number.isFinite(options.thresholdPp) ? Number(options.thresholdPp) : SPORTTERY_EDGE_PP;
  const minBooks = Number.isInteger(options.minBooks) && Number(options.minBooks) > 0 ? Number(options.minBooks) : SPORTTERY_MIN_BOOKS;

  const avoid: SportteryAvoidanceRow[] = [];
  const value: SportteryAvoidanceRow[] = [];
  for (const fixture of fixtures) {
    if (fixture.live) continue; // 体彩赛前停售,盘中 diff 无决策意义
    if (!fixture.sporttery || !fixture.bookAvg || fixture.books < minBooks) continue;
    for (const label of LABELS) {
      const sporttery = fixture.sporttery[label];
      const bookAvg = fixture.bookAvg[label];
      const diffPp = (sporttery - bookAvg) * 100;
      if (Math.abs(diffPp) < thresholdPp) continue;
      const row: SportteryAvoidanceRow = {
        kickoffUtc: fixture.kickoffUtc,
        match: fixture.match,
        outcome: outcomeName(label, fixture.homeTeam, fixture.awayTeam),
        sporttery,
        bookAvg,
        diffPp,
        books: fixture.books,
        note: diffPp > 0 ? "体彩隐含概率偏高,回报相对不划算" : "体彩隐含概率偏低,赔率相对国际盘偏高",
      };
      (diffPp > 0 ? avoid : value).push(row);
    }
  }
  avoid.sort((a, b) => b.diffPp - a.diffPp);
  value.sort((a, b) => a.diffPp - b.diffPp);
  return { avoid, value };
}

export interface SportteryAvoidanceOptions {
  outputLimit?: number;
  scanLimit?: number;
  thresholdPp?: number;
  minBooks?: number;
}

function outcomeName(label: Label, homeTeam: string, awayTeam: string): string {
  if (label === "home") return homeTeam;
  if (label === "away") return awayTeam;
  return "draw";
}

export function getSportteryAvoidance(options: SportteryAvoidanceOptions = {}): SportteryAvoidanceRow[] {
  const outputLimit = Number.isInteger(options.outputLimit) && Number(options.outputLimit) > 0
    ? Math.min(Number(options.outputLimit), 100)
    : 20;
  const scanLimit = Number.isInteger(options.scanLimit) && Number(options.scanLimit) > 0
    ? Math.min(Number(options.scanLimit), 50)
    : 50;
  const thresholdPp = Number.isFinite(options.thresholdPp) ? Number(options.thresholdPp) : SPORTTERY_EDGE_PP;
  const minBooks = Number.isInteger(options.minBooks) && Number(options.minBooks) > 0 ? Number(options.minBooks) : SPORTTERY_MIN_BOOKS;

  return getSportteryEdges(getCurrentOdds(scanLimit), { thresholdPp, minBooks }).avoid.slice(0, outputLimit);
}
