import { getCurrentOdds, LABELS, type Label } from "./currentOdds.js";

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
  const thresholdPp = Number.isFinite(options.thresholdPp) ? Number(options.thresholdPp) : 2;
  const minBooks = Number.isInteger(options.minBooks) && Number(options.minBooks) > 0 ? Number(options.minBooks) : 5;

  const rows: SportteryAvoidanceRow[] = [];
  for (const fixture of getCurrentOdds(scanLimit)) {
    if (!fixture.sporttery || !fixture.bookAvg || fixture.books < minBooks) continue;
    for (const label of LABELS) {
      const sporttery = fixture.sporttery[label];
      const bookAvg = fixture.bookAvg[label];
      const diffPp = (sporttery - bookAvg) * 100;
      if (diffPp < thresholdPp) continue;
      rows.push({
        kickoffUtc: fixture.kickoffUtc,
        match: fixture.match,
        outcome: outcomeName(label, fixture.homeTeam, fixture.awayTeam),
        sporttery,
        bookAvg,
        diffPp,
        books: fixture.books,
        note: "体彩隐含概率偏高,回报相对不划算",
      });
    }
  }

  return rows.sort((a, b) => b.diffPp - a.diffPp).slice(0, outputLimit);
}
