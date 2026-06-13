import { KELLY_FRACTION, MAX_STAKE_FRACTION, buildBetPlan, type AiBetPlanPick, type BetPlanInput, type BetPlanResult } from "../betting/plan.js";
import { insertBoardAnalysis, listBoardAnalyses, listRecentAlerts, type AiBoardAnalysisRow } from "../db.js";
import { getCurrentOdds, LABELS, type CurrentOddsRow, type Label, type ThreeWay } from "../queries/currentOdds.js";
import { fmtAge, getSourceFreshness, runHealthChecks } from "../queries/healthChecks.js";
import { getMarketRadar, formatThreeWayShort, type MatchIntelligence } from "../queries/marketIntelligence.js";
import { getOfferedOddsForFixtures, resolveOfferedOdd, type OfferedOdd } from "../queries/offeredOdds.js";
import { getProbabilityCandidates } from "../queries/probabilityModel.js";
import { getSportteryEdges, SPORTTERY_EDGE_PP, SPORTTERY_MIN_BOOKS } from "../queries/sportteryAvoidance.js";
import { zhTeamName } from "../teams.js";
import { callProvider, type AiProviderOverride } from "./analyze.js";

export type BoardPromptLocale = "zh" | "en";

export const DEFAULT_BOARD_PLAN_PROMPT_EN = `You are a football odds trading research assistant. Based only on the offered odds, market consensus, prediction-market data, Sporttery differences, risk signals, and data freshness in the input, produce a betting-reference plan in English.

Hard rules:
- This is a betting simulation, not a promise of return. Do not provide account-opening, purchasing, proxy, or restriction-bypass advice.
- Reason only from the input data. Do not invent injuries, lineups, news, or odds that are not provided.
- estimated_probability must be your subjective hit-rate estimate for the outcome as a 0-1 decimal. Do not output percentage strings.
- Recommend only positive-EV outcomes where your AI estimate is roughly at least 2 percentage points above market-implied probability. Otherwise place them in watchlist or avoid.
- Recommend at most one betting direction per match.
- Do not output stake amounts. The system calculates amounts locally using 25% Kelly and the user's bankroll.

Output must be a valid JSON object, with no Markdown code fence. Keep these field names exactly for compatibility; write the text values in English:
{
  "summary_zh": "Two or three sentences summarizing the overall approach",
  "recommendations": [
    {
      "fixture_key": "must come from the input",
      "outcome": "home|draw|away",
      "platform": "prefer an offered platform from the input, such as Sporttery/Polymarket/Kalshi/Pinnacle",
      "estimated_probability": 0.42,
      "confidence": "low|medium|high",
      "reason": "plain-language reason for this direction",
      "risk": "main downside risk",
      "cancel_if": "odds/data change that would invalidate the idea"
    }
  ],
  "watchlist": [
    {"fixture_key":"must come from the input","outcome":"home|draw|away","take":"why to wait","trigger":"signal needed before considering it","risk":"current main risk"}
  ],
  "avoid": [
    {"fixture_key":"must come from the input","outcome":"home|draw|away","take":"why to avoid/no-bet","risk":"current main risk"}
  ],
  "bankroll_note": "bankroll discipline reminder, without specific amounts",
  "data_quality": "how data quality and freshness affect confidence"
}`;

export const DEFAULT_BOARD_PLAN_PROMPT_ZH = `你是一名足球赔率交易研究助理。你要基于输入里的真实可赔赔率、市场共识、预测市场、体彩差异、风险和数据新鲜度,输出一份中文投注参考计划。

硬性规则:
- 这是投注模拟,不是收益承诺;不要给代购、开户或绕过限制建议。
- 只基于输入数据推断,不要编造伤病、阵容、新闻或未给出的赔率。
- estimated_probability 必须是你对该方向命中率的主观估计,用 0-1 小数,不要输出百分号字符串。
- 只推荐正期望且 AI 估算概率至少高于市场隐含概率约 2 个百分点的方向;不够好就放到 watchlist 或 avoid。
- 同一场比赛最多推荐一个下注方向。
- 不要输出下注金额,金额由系统按 25% Kelly 和用户本金本地计算。

输出必须是合法 JSON object,不要使用 Markdown 代码块,字段:
{
  "summary_zh": "两三句话总结当前总体打法",
  "recommendations": [
    {
      "fixture_key": "必须来自输入",
      "outcome": "home|draw|away",
      "platform": "优先填写输入里的可赔平台,如 Sporttery/Polymarket/Kalshi/Pinnacle",
      "estimated_probability": 0.42,
      "confidence": "low|medium|high",
      "reason": "为什么押这个方向,用白话解释",
      "risk": "主要亏损风险",
      "cancel_if": "什么盘口/数据变化下撤销建议"
    }
  ],
  "watchlist": [
    {"fixture_key":"必须来自输入","outcome":"home|draw|away","take":"为什么先观察","trigger":"什么信号出现才考虑","risk":"当前主要风险"}
  ],
  "avoid": [
    {"fixture_key":"必须来自输入","outcome":"home|draw|away","take":"为什么不碰/避坑","risk":"当前主要风险"}
  ],
  "bankroll_note": "资金纪律提醒,不要包含具体金额",
  "data_quality": "数据质量和新鲜度如何影响信心"
}`;

export const DEFAULT_BOARD_PLAN_PROMPT = DEFAULT_BOARD_PLAN_PROMPT_EN;

export function boardPlanSystemPrompt(locale: BoardPromptLocale = "en"): string {
  return locale === "zh" ? DEFAULT_BOARD_PLAN_PROMPT_ZH : DEFAULT_BOARD_PLAN_PROMPT_EN;
}

export interface BoardPlanWatchItem {
  fixture_key: string;
  outcome: Label;
  take: string;
  trigger: string;
  risk: string;
}

export interface BoardPlanAvoidItem {
  fixture_key: string;
  outcome: Label;
  take: string;
  risk: string;
}

export interface BoardBettingVerdict {
  summary_zh: string;
  recommendations: AiBetPlanPick[];
  watchlist: BoardPlanWatchItem[];
  avoid: BoardPlanAvoidItem[];
  bankroll_note: string;
  data_quality: string;
}

export interface BoardBettingContext {
  prompt: string;
  offeredOdds: OfferedOdd[];
  rows: CurrentOddsRow[];
}

export interface BoardBettingPlanOutcome {
  id: number;
  model: string;
  verdict: BoardBettingVerdict | null;
  raw: string;
  context: BoardBettingContext;
  plan: BetPlanResult | null;
}

function pct(v: number | null | undefined): string {
  return v === null || v === undefined ? "-" : `${(v * 100).toFixed(1)}%`;
}

function pp(v: number | null | undefined): string {
  if (v === null || v === undefined) return "-";
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}pp`;
}

function promptMatch(locale: BoardPromptLocale, row: CurrentOddsRow): string {
  if (locale === "zh") return `${zhTeamName(row.homeTeam) ?? row.homeTeam} vs ${zhTeamName(row.awayTeam) ?? row.awayTeam}`;
  return `${row.homeTeam} vs ${row.awayTeam}`;
}

function threeWay(probs: ThreeWay | null): string {
  return probs ? `${pct(probs.home)} / ${pct(probs.draw)} / ${pct(probs.away)}` : "-";
}

function freshnessGroup(locale: BoardPromptLocale, group: string): string {
  if (locale === "zh") return group;
  if (group === "书商") return "books";
  if (group === "体彩") return "Sporttery";
  return group;
}

function sourceLine(locale: BoardPromptLocale, row: CurrentOddsRow): string {
  const parts =
    locale === "zh"
      ? [
          row.bookAvg ? `书商中位(${row.books}家) ${threeWay(row.bookAvg)}` : null,
          row.pinnacle ? `Pinnacle ${threeWay(row.pinnacle)}` : null,
          row.polymarket ? `Polymarket ${threeWay(row.polymarket)}` : null,
          row.kalshi ? `Kalshi ${threeWay(row.kalshi)}` : null,
          row.sporttery ? `体彩HAD ${threeWay(row.sporttery)}` : null,
        ]
      : [
          row.bookAvg ? `book median (${row.books} books) ${threeWay(row.bookAvg)}` : null,
          row.pinnacle ? `Pinnacle ${threeWay(row.pinnacle)}` : null,
          row.polymarket ? `Polymarket ${threeWay(row.polymarket)}` : null,
          row.kalshi ? `Kalshi ${threeWay(row.kalshi)}` : null,
          row.sporttery ? `Sporttery HAD ${threeWay(row.sporttery)}` : null,
        ];
  return parts.filter(Boolean).join("; ");
}

function offeredLine(locale: BoardPromptLocale, row: CurrentOddsRow, offered: OfferedOdd[]): string {
  const byFixture = offered.filter((odd) => odd.fixtureKey === row.fixtureKey);
  if (!byFixture.length) return locale === "zh" ? "可赔赔率: -" : "offered odds: -";
  const rows: string[] = [];
  for (const label of LABELS) {
    const candidates = byFixture.filter((odd) => odd.label === label);
    const priority = ["sporttery", "polymarket", "kalshi", "pinnacle"]
      .map((source) => candidates.find((odd) => odd.source === source))
      .filter((odd): odd is OfferedOdd => odd !== undefined);
    const bestBook = candidates
      .filter((odd) => !["sporttery", "polymarket", "kalshi", "pinnacle"].includes(odd.source))
      .sort((a, b) => b.decimalOdds - a.decimalOdds)[0];
    for (const odd of [...priority, bestBook].filter((odd): odd is OfferedOdd => odd !== undefined)) {
      rows.push(`${odd.platform} ${label} decimal=${odd.decimalOdds.toFixed(3)} market_p=${pct(odd.marketImpliedProbability ?? 1 / odd.decimalOdds)} basis=${odd.priceBasis}`);
    }
  }
  return `${locale === "zh" ? "可赔赔率" : "offered odds"}: ${rows.join(" | ")}`;
}

function matchRisk(match: MatchIntelligence | undefined): string {
  if (!match) return "risk=insufficient";
  return `risk=${match.riskLevel} heat=${Math.round(match.heatScore)} opportunity=${Math.round(match.opportunityScore)} divergence=${match.maxDivergencePp.toFixed(1)}pp liquidity=${match.pmLiquidity ?? "-"} active_traders=${match.pmActiveTraders24h ?? "-"}`;
}

function matchLine(locale: BoardPromptLocale, row: CurrentOddsRow, match: MatchIntelligence | undefined, offered: OfferedOdd[]): string {
  const kickoff = new Date(row.kickoffUtc).toISOString();
  if (locale === "zh") {
    return [
      `### ${row.fixtureKey}`,
      `${promptMatch(locale, row)} (${row.match}) kickoff=${kickoff} ${row.live ? "live/in-play" : "scheduled"}`,
      `三向概率(主/平/客): ${sourceLine(locale, row)}`,
      offeredLine(locale, row, offered),
      matchRisk(match),
    ].join("\n");
  }
  return [
    `### ${row.fixtureKey}`,
    `${promptMatch(locale, row)} (${row.match}) kickoff=${kickoff} ${row.live ? "live/in-play" : "scheduled"}`,
    `three-way probabilities (home/draw/away): ${sourceLine(locale, row)}`,
    offeredLine(locale, row, offered),
    matchRisk(match),
  ].join("\n");
}

function contextRows(fixtureKey?: string | null): { rows: CurrentOddsRow[]; radar: ReturnType<typeof getMarketRadar> } {
  const radar = getMarketRadar(70);
  const rows = fixtureKey ? radar.matches.map((m) => m.row).filter((row) => row.fixtureKey === fixtureKey) : radar.matches.map((m) => m.row);
  return { rows: rows.length ? rows : getCurrentOdds(70).filter((row) => !fixtureKey || row.fixtureKey === fixtureKey), radar };
}

export function buildBoardBettingContext(fixtureKey?: string | null, locale: BoardPromptLocale = "en"): BoardBettingContext {
  const { rows, radar } = contextRows(fixtureKey);
  const offeredOdds = getOfferedOddsForFixtures(rows.map((row) => row.fixtureKey));
  const matchMap = new Map(radar.matches.map((match) => [match.row.fixtureKey, match]));
  const edges = getSportteryEdges(rows, { thresholdPp: SPORTTERY_EDGE_PP, minBooks: SPORTTERY_MIN_BOOKS });
  const probabilityCandidates = getProbabilityCandidates(70, fixtureKey)
    .candidates.filter((candidate) => rows.some((row) => row.fixtureKey === candidate.fixtureKey))
    .slice(0, 12);
  const probabilityLine = probabilityCandidates
    .map(
      (c) =>
        `${c.fixtureKey} ${c.outcome} ${c.offeredOdd.platform} fair=${pct(c.fairProbability)} market=${pct(c.marketImpliedProbability)} edge=${pp(c.edgePp)} EV=${pct(c.expectedValuePct)} score=${Math.round(c.score)}`
    )
    .join("\n");
  const freshness = getSourceFreshness().map((f) => `${freshnessGroup(locale, f.group)}=${fmtAge(f.ageMs)}`).join(" · ");
  const health = runHealthChecks().counts;
  const alerts = listRecentAlerts(6).map((a) => `${a.kind}: ${a.title}`).join(" ; ") || "-";
  const scope =
    locale === "zh"
      ? fixtureKey
        ? "只为这一场生成投注参考,最多推荐一个方向。"
        : "为当前全部比赛生成投注参考,最多给 5 条建议。"
      : fixtureKey
        ? "Generate a betting-reference plan for this match only. Recommend at most one direction."
        : "Generate a betting-reference plan for all current matches. Recommend at most 5 picks.";

  if (locale === "zh") {
    const prompt = [
      `# 任务\n${scope}\n用输入里的真实可赔赔率计算 edge,不要自己发明赔率。输出 JSON。`,
      `# 资金模型提示\n系统后续会用 25% Kelly、本金 1% 单注上限和用户输入的最大日亏损上限计算金额;你只输出概率、方向和理由。`,
      `# 数据状态\nfreshness: ${freshness}\nhealth: pass=${health.pass} warn=${health.warn} fail=${health.fail}\nrecent_alerts: ${alerts}`,
      `# 体彩相对信号\n相对划算: ${edges.value.slice(0, 8).map((e) => `${e.match} ${e.outcome} ${pp(e.diffPp)}`).join("; ") || "-"}\n避坑: ${edges.avoid.slice(0, 8).map((e) => `${e.match} ${e.outcome} ${pp(e.diffPp)}`).join("; ") || "-"}`,
      `# 系统透明概率候选\n${probabilityLine || "无足够独立来源支撑的候选"}`,
      `# 当前比赛\n${rows.map((row) => matchLine(locale, row, matchMap.get(row.fixtureKey), offeredOdds)).join("\n\n") || "无可用比赛"}`,
      `# Top 市场机会(系统评分)\n${radar.opportunities.slice(0, 12).map((o) => `${o.fixtureKey} ${o.outcome} ${o.platform} score=${Math.round(o.opportunityScore)} confidence=${Math.round(o.confidenceScore)} risk=${o.riskLevel} gap=${o.maxCrossPlatformProbabilityGap.toFixed(1)}pp consensus=${formatThreeWayShort(radar.matches.find((m) => m.row.fixtureKey === o.fixtureKey)?.row.bookAvg ?? null)}`).join("\n")}`,
    ].join("\n\n");

    return { prompt, offeredOdds, rows };
  }

  const prompt = [
    `# Task\n${scope}\nCompute edge from the real offered odds in the input. Do not invent odds. Return JSON.`,
    `# Bankroll model note\nThe system will calculate amounts later using 25% Kelly, a 1% bankroll max stake per pick, and the user's max daily loss cap. You only output probability, direction, and rationale.`,
    `# Data status\nfreshness: ${freshness}\nhealth: pass=${health.pass} warn=${health.warn} fail=${health.fail}\nrecent_alerts: ${alerts}`,
    `# Sporttery relative signals\nrelative value: ${edges.value.slice(0, 8).map((e) => `${e.match} ${e.outcome} ${pp(e.diffPp)}`).join("; ") || "-"}\navoid: ${edges.avoid.slice(0, 8).map((e) => `${e.match} ${e.outcome} ${pp(e.diffPp)}`).join("; ") || "-"}`,
    `# System transparent probability candidates\n${probabilityLine || "No candidate has enough independent source support."}`,
    `# Current matches\n${rows.map((row) => matchLine(locale, row, matchMap.get(row.fixtureKey), offeredOdds)).join("\n\n") || "No available matches"}`,
    `# Top market opportunities (system score)\n${radar.opportunities.slice(0, 12).map((o) => `${o.fixtureKey} ${o.outcome} ${o.platform} score=${Math.round(o.opportunityScore)} confidence=${Math.round(o.confidenceScore)} risk=${o.riskLevel} gap=${o.maxCrossPlatformProbabilityGap.toFixed(1)}pp consensus=${formatThreeWayShort(radar.matches.find((m) => m.row.fixtureKey === o.fixtureKey)?.row.bookAvg ?? null)}`).join("\n")}`,
  ].join("\n\n");

  return { prompt, offeredOdds, rows };
}

function stripJsonFence(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

export function parseBoardVerdict(raw: string): BoardBettingVerdict | null {
  try {
    const parsed = JSON.parse(stripJsonFence(raw)) as BoardBettingVerdict;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.recommendations)) return null;
    return {
      summary_zh: String(parsed.summary_zh ?? ""),
      recommendations: (parsed.recommendations ?? []).filter((r) => LABELS.includes(r.outcome)).slice(0, 8),
      watchlist: (parsed.watchlist ?? []).filter((r) => LABELS.includes(r.outcome)).slice(0, 12),
      avoid: (parsed.avoid ?? []).filter((r) => LABELS.includes(r.outcome)).slice(0, 12),
      bankroll_note: String(parsed.bankroll_note ?? ""),
      data_quality: String(parsed.data_quality ?? ""),
    };
  } catch {
    return null;
  }
}

export function latestBoardVerdict(): { row: AiBoardAnalysisRow; verdict: BoardBettingVerdict | null } | null {
  const row = listBoardAnalyses(1)[0];
  return row ? { row, verdict: parseBoardVerdict(row.response) } : null;
}

export function buildPlanFromVerdict(verdict: BoardBettingVerdict, offeredOdds: OfferedOdd[], bankroll: number, maxDailyLoss: number): BetPlanResult {
  const inputs: BetPlanInput[] = [];
  for (const pick of verdict.recommendations) {
    const odd = resolveOfferedOdd(offeredOdds, pick.fixture_key, pick.outcome, pick.platform);
    if (!odd) continue;
    inputs.push({ ...pick, offeredOdd: odd, bucket: "bet" });
  }
  return buildBetPlan(inputs, bankroll, maxDailyLoss);
}

export async function analyzeBoardBettingPlan(args: {
  fixtureKey?: string | null;
  bankroll: number;
  maxDailyLoss: number;
  override?: AiProviderOverride;
  locale?: BoardPromptLocale;
}): Promise<BoardBettingPlanOutcome> {
  const systemPrompt = boardPlanSystemPrompt(args.locale ?? "en");
  const context = buildBoardBettingContext(args.fixtureKey, args.locale ?? "en");
  const result = await callProvider(systemPrompt, context.prompt, args.override);
  const verdict = parseBoardVerdict(result.raw);
  const storedRaw = verdict ? JSON.stringify(verdict) : result.raw;
  const id = insertBoardAnalysis(result.model, systemPrompt, context.prompt, storedRaw);
  const plan = verdict ? buildPlanFromVerdict(verdict, context.offeredOdds, args.bankroll, args.maxDailyLoss) : null;
  return { id, model: result.model, verdict, raw: storedRaw, context, plan };
}

export function planConstants(): { kellyFraction: number; maxStakeFraction: number } {
  return { kellyFraction: KELLY_FRACTION, maxStakeFraction: MAX_STAKE_FRACTION };
}
