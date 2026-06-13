import type { Label } from "../queries/currentOdds.js";
import type { OfferedOdd } from "../queries/offeredOdds.js";

export const KELLY_FRACTION = 0.25;
export const MAX_STAKE_FRACTION = 0.01;
export const MIN_EDGE_PP = 2;

export type PlanBucket = "bet" | "watch" | "avoid";
export type BetConfidence = "low" | "medium" | "high";

export interface AiBetPlanPick {
  fixture_key: string;
  outcome: Label;
  platform?: string;
  estimated_probability: number;
  confidence: BetConfidence;
  reason: string;
  risk: string;
  cancel_if: string;
  bucket?: PlanBucket;
}

export interface BetPlanInput extends AiBetPlanPick {
  offeredOdd: OfferedOdd;
}

export interface BetPlanRow extends BetPlanInput {
  bucket: PlanBucket;
  marketImpliedProbability: number;
  edgePp: number;
  kellyFraction: number;
  stakeFraction: number;
  stake: number;
  winProbability: number;
  loseProbability: number;
  netProfitIfWin: number;
  maxLoss: number;
  expectedValue: number;
  evPctStake: number;
}

export interface BetPlanSummary {
  bankroll: number;
  maxDailyLoss: number;
  totalStake: number;
  worstCaseLoss: number;
  allWinNetProfit: number;
  expectedValue: number;
  approximateLossProbability: number | null;
}

export interface BetPlanResult {
  rows: BetPlanRow[];
  summary: BetPlanSummary;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function probability(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v > 1 ? clamp(v / 100, 0, 1) : clamp(v, 0, 1);
}

function marketProbability(offeredOdd: OfferedOdd): number {
  if (offeredOdd.marketImpliedProbability !== null && offeredOdd.marketImpliedProbability > 0) return offeredOdd.marketImpliedProbability;
  return 1 / offeredOdd.decimalOdds;
}

export function kellyStakeFraction(estimatedProbability: number, decimalOdds: number): number {
  const p = probability(estimatedProbability);
  if (p <= 0 || decimalOdds <= 1) return 0;
  const rawKelly = (p * decimalOdds - 1) / (decimalOdds - 1);
  return clamp(rawKelly, 0, 1) * KELLY_FRACTION;
}

function baseBucket(input: BetPlanInput, edgePp: number, kellyFraction: number): PlanBucket {
  if (input.bucket === "avoid") return "avoid";
  if (input.bucket === "watch") return "watch";
  if (kellyFraction > 0 && edgePp >= MIN_EDGE_PP) return "bet";
  if (edgePp > 0) return "watch";
  return "avoid";
}

export function buildBetPlan(inputs: BetPlanInput[], bankroll: number, maxDailyLoss: number): BetPlanResult {
  const safeBankroll = Number.isFinite(bankroll) && bankroll > 0 ? bankroll : 0;
  const requestedLoss = Number.isFinite(maxDailyLoss) && maxDailyLoss > 0 ? maxDailyLoss : 0;
  const safeMaxDailyLoss = safeBankroll > 0 ? Math.min(requestedLoss, safeBankroll) : 0;
  const seenFixtures = new Set<string>();

  const preliminary = inputs
    .filter((input) => input.offeredOdd.decimalOdds > 1 && probability(input.estimated_probability) > 0)
    .sort((a, b) => {
      const evA = probability(a.estimated_probability) * a.offeredOdd.decimalOdds - 1;
      const evB = probability(b.estimated_probability) * b.offeredOdd.decimalOdds - 1;
      return evB - evA;
    })
    .filter((input) => {
      if (seenFixtures.has(input.fixture_key)) return false;
      seenFixtures.add(input.fixture_key);
      return true;
    })
    .map((input) => {
      const p = probability(input.estimated_probability);
      const marketP = marketProbability(input.offeredOdd);
      const edgePp = (p - marketP) * 100;
      const kellyFraction = kellyStakeFraction(p, input.offeredOdd.decimalOdds);
      const cappedFraction = Math.min(kellyFraction, MAX_STAKE_FRACTION);
      const stake = safeBankroll * cappedFraction;
      const ev = stake * (p * input.offeredOdd.decimalOdds - 1);
      return {
        ...input,
        bucket: baseBucket(input, edgePp, kellyFraction),
        estimated_probability: p,
        marketImpliedProbability: marketP,
        edgePp,
        kellyFraction,
        stakeFraction: cappedFraction,
        stake,
        winProbability: p,
        loseProbability: 1 - p,
        netProfitIfWin: stake * (input.offeredOdd.decimalOdds - 1),
        maxLoss: stake,
        expectedValue: ev,
        evPctStake: stake > 0 ? ev / stake : 0,
      };
    });

  const betRows = preliminary.filter((row) => row.bucket === "bet" && row.stake > 0);
  const totalBetStake = betRows.reduce((sum, row) => sum + row.stake, 0);
  const scale = totalBetStake > safeMaxDailyLoss && totalBetStake > 0 ? safeMaxDailyLoss / totalBetStake : 1;
  const rows = preliminary.map((row) => {
    if (row.bucket !== "bet") return { ...row, stake: 0, stakeFraction: 0, netProfitIfWin: 0, maxLoss: 0, expectedValue: 0 };
    const stake = row.stake * scale;
    return {
      ...row,
      stakeFraction: safeBankroll > 0 ? stake / safeBankroll : 0,
      stake,
      netProfitIfWin: stake * (row.offeredOdd.decimalOdds - 1),
      maxLoss: stake,
      expectedValue: stake * (row.winProbability * row.offeredOdd.decimalOdds - 1),
    };
  });

  const activeRows = rows.filter((row) => row.bucket === "bet" && row.stake > 0);
  const totalStake = activeRows.reduce((sum, row) => sum + row.stake, 0);
  const allWinNetProfit = activeRows.reduce((sum, row) => sum + row.netProfitIfWin, 0);
  const expectedValue = activeRows.reduce((sum, row) => sum + row.expectedValue, 0);
  const allWinProbability = activeRows.length
    ? activeRows.reduce((p, row) => p * row.winProbability, 1)
    : null;

  return {
    rows,
    summary: {
      bankroll: safeBankroll,
      maxDailyLoss: safeMaxDailyLoss,
      totalStake,
      worstCaseLoss: totalStake,
      allWinNetProfit,
      expectedValue,
      approximateLossProbability: allWinProbability === null ? null : 1 - allWinProbability,
    },
  };
}
