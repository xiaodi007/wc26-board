// 赛后复盘数据层:把"列表 + 详情"需要的每场指标一次性算好,render 只负责展示。
// 复用 getCompletedOdds + getMatchEventBundle + getLineHistory(固定复盘窗口)。
// 这里也是 sourcePriority / reviewWindow / reviewJumpRows / isGoalEvent / winnerOf 的权威定义,render 从这里 import。
import { getCompletedOdds, LABELS, medianThreeWay, type CurrentOddsRow, type Label, type ThreeWay } from "./currentOdds.js";
import { getLineHistory, type SourceLineHistory } from "./lineHistory.js";
import { getMatchEventBundle, type MatchEventBundle, type MatchEventRow, type MatchResultRow } from "./matchEvents.js";

// 复盘固定窗口:开赛前 24h 到开赛后 2.5h(与盘口活跃窗口一致,完赛自然滑出)。
const REVIEW_PRE_H = 24;
const REVIEW_POST_H = 2.5;
const BOOK_EXCLUDED = new Set(["polymarket", "kalshi", "sporttery", "pinnacle"]);

export function reviewWindow(row: CurrentOddsRow): { fromTs: string; toTs: string } {
  const kickoff = Date.parse(row.kickoffUtc);
  return {
    fromTs: new Date(kickoff - REVIEW_PRE_H * 3600_000).toISOString(),
    toTs: new Date(kickoff + REVIEW_POST_H * 3600_000).toISOString(),
  };
}

export function reviewHistory(row: CurrentOddsRow): SourceLineHistory[] {
  const w = reviewWindow(row);
  return getLineHistory(row.fixtureKey, { fromTs: w.fromTs, toTs: w.toTs, bucketMinutes: 30 });
}

// 核心来源优先级:PM > Kalshi > Pinnacle > 体彩 > 其它书商。
export function sourcePriority(source: string): number {
  if (source === "polymarket") return 0;
  if (source === "kalshi") return 1;
  if (source === "pinnacle") return 2;
  if (source === "sporttery") return 3;
  return 9;
}

export interface ReviewJump {
  source: string;
  label: Label;
  deltaPp: number;
  ts: string;
}

// 全部 >=2pp 相邻跳变,按来源优先级、再按幅度排序(展示用)。
export function reviewJumpRows(history: SourceLineHistory[]): ReviewJump[] {
  return history
    .flatMap((s) => s.jumps.map((j) => ({ ...j, source: s.source })))
    .sort((a, b) => sourcePriority(a.source) - sourcePriority(b.source) || Math.abs(b.deltaPp) - Math.abs(a.deltaPp));
}

export function isGoalEvent(event: Pick<MatchEventRow, "eventType" | "detail">): boolean {
  return (event.eventType ?? "").toLowerCase() === "goal" && !/(missed|cancelled|canceled|disallowed)/i.test(event.detail ?? "");
}

export function eventEpoch(row: CurrentOddsRow, event: Pick<MatchEventRow, "minute" | "extraMinute">): number | null {
  if (event.minute === null) return null;
  const kickoff = Date.parse(row.kickoffUtc);
  if (!Number.isFinite(kickoff)) return null;
  return kickoff + (event.minute + (event.extraMinute ?? 0)) * 60_000;
}

// 赛果方向:优先比分;比分缺失则 null(无法复盘"是否押中")。
export function winnerOf(result: MatchResultRow | null): Label | null {
  if (!result || result.homeScore === null || result.awayScore === null) return null;
  if (result.homeScore > result.awayScore) return "home";
  if (result.homeScore < result.awayScore) return "away";
  return "draw";
}

export type ReviewQuality = "complete" | "odds_only" | "no_goal_events" | "insufficient" | "no_turn";

export interface PlatformReaction {
  source: string;
  firstMoveTs: string | null; // 首个 >=2pp 跳变时间
  maxDeltaPp: number; // 最大相邻跳变幅度
  finalWinnerProb: number | null; // 终值对 winner 的概率
  closeToResult: "yes" | "no" | "na"; // 终值是否把 winner 排为最高概率
}

export interface ReviewMatch {
  row: CurrentOddsRow;
  result: MatchResultRow | null;
  bundle: MatchEventBundle;
  goals: MatchEventRow[];
  winner: Label | null;
  history: SourceLineHistory[];
  topJumps: ReviewJump[]; // Top 3
  allJumps: ReviewJump[];
  keyPlatform: string | null; // 最大转折所在平台
  maxTurnPp: number; // 全场最大 |跳变|
  reaction: PlatformReaction[]; // 平台反应速度
  predictionErrorPp: number | null; // 赛前对 winner 的低估幅度 = (1 - 赛前概率)*100
  completeness: number; // 0..100 数据完整度
  quality: ReviewQuality;
  sources: string[];
}

// 某源在开赛前最后一个 bucket 的概率;若全部点都在开赛后,退回首点。
function pointBefore(series: SourceLineHistory, kickoffMs: number): ThreeWay | null {
  if (!series.points.length) return null;
  let chosen = series.points[0];
  for (const p of series.points) {
    if (Date.parse(p.ts) <= kickoffMs) chosen = p;
    else break;
  }
  return chosen.probs;
}

// 赛前参考概率:优先非 PM/Kalshi/体彩/Pinnacle 的书商中位,否则 PM → Pinnacle → Kalshi。
function preMatchProb(history: SourceLineHistory[], kickoffMs: number): ThreeWay | null {
  const bookProbs = history
    .filter((s) => !BOOK_EXCLUDED.has(s.source))
    .map((s) => pointBefore(s, kickoffMs))
    .filter((p): p is ThreeWay => p !== null);
  const bookMedian = medianThreeWay(bookProbs);
  if (bookMedian) return bookMedian;
  for (const src of ["polymarket", "pinnacle", "kalshi"]) {
    const s = history.find((h) => h.source === src);
    const p = s ? pointBefore(s, kickoffMs) : null;
    if (p) return p;
  }
  return null;
}

function reactionFor(history: SourceLineHistory[], winner: Label | null): PlatformReaction[] {
  // 只对比核心平台(PM/Kalshi/Pinnacle/体彩):个别书商各列一行会淹没"谁先反应"的看点。
  return history
    .filter((s) => sourcePriority(s.source) < 9)
    .map((s) => {
      const finalProbs = s.points.length ? s.points[s.points.length - 1].probs : null;
      const finalWinnerProb = winner && finalProbs ? finalProbs[winner] : null;
      const closeToResult: PlatformReaction["closeToResult"] =
        winner === null || !finalProbs ? "na" : LABELS.every((l) => finalProbs[winner] >= finalProbs[l]) ? "yes" : "no";
      return {
        source: s.source,
        firstMoveTs: s.jumps.length ? s.jumps[0].ts : null,
        maxDeltaPp: s.jumps.reduce((m, j) => Math.max(m, Math.abs(j.deltaPp)), 0),
        finalWinnerProb,
        closeToResult,
      };
    })
    .sort((a, b) => sourcePriority(a.source) - sourcePriority(b.source) || b.maxDeltaPp - a.maxDeltaPp);
}

// 单一主标签,按"是否可复盘"优先:数据不足 > 无明显转折 > 完整 / 无进球事件 / 赔率复盘。
function classifyQuality(args: { maxPoints: number; jumpCount: number; hasResult: boolean; goalCount: number }): ReviewQuality {
  if (args.maxPoints < 2) return "insufficient";
  if (args.jumpCount === 0) return "no_turn";
  if (!args.hasResult) return "odds_only";
  if (args.goalCount === 0) return "no_goal_events";
  return "complete";
}

export function buildReviewMatch(row: CurrentOddsRow): ReviewMatch {
  const bundle = getMatchEventBundle(row.fixtureKey);
  const history = reviewHistory(row);
  const goals = bundle.events.filter(isGoalEvent);
  const winner = winnerOf(bundle.result);
  const allJumps = reviewJumpRows(history);
  // 头条"最大转折/关键平台"优先核心源(PM/Kalshi/Pinnacle/体彩);单家书商临近封盘的停更跳变多是噪声,不当头条。
  const coreJumps = allJumps.filter((j) => sourcePriority(j.source) < 9);
  const maxJump = (coreJumps.length ? coreJumps : allJumps).reduce<ReviewJump | null>(
    (best, j) => (!best || Math.abs(j.deltaPp) > Math.abs(best.deltaPp) ? j : best),
    null
  );
  const kickoffMs = Date.parse(row.kickoffUtc);
  const pre = preMatchProb(history, kickoffMs);
  const predictionErrorPp = winner && pre ? (1 - pre[winner]) * 100 : null;
  const maxPoints = history.reduce((m, s) => Math.max(m, s.points.length), 0);
  const sources = history.map((s) => s.source);
  const completeness =
    (bundle.result ? 30 : 0) + (goals.length ? 25 : 0) + (maxPoints >= 4 ? 25 : 0) + (sources.length >= 3 ? 20 : 0);

  return {
    row,
    result: bundle.result,
    bundle,
    goals,
    winner,
    history,
    topJumps: allJumps.slice(0, 3),
    allJumps,
    keyPlatform: maxJump?.source ?? null,
    maxTurnPp: maxJump ? Math.abs(maxJump.deltaPp) : 0,
    reaction: reactionFor(history, winner),
    predictionErrorPp,
    completeness,
    quality: classifyQuality({ maxPoints, jumpCount: allJumps.length, hasResult: Boolean(bundle.result), goalCount: goals.length }),
    sources,
  };
}

export function getReviewBoard(limit = 24): ReviewMatch[] {
  return getCompletedOdds(limit).map(buildReviewMatch);
}
