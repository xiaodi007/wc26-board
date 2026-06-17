import { API_FOOTBALL_KEY, ODDS_API_KEY, log } from "../config.js";
import { setMeta } from "../db.js";
import { pollApiFootballResults } from "./apiFootball.js";
import { pollScores } from "./oddsapi.js";
import { pollSportteryResults } from "./sportteryResults.js";

export interface ResultSourceRun {
  attempted: boolean;
  matched: number;
  error: string | null;
}

export interface ResultPollSummary {
  apiFootball: ResultSourceRun;
  sporttery: ResultSourceRun;
  oddsapi: ResultSourceRun;
  totalMatched: number;
}

function emptyRun(): ResultSourceRun {
  return { attempted: false, matched: 0, error: null };
}

async function runSource(name: string, poll: () => Promise<number>): Promise<ResultSourceRun> {
  try {
    return { attempted: true, matched: await poll(), error: null };
  } catch (e) {
    const error = String(e instanceof Error ? e.message : e);
    log(`results: ${name} failed: ${error}`);
    return { attempted: true, matched: 0, error };
  }
}

export async function pollResultSources(): Promise<ResultPollSummary> {
  const summary: ResultPollSummary = {
    apiFootball: emptyRun(),
    sporttery: emptyRun(),
    oddsapi: emptyRun(),
    totalMatched: 0,
  };

  if (API_FOOTBALL_KEY) {
    summary.apiFootball = await runSource("api-football", pollApiFootballResults);
  } else {
    summary.sporttery = await runSource("sporttery", pollSportteryResults);
    if (ODDS_API_KEY) summary.oddsapi = await runSource("oddsapi scores", pollScores);
  }

  summary.totalMatched = summary.apiFootball.matched + summary.sporttery.matched + summary.oddsapi.matched;
  setMeta("results_last_attempt", new Date().toISOString());
  setMeta("results_total_matched_last", String(summary.totalMatched));
  log(
    `results: summary api=${summary.apiFootball.attempted ? summary.apiFootball.matched : "skip"} ` +
      `sporttery=${summary.sporttery.attempted ? summary.sporttery.matched : "skip"} ` +
      `oddsapi=${summary.oddsapi.attempted ? summary.oddsapi.matched : "skip"}`
  );
  return summary;
}
