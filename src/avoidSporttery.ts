import { getSportteryAvoidance } from "./queries/sportteryAvoidance.js";

function numericArg(name: string, fallback: number): number {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!arg) return fallback;
  const n = Number(arg.slice(name.length + 3));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

const limit = Math.max(1, Math.min(Math.trunc(numericArg("limit", 20)), 100));
const threshold = numericArg("threshold", 2);

const rows = getSportteryAvoidance({
  outputLimit: limit,
  scanLimit: 50,
  thresholdPp: threshold,
  minBooks: 5,
}).map((row) => ({
  kickoff_utc: row.kickoffUtc,
  match: row.match,
  outcome: row.outcome,
  sporttery: pct(row.sporttery),
  book_avg: pct(row.bookAvg),
  diff_pp: row.diffPp.toFixed(1),
  books: row.books,
  note: row.note,
}));

console.log(`sporttery avoidance index: sporttery - book_avg >= ${threshold.toFixed(1)}pp`);
if (rows.length === 0) {
  console.log("no rows matched the threshold");
} else {
  console.table(rows);
}
