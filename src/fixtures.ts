import { normalizeTeam } from "./teams.js";

export const FIXTURE_MERGE_WINDOW_MS = 45 * 60 * 1000;

export function normalizeKickoffUtc(kickoffUtc: string): string {
  const d = new Date(kickoffUtc);
  if (Number.isNaN(d.getTime())) return kickoffUtc.trim();
  return d.toISOString().replace(".000Z", "Z");
}

export function fixtureKey(homeTeam: string, awayTeam: string, kickoffUtc: string): string {
  return `${normalizeTeam(homeTeam)}|${normalizeTeam(awayTeam)}|${normalizeKickoffUtc(kickoffUtc)}`;
}

export function fixtureTeamKey(homeTeam: string, awayTeam: string): string {
  return `${normalizeTeam(homeTeam)}|${normalizeTeam(awayTeam)}`;
}

export function fixtureDay(kickoffUtc: string): string {
  const d = new Date(kickoffUtc);
  if (Number.isNaN(d.getTime())) return kickoffUtc.trim().slice(0, 10);
  return d.toISOString().slice(0, 10);
}

export function fixtureTeamDayKey(homeTeam: string, awayTeam: string, kickoffUtc: string): string {
  return `${fixtureTeamKey(homeTeam, awayTeam)}|${fixtureDay(kickoffUtc)}`;
}

export function kickoffDiffMs(a: string, b: string): number | null {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return Math.abs(ta - tb);
}

export function isSameFixtureWindow(a: string, b: string): boolean {
  const diff = kickoffDiffMs(a, b);
  return diff !== null && diff <= FIXTURE_MERGE_WINDOW_MS;
}
