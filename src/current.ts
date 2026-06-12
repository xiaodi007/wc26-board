import { formatThreeWay, getCurrentOdds } from "./queries/currentOdds.js";

function parseLimit(): number {
  const arg = process.argv.find((a) => a.startsWith("--limit="));
  const n = arg ? Number(arg.slice("--limit=".length)) : 8;
  return Number.isInteger(n) && n > 0 ? Math.min(n, 50) : 8;
}

const rows = getCurrentOdds(parseLimit()).map((row) => ({
  kickoff_utc: row.kickoffUtc,
  match: row.match,
  polymarket: formatThreeWay(row.polymarket),
  pinnacle: formatThreeWay(row.pinnacle),
  sporttery: formatThreeWay(row.sporttery),
  book_avg: formatThreeWay(row.bookAvg),
  books: row.books,
}));

console.log("current normalized 1X2 probabilities: home / draw / away");
console.table(rows);
