import { db } from "../db.js";
import { getCurrentOdds, LABELS, type CurrentOddsRow, type Label, type ThreeWay } from "./currentOdds.js";
import { getLineHistory } from "./lineHistory.js";

export type RiskLevel = "low" | "watch" | "elevated" | "insufficient";
export type SuggestedAction = "watch" | "set_alert" | "be_cautious" | "not_recommended";
export type OpportunityTag =
  | "high_heat"
  | "high_liquidity"
  | "odds_divergence"
  | "ai_probability_pending"
  | "closing_soon"
  | "price_movement"
  | "beginner_friendly"
  | "high_risk"
  | "data_missing"
  | "sampled";
export type RiskSignalKey = "liquidity" | "holder_concentration" | "thin_trading" | "volatility";
export type RiskNoteKey =
  | "liquidity_missing"
  | "liquidity_thin"
  | "liquidity_watch"
  | "liquidity_deep"
  | "holder_missing"
  | "holder_dominant"
  | "holder_watch"
  | "holder_distributed"
  | "trading_missing"
  | "trading_thin"
  | "trading_watch"
  | "trading_broad"
  | "volatility_sharp"
  | "volatility_watch"
  | "volatility_contained";

export interface MarketExplanationParts {
  liquidity: number | null;
  activeTraders: number | null;
  concentration: number | null;
  divergencePp: number;
  sampled: boolean;
}

export interface AiBriefItem {
  key: "market_pulse" | "top_opportunity" | "largest_divergence" | "closing_soon" | "risk_alert";
  level: RiskLevel;
  tag: "signal" | "worth_watching" | "odds_gap" | "set_alert" | "risk_elevated" | "calm";
  count?: number;
  match?: string;
  outcomeName?: string;
  score?: number;
  gapPp?: number;
}

export interface PolymarketMarketMetric {
  fixtureKey: string;
  marketId: number;
  marketType: string;
  label: Label;
  conditionId: string | null;
  liquidity: number | null;
  liquidityClob: number | null;
  volume24h: number | null;
  volumeTotal: number | null;
  spread: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  lastTradePrice: number | null;
  holderDepthTop: number | null;
  holderConcentration: number | null;
  activeTraders24h: number | null;
  tradeCount24h: number | null;
  holdersSampled: boolean;
  tradesSampled: boolean;
  sourceUpdatedTs: string | null;
}

export interface RiskSignal {
  key: RiskSignalKey;
  level: RiskLevel;
  value: string;
  noteKey: RiskNoteKey;
  sampled?: boolean;
}

export interface MarketOpportunity {
  fixtureKey: string;
  match: string;
  homeTeam: string;
  awayTeam: string;
  kickoffUtc: string;
  live: boolean;
  marketTitle: string;
  platform: "Polymarket";
  marketType: "match_winner";
  outcome: Label;
  outcomeName: string;
  currentPrice: number | null;
  marketImpliedProbability: number | null;
  aiEstimatedProbability: number | null;
  probabilityGap: number | null;
  maxCrossPlatformProbabilityGap: number;
  volume24h: number | null;
  liquidity: number | null;
  bidAskSpread: number | null;
  activeTraders24h: number | null;
  tradeCount24h: number | null;
  topHolderDepth: number | null;
  topHolderConcentration: number | null;
  closeTime: string;
  opportunityScore: number;
  confidenceScore: number;
  heatScore: number;
  riskLevel: RiskLevel;
  tags: OpportunityTag[];
  aiExplanation: MarketExplanationParts;
  suggestedAction: SuggestedAction;
  sampled: boolean;
  metric: PolymarketMarketMetric | null;
}

export interface MatchIntelligence {
  row: CurrentOddsRow;
  pmMarkets: Record<Label, PolymarketMarketMetric | null>;
  pmLiquidity: number | null;
  pmVolume24h: number | null;
  pmAvgSpread: number | null;
  pmActiveTraders24h: number | null;
  pmTradeCount24h: number | null;
  pmTopHolderDepth: number | null;
  pmMaxHolderConcentration: number | null;
  sampled: boolean;
  maxDivergencePp: number;
  volatilityPp: number;
  heatScore: number;
  liquidityScore: number;
  participationScore: number;
  opportunityScore: number;
  confidenceScore: number;
  riskLevel: RiskLevel;
  riskSignals: RiskSignal[];
  tags: OpportunityTag[];
  aiExplanation: MarketExplanationParts;
}

export interface MarketRadarModel {
  matches: MatchIntelligence[];
  opportunities: MarketOpportunity[];
  metrics: {
    totalMarkets: number;
    pmLiquidity: number | null;
    pmVolume24h: number | null;
    pmActiveTraders24h: number | null;
    pmTopHolderDepth: number | null;
    closingSoon: number;
    oddsDivergence: number;
    aiOpportunityCount: number;
    sampledMarkets: number;
  };
  aiBrief: AiBriefItem[];
}

interface RawMetricRow {
  fixture_key: string;
  market_id: number;
  market_type: string;
  label: string;
  condition_id: string | null;
  liquidity: number | null;
  liquidity_clob: number | null;
  volume_24h: number | null;
  volume_total: number | null;
  spread: number | null;
  best_bid: number | null;
  best_ask: number | null;
  last_trade_price: number | null;
  holder_depth_top: number | null;
  holder_concentration: number | null;
  active_traders_24h: number | null;
  trade_count_24h: number | null;
  holders_sampled: number | null;
  trades_sampled: number | null;
  source_updated_ts: string | null;
}

const pmMetricsStmt = db.prepare(
  `WITH latest_metric AS (
     SELECT market_id, MAX(ts) AS ts
     FROM market_metric_snapshot
     GROUP BY market_id
   ),
   latest_snapshot AS (
     SELECT outcome_id, MAX(ts) AS ts
     FROM snapshot
     GROUP BY outcome_id
   )
   SELECT e.fixture_key AS fixture_key,
          m.id AS market_id,
          m.market_type AS market_type,
          o.outcome_label AS label,
          COALESCE(mm.condition_id, m.condition_id) AS condition_id,
          COALESCE(mm.liquidity, mm.liquidity_clob) AS liquidity,
          mm.liquidity_clob AS liquidity_clob,
          COALESCE(mm.volume_24h, s.volume) AS volume_24h,
          mm.volume_total AS volume_total,
          COALESCE(mm.spread, CASE WHEN s.ask IS NOT NULL AND s.bid IS NOT NULL THEN s.ask - s.bid END) AS spread,
          COALESCE(mm.best_bid, s.bid) AS best_bid,
          COALESCE(mm.best_ask, s.ask) AS best_ask,
          COALESCE(mm.last_trade_price, s.prob_implied) AS last_trade_price,
          mm.holder_depth_top AS holder_depth_top,
          mm.holder_concentration AS holder_concentration,
          mm.active_traders_24h AS active_traders_24h,
          mm.trade_count_24h AS trade_count_24h,
          mm.holders_sampled AS holders_sampled,
          mm.trades_sampled AS trades_sampled,
          COALESCE(mm.source_updated_ts, s.source_updated_ts) AS source_updated_ts
   FROM market m
   JOIN event e ON e.id = m.event_id
   JOIN outcome o ON o.market_id = m.id
   LEFT JOIN latest_metric lm ON lm.market_id = m.id
   LEFT JOIN market_metric_snapshot mm ON mm.market_id = m.id AND mm.ts = lm.ts
   LEFT JOIN latest_snapshot ls ON ls.outcome_id = o.id
   LEFT JOIN snapshot s ON s.outcome_id = o.id AND s.ts = ls.ts
   WHERE m.source = 'polymarket'
     AND m.market_type IN ('home_win_binary', 'draw_binary', 'away_win_binary')
     AND o.outcome_label IN ('home', 'draw', 'away')`
);

function toMetric(row: RawMetricRow): PolymarketMarketMetric | null {
  if (!LABELS.includes(row.label as Label)) return null;
  return {
    fixtureKey: row.fixture_key,
    marketId: row.market_id,
    marketType: row.market_type,
    label: row.label as Label,
    conditionId: row.condition_id,
    liquidity: row.liquidity,
    liquidityClob: row.liquidity_clob,
    volume24h: row.volume_24h,
    volumeTotal: row.volume_total,
    spread: row.spread,
    bestBid: row.best_bid,
    bestAsk: row.best_ask,
    lastTradePrice: row.last_trade_price,
    holderDepthTop: row.holder_depth_top,
    holderConcentration: row.holder_concentration,
    activeTraders24h: row.active_traders_24h,
    tradeCount24h: row.trade_count_24h,
    holdersSampled: row.holders_sampled === 1,
    tradesSampled: row.trades_sampled === 1,
    sourceUpdatedTs: row.source_updated_ts,
  };
}

function getPolymarketMetricMap(): Map<string, Record<Label, PolymarketMarketMetric | null>> {
  const map = new Map<string, Record<Label, PolymarketMarketMetric | null>>();
  for (const raw of pmMetricsStmt.all() as RawMetricRow[]) {
    const metric = toMetric(raw);
    if (!metric) continue;
    const group = map.get(metric.fixtureKey) ?? { home: null, draw: null, away: null };
    group[metric.label] = metric;
    map.set(metric.fixtureKey, group);
  }
  return map;
}

function sum(values: (number | null | undefined)[]): number | null {
  const present = values.filter((v): v is number => Number.isFinite(v));
  return present.length ? present.reduce((acc, v) => acc + v, 0) : null;
}

function avg(values: (number | null | undefined)[]): number | null {
  const present = values.filter((v): v is number => Number.isFinite(v));
  return present.length ? present.reduce((acc, v) => acc + v, 0) / present.length : null;
}

function max(values: (number | null | undefined)[]): number | null {
  const present = values.filter((v): v is number => Number.isFinite(v));
  return present.length ? Math.max(...present) : null;
}

function clamp(v: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, v));
}

function scoreLog(v: number | null, scale: number): number {
  if (v === null || v <= 0) return 0;
  return clamp((Math.log10(1 + v) / Math.log10(1 + scale)) * 100);
}

function spreadScore(spread: number | null): number {
  if (spread === null) return 35;
  if (spread <= 0.01) return 100;
  if (spread <= 0.02) return 85;
  if (spread <= 0.04) return 60;
  if (spread <= 0.08) return 35;
  return 15;
}

function riskWeight(level: RiskLevel): number {
  if (level === "elevated") return 3;
  if (level === "watch") return 2;
  if (level === "insufficient") return 1;
  return 0;
}

function worstRisk(signals: RiskSignal[]): RiskLevel {
  return signals.reduce<RiskLevel>((worst, signal) => (riskWeight(signal.level) > riskWeight(worst) ? signal.level : worst), "low");
}

function riskText(level: RiskLevel): string {
  if (level === "elevated") return "Risk elevated";
  if (level === "watch") return "Worth watching";
  if (level === "insufficient") return "Data insufficient";
  return "Low friction";
}

function labelName(label: Label, row: CurrentOddsRow): string {
  if (label === "home") return row.homeTeam;
  if (label === "away") return row.awayTeam;
  return "Draw";
}

function mainSourceValuesForLabel(row: CurrentOddsRow, label: Label): number[] {
  return [row.bookAvg?.[label], row.polymarket?.[label], row.kalshi?.[label], row.pinnacle?.[label], row.sporttery?.[label]].filter((v): v is number =>
    Number.isFinite(v)
  );
}

function maxDivergenceForLabel(row: CurrentOddsRow, label: Label): number {
  const values = mainSourceValuesForLabel(row, label);
  if (values.length < 2) return 0;
  return (Math.max(...values) - Math.min(...values)) * 100;
}

function maxDivergence(row: CurrentOddsRow): number {
  return Math.max(...LABELS.map((label) => maxDivergenceForLabel(row, label)));
}

function volatilityPp(fixtureKey: string): number {
  const history = getLineHistory(fixtureKey, { hours: 24, bucketMinutes: 30, sources: ["polymarket"], jumpPp: 2 });
  let maxMove = 0;
  for (const source of history) {
    for (const label of LABELS) {
      const values = source.points.map((p) => p.probs[label]);
      if (values.length >= 2) maxMove = Math.max(maxMove, Math.abs(values[values.length - 1] - values[0]) * 100);
    }
    for (const jump of source.jumps) maxMove = Math.max(maxMove, Math.abs(jump.deltaPp));
  }
  return maxMove;
}

function liquidityRisk(liquidity: number | null, spread: number | null): RiskSignal {
  if (liquidity === null) {
    return { key: "liquidity", level: "insufficient", value: "-", noteKey: "liquidity_missing" };
  }
  if (liquidity < 25_000 || (spread !== null && spread > 0.08)) {
    return { key: "liquidity", level: "elevated", value: compactMoney(liquidity), noteKey: "liquidity_thin" };
  }
  if (liquidity < 100_000 || (spread !== null && spread > 0.04)) {
    return { key: "liquidity", level: "watch", value: compactMoney(liquidity), noteKey: "liquidity_watch" };
  }
  return { key: "liquidity", level: "low", value: compactMoney(liquidity), noteKey: "liquidity_deep" };
}

function concentrationRisk(concentration: number | null, holderDepth: number | null): RiskSignal {
  if (concentration === null || holderDepth === null) {
    return { key: "holder_concentration", level: "insufficient", value: "-", noteKey: "holder_missing" };
  }
  if (concentration >= 0.55) {
    return { key: "holder_concentration", level: "elevated", value: percent(concentration), noteKey: "holder_dominant" };
  }
  if (concentration >= 0.35 || holderDepth < 10) {
    return { key: "holder_concentration", level: "watch", value: percent(concentration), noteKey: "holder_watch" };
  }
  return { key: "holder_concentration", level: "low", value: percent(concentration), noteKey: "holder_distributed" };
}

function thinTradingRisk(activeTraders: number | null, tradeCount: number | null, sampled: boolean): RiskSignal {
  if (activeTraders === null || tradeCount === null) {
    return { key: "thin_trading", level: "insufficient", value: "-", noteKey: "trading_missing" };
  }
  if (activeTraders < 8 || tradeCount < 12) {
    return { key: "thin_trading", level: "elevated", value: String(activeTraders), noteKey: "trading_thin", sampled };
  }
  if (activeTraders < 25 || tradeCount < 40) {
    return { key: "thin_trading", level: "watch", value: String(activeTraders), noteKey: "trading_watch", sampled };
  }
  return { key: "thin_trading", level: "low", value: String(activeTraders), noteKey: "trading_broad", sampled };
}

function volatilityRisk(volatility: number): RiskSignal {
  if (volatility >= 5) return { key: "volatility", level: "elevated", value: `${volatility.toFixed(1)}pp`, noteKey: "volatility_sharp" };
  if (volatility >= 2) return { key: "volatility", level: "watch", value: `${volatility.toFixed(1)}pp`, noteKey: "volatility_watch" };
  return { key: "volatility", level: "low", value: `${volatility.toFixed(1)}pp`, noteKey: "volatility_contained" };
}

function buildRiskSignals(match: {
  liquidity: number | null;
  spread: number | null;
  holderConcentration: number | null;
  holderDepth: number | null;
  activeTraders: number | null;
  tradeCount: number | null;
  sampled: boolean;
  volatility: number;
}): RiskSignal[] {
  return [
    liquidityRisk(match.liquidity, match.spread),
    concentrationRisk(match.holderConcentration, match.holderDepth),
    thinTradingRisk(match.activeTraders, match.tradeCount, match.sampled),
    volatilityRisk(match.volatility),
  ];
}

function tagsFor(args: {
  heatScore: number;
  liquidityScore: number;
  maxDivergencePp: number;
  volatilityPp: number;
  closeHours: number;
  riskLevel: RiskLevel;
  missing: boolean;
  sampled: boolean;
}): OpportunityTag[] {
  const tags: OpportunityTag[] = [];
  if (args.heatScore >= 70) tags.push("high_heat");
  if (args.liquidityScore >= 70) tags.push("high_liquidity");
  if (args.maxDivergencePp >= 3) tags.push("odds_divergence");
  if (args.closeHours <= 24) tags.push("closing_soon");
  if (args.volatilityPp >= 2) tags.push("price_movement");
  if (args.riskLevel === "low" && args.liquidityScore >= 60) tags.push("beginner_friendly");
  if (args.riskLevel === "elevated") tags.push("high_risk");
  if (args.missing) tags.push("data_missing");
  if (args.sampled) tags.push("sampled");
  return [...new Set(tags)];
}

function actionFor(riskLevel: RiskLevel, score: number, closeHours: number): SuggestedAction {
  if (riskLevel === "elevated" && score < 45) return "not_recommended";
  if (riskLevel === "elevated") return "be_cautious";
  if (score >= 70 || closeHours <= 24) return "set_alert";
  return "watch";
}

function buildExplanation(parts: {
  liquidity: number | null;
  activeTraders: number | null;
  concentration: number | null;
  divergence: number;
  sampled: boolean;
}): MarketExplanationParts {
  return {
    liquidity: parts.liquidity,
    activeTraders: parts.activeTraders,
    concentration: parts.concentration,
    divergencePp: parts.divergence,
    sampled: parts.sampled,
  };
}

function buildMatch(row: CurrentOddsRow, pmMarkets: Record<Label, PolymarketMarketMetric | null>): MatchIntelligence {
  const metrics = LABELS.map((label) => pmMarkets[label]).filter((m): m is PolymarketMarketMetric => m !== null);
  const pmLiquidity = sum(metrics.map((m) => m.liquidity));
  const pmVolume24h = sum(metrics.map((m) => m.volume24h));
  const pmAvgSpread = avg(metrics.map((m) => m.spread));
  const pmActiveTraders24h = sum(metrics.map((m) => m.activeTraders24h));
  const pmTradeCount24h = sum(metrics.map((m) => m.tradeCount24h));
  const pmTopHolderDepth = sum(metrics.map((m) => m.holderDepthTop));
  const pmMaxHolderConcentration = max(metrics.map((m) => m.holderConcentration));
  const sampled = metrics.some((m) => m.holdersSampled || m.tradesSampled);
  const divergence = maxDivergence(row);
  const volatility = volatilityPp(row.fixtureKey);
  const liquidityScore = (scoreLog(pmLiquidity, 2_000_000) * 0.75 + spreadScore(pmAvgSpread) * 0.25);
  const participationScore = scoreLog(pmActiveTraders24h, 400) * 0.7 + scoreLog(pmTopHolderDepth, 120) * 0.3;
  const divergenceScore = clamp((divergence / 8) * 100);
  const volatilityScore = clamp((volatility / 6) * 100);
  const heatScore = clamp(liquidityScore * 0.3 + scoreLog(pmVolume24h, 500_000) * 0.25 + participationScore * 0.25 + volatilityScore * 0.2);
  const riskSignals = buildRiskSignals({
    liquidity: pmLiquidity,
    spread: pmAvgSpread,
    holderConcentration: pmMaxHolderConcentration,
    holderDepth: pmTopHolderDepth,
    activeTraders: pmActiveTraders24h,
    tradeCount: pmTradeCount24h,
    sampled,
    volatility,
  });
  const riskLevel = worstRisk(riskSignals);
  const riskPenalty = riskLevel === "elevated" ? 22 : riskLevel === "watch" ? 10 : riskLevel === "insufficient" ? 8 : 0;
  const opportunityScore = clamp(heatScore * 0.45 + liquidityScore * 0.25 + divergenceScore * 0.25 + participationScore * 0.05 - riskPenalty);
  const confidenceScore = clamp(liquidityScore * 0.35 + participationScore * 0.25 + (100 - riskPenalty * 3) * 0.25 + (row.books >= 5 ? 100 : row.books * 18) * 0.15);
  const closeHours = (Date.parse(row.kickoffUtc) - Date.now()) / 3600_000;
  const missing = pmLiquidity === null || pmActiveTraders24h === null || pmTopHolderDepth === null;

  return {
    row,
    pmMarkets,
    pmLiquidity,
    pmVolume24h,
    pmAvgSpread,
    pmActiveTraders24h,
    pmTradeCount24h,
    pmTopHolderDepth,
    pmMaxHolderConcentration,
    sampled,
    maxDivergencePp: divergence,
    volatilityPp: volatility,
    heatScore,
    liquidityScore,
    participationScore,
    opportunityScore,
    confidenceScore,
    riskLevel,
    riskSignals,
    tags: tagsFor({ heatScore, liquidityScore, maxDivergencePp: divergence, volatilityPp: volatility, closeHours, riskLevel, missing, sampled }),
    aiExplanation: buildExplanation({ liquidity: pmLiquidity, activeTraders: pmActiveTraders24h, concentration: pmMaxHolderConcentration, divergence, sampled }),
  };
}

function opportunityFor(match: MatchIntelligence, label: Label): MarketOpportunity {
  const row = match.row;
  const metric = match.pmMarkets[label];
  const closeHours = (Date.parse(row.kickoffUtc) - Date.now()) / 3600_000;
  const divergence = maxDivergenceForLabel(row, label);
  const liquidity = metric?.liquidity ?? null;
  const spread = metric?.spread ?? null;
  const activeTraders = metric?.activeTraders24h ?? null;
  const holderDepth = metric?.holderDepthTop ?? null;
  const concentration = metric?.holderConcentration ?? null;
  const sampled = Boolean(metric?.holdersSampled || metric?.tradesSampled);
  const liquidityScore = scoreLog(liquidity, 1_000_000) * 0.75 + spreadScore(spread) * 0.25;
  const participationScore = scoreLog(activeTraders, 150) * 0.7 + scoreLog(holderDepth, 40) * 0.3;
  const riskSignals = buildRiskSignals({
    liquidity,
    spread,
    holderConcentration: concentration,
    holderDepth,
    activeTraders,
    tradeCount: metric?.tradeCount24h ?? null,
    sampled,
    volatility: match.volatilityPp,
  });
  const riskLevel = worstRisk(riskSignals);
  const divergenceScore = clamp((divergence / 8) * 100);
  const probabilityGap = row.bookAvg && row.polymarket ? (row.polymarket[label] - row.bookAvg[label]) * 100 : null;
  const gapScore = probabilityGap === null ? 0 : clamp((Math.abs(probabilityGap) / 6) * 100);
  const riskPenalty = riskLevel === "elevated" ? 22 : riskLevel === "watch" ? 10 : riskLevel === "insufficient" ? 8 : 0;
  const opportunityScore = clamp(match.heatScore * 0.25 + liquidityScore * 0.3 + divergenceScore * 0.25 + gapScore * 0.2 - riskPenalty);
  const confidenceScore = clamp(liquidityScore * 0.35 + participationScore * 0.25 + (row.books >= 5 ? 100 : row.books * 18) * 0.2 + (100 - riskPenalty * 3) * 0.2);
  const marketImpliedProbability = row.polymarket?.[label] ?? null;
  const currentPrice = metric?.lastTradePrice ?? marketImpliedProbability;
  const missing = liquidity === null || activeTraders === null || holderDepth === null;
  const tags = tagsFor({
    heatScore: match.heatScore,
    liquidityScore,
    maxDivergencePp: divergence,
    volatilityPp: match.volatilityPp,
    closeHours,
    riskLevel,
    missing,
    sampled,
  });

  return {
    fixtureKey: row.fixtureKey,
    match: row.match,
    homeTeam: row.homeTeam,
    awayTeam: row.awayTeam,
    kickoffUtc: row.kickoffUtc,
    live: row.live,
    marketTitle: "match_winner",
    platform: "Polymarket",
    marketType: "match_winner",
    outcome: label,
    outcomeName: labelName(label, row),
    currentPrice,
    marketImpliedProbability,
    aiEstimatedProbability: null,
    probabilityGap,
    maxCrossPlatformProbabilityGap: divergence,
    volume24h: metric?.volume24h ?? null,
    liquidity,
    bidAskSpread: spread,
    activeTraders24h: activeTraders,
    tradeCount24h: metric?.tradeCount24h ?? null,
    topHolderDepth: holderDepth,
    topHolderConcentration: concentration,
    closeTime: row.kickoffUtc,
    opportunityScore,
    confidenceScore,
    heatScore: match.heatScore,
    riskLevel,
    tags,
    aiExplanation: buildExplanation({ liquidity, activeTraders, concentration, divergence, sampled }),
    suggestedAction: actionFor(riskLevel, opportunityScore, closeHours),
    sampled,
    metric,
  };
}

function brief(matches: MatchIntelligence[], opportunities: MarketOpportunity[]): MarketRadarModel["aiBrief"] {
  const top = opportunities[0];
  const largestGap = opportunities.reduce<MarketOpportunity | null>(
    (best, row) => (!best || row.maxCrossPlatformProbabilityGap > best.maxCrossPlatformProbabilityGap ? row : best),
    null
  );
  const closing = matches.filter((m) => {
    const h = (Date.parse(m.row.kickoffUtc) - Date.now()) / 3600_000;
    return h >= 0 && h <= 24;
  }).length;
  const elevated = matches.filter((m) => m.riskLevel === "elevated").length;
  return [
    {
      key: "market_pulse",
      count: matches.filter((m) => m.heatScore >= 70).length,
      tag: "signal",
      level: "low",
    },
    {
      key: "top_opportunity",
      match: top?.match,
      outcomeName: top?.outcomeName,
      score: top ? Math.round(top.opportunityScore) : undefined,
      tag: "worth_watching",
      level: top?.riskLevel ?? "insufficient",
    },
    {
      key: "largest_divergence",
      match: largestGap?.match,
      gapPp: largestGap?.maxCrossPlatformProbabilityGap,
      tag: "odds_gap",
      level: largestGap && largestGap.maxCrossPlatformProbabilityGap >= 4 ? "watch" : "low",
    },
    {
      key: "closing_soon",
      count: closing,
      tag: "set_alert",
      level: closing ? "watch" : "low",
    },
    {
      key: "risk_alert",
      count: elevated,
      tag: elevated ? "risk_elevated" : "calm",
      level: elevated ? "elevated" : "low",
    },
  ];
}

export function getMarketRadar(limit = 70): MarketRadarModel {
  const current = getCurrentOdds(limit);
  const pmMetricMap = getPolymarketMetricMap();
  const matches = current.map((row) => buildMatch(row, pmMetricMap.get(row.fixtureKey) ?? { home: null, draw: null, away: null }));
  const opportunities = matches
    .flatMap((match) => LABELS.map((label) => opportunityFor(match, label)))
    .sort((a, b) => b.opportunityScore - a.opportunityScore);
  const metrics = {
    totalMarkets: opportunities.length,
    pmLiquidity: sum(matches.map((m) => m.pmLiquidity)),
    pmVolume24h: sum(matches.map((m) => m.pmVolume24h)),
    pmActiveTraders24h: sum(matches.map((m) => m.pmActiveTraders24h)),
    pmTopHolderDepth: sum(matches.map((m) => m.pmTopHolderDepth)),
    closingSoon: matches.filter((m) => {
      const h = (Date.parse(m.row.kickoffUtc) - Date.now()) / 3600_000;
      return h >= 0 && h <= 24;
    }).length,
    oddsDivergence: opportunities.filter((o) => o.maxCrossPlatformProbabilityGap >= 3).length,
    aiOpportunityCount: opportunities.filter((o) => o.opportunityScore >= 70).length,
    sampledMarkets: opportunities.filter((o) => o.sampled).length,
  };
  return { matches, opportunities, metrics, aiBrief: brief(matches, opportunities) };
}

export function getMatchIntelligence(fixtureKey: string): MatchIntelligence | null {
  return getMarketRadar(70).matches.find((m) => m.row.fixtureKey === fixtureKey) ?? null;
}

export function percent(v: number | null | undefined, digits = 1): string {
  return v === null || v === undefined ? "-" : `${(v * 100).toFixed(digits)}%`;
}

export function compactNumber(v: number | null | undefined): string {
  if (v === null || v === undefined) return "-";
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return String(Math.round(v));
}

export function compactMoney(v: number | null | undefined): string {
  const raw = compactNumber(v);
  return raw === "-" ? raw : `$${raw}`;
}

export function riskLabel(level: RiskLevel): string {
  return riskText(level);
}

export function formatThreeWayShort(probs: ThreeWay | null): string {
  if (!probs) return "-";
  return LABELS.map((label) => percent(probs[label], 0)).join(" / ");
}
