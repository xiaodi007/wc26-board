import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { db, getOrCreateMarket, getOrCreateOutcome, insertSnapshots, upsertEvent, type SnapshotRow } from "./db.js";
import { fixtureKey, normalizeKickoffUtc } from "./fixtures.js";
import { decimalToProb } from "./normalize.js";

type Label = "home" | "draw" | "away";

interface ImportRow {
  home: string;
  away: string;
  kickoffUtc: string;
  odds: Record<Label, number>;
  matchId: string;
  sourceUpdatedTs: string | null;
}

const LABELS: Label[] = ["home", "draw", "away"];

const FIELD_ALIASES: Record<string, string[]> = {
  home: ["home_team", "home", "主队"],
  away: ["away_team", "away", "客队"],
  kickoff: ["kickoff_utc", "kickoff_local", "kickoff_beijing", "kickoff", "比赛时间", "开赛时间", "时间"],
  homeOdds: ["home_win", "home_sp", "home_odds", "h", "胜"],
  drawOdds: ["draw", "draw_sp", "draw_odds", "d", "平"],
  awayOdds: ["away_win", "away_sp", "away_odds", "a", "负"],
  matchId: ["match_id", "id", "编号", "场次"],
  updatedAt: ["updated_at", "source_updated_ts", "更新时间"],
};

function usage(): never {
  console.error("usage: npm run import:sporttery -- <file.csv|file.json>");
  process.exit(1);
}

function inputPath(): string {
  const explicit = process.argv.find((arg) => arg.startsWith("--file="));
  if (explicit) return explicit.slice("--file=".length);
  const positional = process.argv.slice(2).find((arg) => !arg.startsWith("-"));
  if (!positional) usage();
  return positional;
}

function pick(row: Record<string, unknown>, aliases: string[]): string {
  for (const alias of aliases) {
    const value = row[alias];
    if (value !== undefined && value !== null && String(value).trim() !== "") return String(value).trim();
  }
  return "";
}

function parseNumber(value: string, field: string): number {
  const n = Number(value.replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 1) throw new Error(`invalid ${field}: ${value}`);
  return n;
}

function parseKickoff(raw: string): string {
  const s = raw.trim();
  if (!s) throw new Error("missing kickoff");
  const hasZone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(s);
  const normalized = s.replace(/\//g, "-").replace(" ", "T");
  const d = new Date(hasZone ? normalized : `${normalized}+08:00`);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid kickoff: ${raw}`);
  return d.toISOString();
}

function makeMatchId(row: Record<string, unknown>, imported: ImportRow): string {
  const explicit = pick(row, FIELD_ALIASES.matchId);
  if (explicit) return explicit;
  return fixtureKey(imported.home, imported.away, imported.kickoffUtc);
}

function parseImportRow(row: Record<string, unknown>): ImportRow {
  const home = pick(row, FIELD_ALIASES.home);
  const away = pick(row, FIELD_ALIASES.away);
  if (!home || !away) throw new Error(`missing teams: ${JSON.stringify(row)}`);
  const kickoffUtc = parseKickoff(pick(row, FIELD_ALIASES.kickoff));
  const imported: ImportRow = {
    home,
    away,
    kickoffUtc,
    odds: {
      home: parseNumber(pick(row, FIELD_ALIASES.homeOdds), "home odds"),
      draw: parseNumber(pick(row, FIELD_ALIASES.drawOdds), "draw odds"),
      away: parseNumber(pick(row, FIELD_ALIASES.awayOdds), "away odds"),
    },
    matchId: "",
    sourceUpdatedTs: pick(row, FIELD_ALIASES.updatedAt) || null,
  };
  imported.matchId = makeMatchId(row, imported);
  return imported;
}

function parseJson(raw: string): Record<string, unknown>[] {
  const parsed = JSON.parse(raw) as unknown;
  if (Array.isArray(parsed)) return parsed as Record<string, unknown>[];
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    for (const key of ["matches", "data", "rows"]) {
      if (Array.isArray(obj[key])) return obj[key] as Record<string, unknown>[];
    }
  }
  throw new Error("JSON must be an array, or an object with matches/data/rows array");
}

function parseCsv(raw: string): Record<string, unknown>[] {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;

  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    const next = raw[i + 1];
    if (quoted) {
      if (c === '"' && next === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      record.push(field.trim());
      field = "";
    } else if (c === "\n") {
      record.push(field.trim());
      records.push(record);
      field = "";
      record = [];
    } else if (c !== "\r") {
      field += c;
    }
  }
  if (field || record.length) {
    record.push(field.trim());
    records.push(record);
  }

  const [headers, ...rows] = records.filter((r) => r.some((cell) => cell !== ""));
  if (!headers) return [];
  return rows.map((cells) => Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? ""])));
}

function parseFile(path: string): ImportRow[] {
  const raw = readFileSync(path, "utf8");
  const rows = path.toLowerCase().endsWith(".json") ? parseJson(raw) : parseCsv(raw);
  return rows.map(parseImportRow);
}

function eventIdFor(row: ImportRow): string {
  const key = fixtureKey(row.home, row.away, row.kickoffUtc);
  const existing = db
    .prepare(`SELECT id FROM event WHERE fixture_key=? ORDER BY CASE WHEN id LIKE 'pm-%' THEN 0 ELSE 1 END, id LIMIT 1`)
    .get(key) as { id: string } | undefined;
  if (existing) return existing.id;

  const id = `sporttery-${row.matchId}`;
  upsertEvent(id, row.home, row.away, normalizeKickoffUtc(row.kickoffUtc));
  return id;
}

function importRows(rows: ImportRow[], filePath: string): number {
  const snapshots: SnapshotRow[] = [];
  for (const row of rows) {
    const eventId = eventIdFor(row);
    const marketId = getOrCreateMarket("sporttery", `${row.matchId}:had`, "sporttery_had", eventId, "had");
    for (const label of LABELS) {
      const sp = row.odds[label];
      const outcomeId = getOrCreateOutcome(marketId, label);
      snapshots.push({
        outcomeId,
        rawPrice: JSON.stringify({ sp, imported_from: basename(filePath), match_id: row.matchId }),
        probImplied: decimalToProb(sp),
        sourceUpdatedTs: row.sourceUpdatedTs,
      });
    }
  }
  return insertSnapshots(snapshots);
}

const filePath = inputPath();
const rows = parseFile(filePath);
if (rows.length === 0) throw new Error(`no rows found in ${filePath}`);

const n = importRows(rows, filePath);
console.log(`sporttery: imported ${rows.length} matches, ${n} snapshots from ${filePath}`);
