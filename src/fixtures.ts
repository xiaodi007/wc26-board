import { normalizeTeam } from "./teams.js";

export function normalizeKickoffUtc(kickoffUtc: string): string {
  const d = new Date(kickoffUtc);
  if (Number.isNaN(d.getTime())) return kickoffUtc.trim();
  return d.toISOString().replace(".000Z", "Z");
}

export function fixtureKey(homeTeam: string, awayTeam: string, kickoffUtc: string): string {
  return `${normalizeTeam(homeTeam)}|${normalizeTeam(awayTeam)}|${normalizeKickoffUtc(kickoffUtc)}`;
}
