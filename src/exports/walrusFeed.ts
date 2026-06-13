import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { WALRUS_FEED_DIR, WALRUS_NETWORK } from "../config.js";
import { getSourceFreshness } from "../queries/healthChecks.js";
import {
  getMarketRadar,
  type MarketOpportunity,
  type MatchIntelligence,
  type PolymarketMarketMetric,
} from "../queries/marketIntelligence.js";
import { LABELS, type Label } from "../queries/currentOdds.js";

export const WALRUS_SCHEMA_VERSION = "wc26.market_radar.v1";

export interface WalrusArtifact {
  name: string;
  relativePath: string;
  path: string;
  contentType: "application/json";
  bytes: number;
  sha256: string;
}

export interface WalrusManifestArtifact {
  name: string;
  relativePath: string;
  contentType: "application/json";
  bytes: number;
  sha256: string;
}

export interface WalrusExportManifest {
  schema_version: string;
  generated_at: string;
  network: string;
  data_policy: {
    public_snapshot: true;
    aggregate_only: true;
    raw_wallet_addresses: false;
    api_keys_or_secrets: false;
    full_sqlite_database: false;
  };
  sampled_flags: {
    any_sampled: boolean;
    sampled_markets: number;
  };
  artifacts: WalrusManifestArtifact[];
}

export interface WalrusExportResult {
  outDir: string;
  manifest: WalrusExportManifest;
  manifestPath: string;
  artifacts: WalrusArtifact[];
}

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function sha256(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function writeJson(outDir: string, relativePath: string, data: unknown): WalrusArtifact {
  const path = join(outDir, relativePath);
  ensureDir(dirname(path));
  const raw = `${JSON.stringify(data, null, 2)}\n`;
  writeFileSync(path, raw, "utf8");
  return {
    name: relativePath.replace(/\.json$/, ""),
    relativePath,
    path,
    contentType: "application/json",
    bytes: Buffer.byteLength(raw),
    sha256: sha256(raw),
  };
}

export function publicArtifact(artifact: WalrusArtifact): WalrusManifestArtifact {
  return {
    name: artifact.name,
    relativePath: artifact.relativePath,
    contentType: artifact.contentType,
    bytes: artifact.bytes,
    sha256: artifact.sha256,
  };
}

function metric(metric: PolymarketMarketMetric | null): Record<string, unknown> | null {
  if (!metric) return null;
  return {
    label: metric.label,
    market_type: metric.marketType,
    condition_id: metric.conditionId,
    liquidity: metric.liquidity,
    liquidity_clob: metric.liquidityClob,
    volume_24h: metric.volume24h,
    volume_total: metric.volumeTotal,
    spread: metric.spread,
    best_bid: metric.bestBid,
    best_ask: metric.bestAsk,
    last_trade_price: metric.lastTradePrice,
    top_holder_depth: metric.holderDepthTop,
    top_holder_concentration: metric.holderConcentration,
    active_traders_24h: metric.activeTraders24h,
    trade_count_24h: metric.tradeCount24h,
    holders_sampled: metric.holdersSampled,
    trades_sampled: metric.tradesSampled,
    source_updated_ts: metric.sourceUpdatedTs,
  };
}

function markets(match: MatchIntelligence): Record<Label, Record<string, unknown> | null> {
  return {
    home: metric(match.pmMarkets.home),
    draw: metric(match.pmMarkets.draw),
    away: metric(match.pmMarkets.away),
  };
}

function matchSummary(match: MatchIntelligence): Record<string, unknown> {
  return {
    fixture_key: match.row.fixtureKey,
    home_team: match.row.homeTeam,
    away_team: match.row.awayTeam,
    kickoff_utc: match.row.kickoffUtc,
    live: match.row.live,
    pm_liquidity: match.pmLiquidity,
    pm_volume_24h: match.pmVolume24h,
    pm_avg_spread: match.pmAvgSpread,
    pm_active_traders_24h: match.pmActiveTraders24h,
    pm_trade_count_24h: match.pmTradeCount24h,
    pm_top_holder_depth: match.pmTopHolderDepth,
    pm_max_holder_concentration: match.pmMaxHolderConcentration,
    sampled: match.sampled,
    heat_score: match.heatScore,
    liquidity_score: match.liquidityScore,
    participation_score: match.participationScore,
    opportunity_score: match.opportunityScore,
    confidence_score: match.confidenceScore,
    risk_level: match.riskLevel,
    risk_signals: match.riskSignals,
    tags: match.tags,
    ai_explanation_fields: match.aiExplanation,
    polymarket_markets: markets(match),
  };
}

function opportunity(row: MarketOpportunity): Record<string, unknown> {
  return {
    fixture_key: row.fixtureKey,
    match: row.match,
    home_team: row.homeTeam,
    away_team: row.awayTeam,
    kickoff_utc: row.kickoffUtc,
    platform: row.platform,
    market_type: row.marketType,
    outcome: row.outcome,
    current_price: row.currentPrice,
    market_implied_probability: row.marketImpliedProbability,
    ai_estimated_probability: row.aiEstimatedProbability,
    probability_gap: row.probabilityGap,
    max_cross_platform_probability_gap: row.maxCrossPlatformProbabilityGap,
    volume_24h: row.volume24h,
    liquidity: row.liquidity,
    bid_ask_spread: row.bidAskSpread,
    active_traders_24h: row.activeTraders24h,
    trade_count_24h: row.tradeCount24h,
    top_holder_depth: row.topHolderDepth,
    top_holder_concentration: row.topHolderConcentration,
    close_time: row.closeTime,
    opportunity_score: row.opportunityScore,
    confidence_score: row.confidenceScore,
    heat_score: row.heatScore,
    risk_level: row.riskLevel,
    tags: row.tags,
    ai_explanation_fields: row.aiExplanation,
    suggested_action: row.suggestedAction,
    sampled: row.sampled,
    condition_id: row.metric?.conditionId ?? null,
  };
}

function publicBase(generatedAt: string): Record<string, unknown> {
  return {
    schema_version: WALRUS_SCHEMA_VERSION,
    generated_at: generatedAt,
    network: WALRUS_NETWORK,
    data_policy: {
      public_snapshot: true,
      aggregate_only: true,
      raw_wallet_addresses: false,
      api_keys_or_secrets: false,
      full_sqlite_database: false,
      note: "Only aggregate market metrics are exported. Raw holder wallets and private configuration are never included.",
    },
    source_freshness: getSourceFreshness().map((f) => ({
      group: f.group,
      age_ms: f.ageMs,
      stale_ms: f.staleMs,
      latest: f.latest,
      level: f.ageMs === null || f.ageMs > f.staleMs ? "stale" : f.ageMs > f.staleMs / 2 ? "watch" : "fresh",
    })),
  };
}

export function exportWalrusFeed(outDir = WALRUS_FEED_DIR, limit = 70): WalrusExportResult {
  ensureDir(outDir);
  const generatedAt = new Date().toISOString();
  const model = getMarketRadar(limit);
  const sampledMarkets = model.opportunities.filter((o) => o.sampled).length;
  const base = publicBase(generatedAt);
  const artifacts: WalrusArtifact[] = [];

  const matchRows = model.matches.map(matchSummary);
  const opportunityRows = model.opportunities.map(opportunity);
  const marketRows = model.matches.flatMap((match) =>
    LABELS.map((label) => ({
      fixture_key: match.row.fixtureKey,
      outcome: label,
      market: metric(match.pmMarkets[label]),
    })).filter((row) => row.market !== null)
  );

  artifacts.push(
    writeJson(outDir, "radar-latest.json", {
      ...base,
      sampled_flags: { any_sampled: sampledMarkets > 0, sampled_markets: sampledMarkets },
      metrics: model.metrics,
      ai_brief: model.aiBrief,
      matches: matchRows,
      markets: marketRows,
      opportunities: opportunityRows.slice(0, 25),
    })
  );

  artifacts.push(
    writeJson(outDir, "opportunities-latest.json", {
      ...base,
      sampled_flags: { any_sampled: sampledMarkets > 0, sampled_markets: sampledMarkets },
      opportunities: opportunityRows,
      markets: marketRows,
    })
  );

  for (const match of model.matches) {
    artifacts.push(
      writeJson(outDir, `matches/${encodeURIComponent(match.row.fixtureKey)}.json`, {
        ...base,
        sampled_flags: { any_sampled: match.sampled, sampled_markets: match.sampled ? LABELS.filter((label) => match.pmMarkets[label]?.holdersSampled || match.pmMarkets[label]?.tradesSampled).length : 0 },
        match: matchSummary(match),
        markets: LABELS.map((label) => ({ outcome: label, market: metric(match.pmMarkets[label]) })).filter((row) => row.market !== null),
        related_opportunities: model.opportunities.filter((row) => row.fixtureKey === match.row.fixtureKey).map(opportunity),
      })
    );
  }

  const manifest: WalrusExportManifest = {
    schema_version: WALRUS_SCHEMA_VERSION,
    generated_at: generatedAt,
    network: WALRUS_NETWORK,
    data_policy: {
      public_snapshot: true,
      aggregate_only: true,
      raw_wallet_addresses: false,
      api_keys_or_secrets: false,
      full_sqlite_database: false,
    },
    sampled_flags: {
      any_sampled: sampledMarkets > 0,
      sampled_markets: sampledMarkets,
    },
    artifacts: artifacts.map(publicArtifact),
  };
  const manifestArtifact = writeJson(outDir, "manifest-latest.json", manifest);
  return { outDir, manifest, manifestPath: manifestArtifact.path, artifacts: [...artifacts, manifestArtifact] };
}
