import { kellyStakeFraction } from "../betting/plan.js";
import { getMarketRadar, type MatchIntelligence } from "./marketIntelligence.js";
import { getOfferedOddsForFixtures, type OfferedOdd } from "./offeredOdds.js";
import { LABELS, medianThreeWay, type CurrentOddsRow, type Label, type ThreeWay } from "./currentOdds.js";

export interface SourceContribution {
  source: "book_median" | "pinnacle" | "polymarket" | "kalshi";
  probability: number;
  rawWeight: number;
  weight: number;
  detail: string;
}

export interface ProbabilityCandidate {
  fixtureKey: string;
  outcome: Label;
  offeredOdd: OfferedOdd;
  fairProbability: number;
  marketImpliedProbability: number;
  edgePp: number;
  expectedValuePct: number;
  kellyFraction: number;
  score: number;
  sourceContributions: SourceContribution[];
}

export interface ProbabilityModelResult {
  candidates: ProbabilityCandidate[];
  skipped: { fixtureKey: string; outcome: Label; platform: string; reason: string }[];
}

const BOOK_WEIGHT = 0.5;
const PINNACLE_WEIGHT = 0.2;
const PM_WEIGHT = 0.2;
const KALSHI_WEIGHT = 0.1;
const BOOK_SOURCES_EXCLUDED = new Set(["polymarket", "kalshi", "sporttery", "pinnacle"]);

function clamp(v: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, v));
}

function sourceProb(row: CurrentOddsRow, source: string): ThreeWay | null {
  return row.sourceOdds[source] ?? null;
}

function nonPinnacleBookMedian(row: CurrentOddsRow, offeredSource: string): { probs: ThreeWay | null; books: number } {
  const rows = Object.entries(row.sourceOdds)
    .filter(([source]) => !BOOK_SOURCES_EXCLUDED.has(source) && source !== offeredSource)
    .map(([, probs]) => probs);
  return { probs: medianThreeWay(rows), books: rows.length };
}

function marketProbability(offeredOdd: OfferedOdd): number {
  return offeredOdd.marketImpliedProbability && offeredOdd.marketImpliedProbability > 0
    ? offeredOdd.marketImpliedProbability
    : 1 / offeredOdd.decimalOdds;
}

function pmConfidence(match: MatchIntelligence | undefined): number {
  if (!match) return 0.5;
  return Math.max(0.25, Math.min(1, match.confidenceScore / 100));
}

function contribution(
  source: SourceContribution["source"],
  probs: ThreeWay | null,
  label: Label,
  rawWeight: number,
  detail: string
): Omit<SourceContribution, "weight"> | null {
  if (!probs || rawWeight <= 0 || !Number.isFinite(probs[label])) return null;
  return { source, probability: probs[label], rawWeight, detail };
}

function fairProbability(
  row: CurrentOddsRow,
  match: MatchIntelligence | undefined,
  label: Label,
  offeredSource: string
): { fairProbability: number | null; contributions: SourceContribution[]; reason?: string } {
  const book = nonPinnacleBookMedian(row, offeredSource);
  const raw = [
    contribution("book_median", book.probs, label, BOOK_WEIGHT * Math.min(book.books / 5, 1), `${book.books} non-Pinnacle books`),
    offeredSource === "pinnacle" ? null : contribution("pinnacle", sourceProb(row, "pinnacle"), label, PINNACLE_WEIGHT, "sharp book"),
    offeredSource === "polymarket" ? null : contribution("polymarket", row.polymarket, label, PM_WEIGHT * pmConfidence(match), `confidence ${(pmConfidence(match) * 100).toFixed(0)}%`),
    offeredSource === "kalshi" ? null : contribution("kalshi", row.kalshi, label, KALSHI_WEIGHT, "prediction market"),
  ].filter((item): item is Omit<SourceContribution, "weight"> => item !== null);

  const totalWeight = raw.reduce((sum, item) => sum + item.rawWeight, 0);
  const enoughBooks = book.books >= 3;
  if (totalWeight < 0.25 || (raw.length < 2 && !enoughBooks)) {
    return { fairProbability: null, contributions: [], reason: "insufficient independent sources" };
  }

  const contributions = raw.map((item) => ({ ...item, weight: item.rawWeight / totalWeight }));
  const fair = contributions.reduce((sum, item) => sum + item.probability * item.weight, 0);
  return { fairProbability: fair, contributions };
}

function candidateScore(edgePp: number, expectedValuePct: number, match: MatchIntelligence | undefined, contributions: SourceContribution[]): number {
  const edgeScore = clamp((edgePp / 8) * 100);
  const evScore = clamp((expectedValuePct / 0.25) * 100);
  const confidenceScore = match?.confidenceScore ?? clamp(contributions.reduce((sum, item) => sum + item.rawWeight, 0) * 100);
  const sourceDepthScore = clamp((contributions.length / 4) * 100);
  return clamp(edgeScore * 0.45 + evScore * 0.25 + confidenceScore * 0.2 + sourceDepthScore * 0.1);
}

export function getProbabilityCandidates(limit = 70, fixtureKey?: string | null): ProbabilityModelResult {
  const radar = getMarketRadar(limit);
  const matches = fixtureKey ? radar.matches.filter((match) => match.row.fixtureKey === fixtureKey) : radar.matches;
  const offeredOdds = getOfferedOddsForFixtures(matches.map((match) => match.row.fixtureKey));
  const matchByFixture = new Map(matches.map((match) => [match.row.fixtureKey, match]));
  const rowByFixture = new Map(matches.map((match) => [match.row.fixtureKey, match.row]));
  const candidates: ProbabilityCandidate[] = [];
  const skipped: ProbabilityModelResult["skipped"] = [];

  for (const odd of offeredOdds) {
    const row = rowByFixture.get(odd.fixtureKey);
    if (!row || !LABELS.includes(odd.label)) continue;
    const match = matchByFixture.get(odd.fixtureKey);
    const fair = fairProbability(row, match, odd.label, odd.source);
    if (fair.fairProbability === null) {
      skipped.push({ fixtureKey: odd.fixtureKey, outcome: odd.label, platform: odd.platform, reason: fair.reason ?? "insufficient data" });
      continue;
    }
    const marketP = marketProbability(odd);
    const expectedValuePct = fair.fairProbability * odd.decimalOdds - 1;
    const edgePp = (fair.fairProbability - marketP) * 100;
    const kellyFraction = kellyStakeFraction(fair.fairProbability, odd.decimalOdds);
    candidates.push({
      fixtureKey: odd.fixtureKey,
      outcome: odd.label,
      offeredOdd: odd,
      fairProbability: fair.fairProbability,
      marketImpliedProbability: marketP,
      edgePp,
      expectedValuePct,
      kellyFraction,
      score: candidateScore(edgePp, expectedValuePct, match, fair.contributions),
      sourceContributions: fair.contributions,
    });
  }

  candidates.sort((a, b) => b.score - a.score || b.edgePp - a.edgePp);
  return { candidates, skipped };
}
