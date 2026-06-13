import { db } from "../db.js";
import { getCurrentOdds, LABELS, type Label } from "./currentOdds.js";

export interface OfferedOdd {
  fixtureKey: string;
  source: string;
  platform: string;
  label: Label;
  decimalOdds: number;
  marketImpliedProbability: number | null;
  priceBasis: "sporttery_sp" | "decimal" | "ask" | "last" | "mid" | "probability";
  marketType: string;
  sourceUpdatedTs: string | null;
}

interface RawOfferedOddRow {
  fixture_key: string;
  source: string;
  market_type: string;
  outcome_label: string;
  raw_price: string | null;
  prob_implied: number | null;
  bid: number | null;
  ask: number | null;
  source_updated_ts: string | null;
}

const SOURCE_LABELS: Record<string, string> = {
  sporttery: "Sporttery",
  polymarket: "Polymarket",
  kalshi: "Kalshi",
  pinnacle: "Pinnacle",
};

const SOURCE_PRIORITY = ["sporttery", "polymarket", "kalshi", "pinnacle"];

function platform(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

function parseRaw(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function num(raw: unknown): number | null {
  const value = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
  return Number.isFinite(value) ? value : null;
}

function validDecimal(value: number | null): value is number {
  return value !== null && value > 1.001 && Number.isFinite(value);
}

function decimalFromProbability(prob: number | null | undefined): number | null {
  return prob !== null && prob !== undefined && prob > 0 && prob < 1 ? 1 / prob : null;
}

function offeredOdd(row: RawOfferedOddRow): OfferedOdd | null {
  if (!LABELS.includes(row.outcome_label as Label)) return null;
  const raw = parseRaw(row.raw_price);
  let decimal: number | null = null;
  let basis: OfferedOdd["priceBasis"] = "probability";

  if (row.source === "sporttery") {
    decimal = num(raw?.sp);
    basis = "sporttery_sp";
  } else if (raw && validDecimal(num(raw.decimal))) {
    decimal = num(raw.decimal);
    basis = "decimal";
  } else if (row.source === "polymarket" || row.source === "kalshi") {
    const last = num(raw?.last);
    const ask = row.ask ?? num(raw?.yes_ask);
    const bid = row.bid ?? num(raw?.yes_bid);
    if (ask !== null && ask > 0 && ask < 1) {
      decimal = 1 / ask;
      basis = "ask";
    } else if (last !== null && last > 0 && last < 1) {
      decimal = 1 / last;
      basis = "last";
    } else if (bid !== null && ask !== null && bid > 0 && ask < 1 && bid <= ask) {
      decimal = 2 / (bid + ask);
      basis = "mid";
    }
  }

  if (!validDecimal(decimal)) {
    decimal = decimalFromProbability(row.prob_implied);
    basis = "probability";
  }
  if (!validDecimal(decimal)) return null;

  return {
    fixtureKey: row.fixture_key,
    source: row.source,
    platform: platform(row.source),
    label: row.outcome_label as Label,
    decimalOdds: decimal,
    marketImpliedProbability: row.prob_implied,
    priceBasis: basis,
    marketType: row.market_type,
    sourceUpdatedTs: row.source_updated_ts,
  };
}

const stmtCache = new Map<number, ReturnType<typeof db.prepare>>();

function stmtFor(count: number): ReturnType<typeof db.prepare> {
  const cached = stmtCache.get(count);
  if (cached) return cached;
  const placeholders = Array.from({ length: count }, () => "?").join(",");
  const stmt = db.prepare(
    `WITH latest AS (
       SELECT outcome_id, MAX(ts) AS ts
       FROM snapshot
       GROUP BY outcome_id
     )
     SELECT e.fixture_key,
            m.source,
            m.market_type,
            o.outcome_label,
            s.raw_price,
            s.prob_implied,
            s.bid,
            s.ask,
            s.source_updated_ts
     FROM event e
     JOIN market m ON m.event_id=e.id
     JOIN outcome o ON o.market_id=m.id
     JOIN latest l ON l.outcome_id=o.id
     JOIN snapshot s ON s.outcome_id=o.id AND s.ts=l.ts
     WHERE e.fixture_key IN (${placeholders})
       AND o.outcome_label IN ('home', 'draw', 'away')
       AND m.market_type IN ('1x2', 'home_win_binary', 'draw_binary', 'away_win_binary', 'sporttery_had')
     ORDER BY e.fixture_key, o.outcome_label, m.source`
  );
  stmtCache.set(count, stmt);
  return stmt;
}

export function getOfferedOddsForFixtures(fixtureKeys: string[]): OfferedOdd[] {
  const keys = [...new Set(fixtureKeys.filter(Boolean))];
  if (!keys.length) return [];
  const rows = (stmtFor(keys.length) as unknown as { all: (...params: string[]) => RawOfferedOddRow[] }).all(...keys);
  return rows.map(offeredOdd).filter((row): row is OfferedOdd => row !== null);
}

export function getOfferedOdds(limit = 70): OfferedOdd[] {
  return getOfferedOddsForFixtures(getCurrentOdds(limit).map((row) => row.fixtureKey));
}

export function resolveOfferedOdd(
  odds: OfferedOdd[],
  fixtureKey: string,
  label: Label,
  preferredSourceOrPlatform?: string | null
): OfferedOdd | null {
  const candidates = odds.filter((row) => row.fixtureKey === fixtureKey && row.label === label);
  if (!candidates.length) return null;
  const preferred = (preferredSourceOrPlatform ?? "").trim().toLowerCase();
  if (preferred) {
    const exact = candidates.find((row) => row.source.toLowerCase() === preferred || row.platform.toLowerCase() === preferred);
    if (exact) return exact;
  }
  return [...candidates].sort((a, b) => {
    const pa = SOURCE_PRIORITY.includes(a.source) ? SOURCE_PRIORITY.indexOf(a.source) : 50;
    const pb = SOURCE_PRIORITY.includes(b.source) ? SOURCE_PRIORITY.indexOf(b.source) : 50;
    return pa - pb || b.decimalOdds - a.decimalOdds;
  })[0];
}

export function bestOfferedOddsByOutcome(odds: OfferedOdd[]): Map<string, OfferedOdd> {
  const result = new Map<string, OfferedOdd>();
  for (const row of odds) {
    const key = `${row.fixtureKey}|${row.label}`;
    const existing = result.get(key);
    if (!existing) {
      result.set(key, row);
      continue;
    }
    const currentPriority = SOURCE_PRIORITY.includes(row.source) ? SOURCE_PRIORITY.indexOf(row.source) : 50;
    const existingPriority = SOURCE_PRIORITY.includes(existing.source) ? SOURCE_PRIORITY.indexOf(existing.source) : 50;
    if (currentPriority < existingPriority || (currentPriority === existingPriority && row.decimalOdds > existing.decimalOdds)) {
      result.set(key, row);
    }
  }
  return result;
}
