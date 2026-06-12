// 球队名跨平台归一。deepseek 三大翻车点之首:匹配失败必须打日志,绝不静默丢。
// 策略:规范化(小写/去音符/去缀)→ 别名表 → 包含式模糊兜底。
// 别名表按 unmatched 日志增量补,不预设完整 48 队清单(避免硬编码错误)。

const ALIASES: Record<string, string> = {
  "usa": "united states",
  "us": "united states",
  "united states of america": "united states",
  "korea republic": "south korea",
  "republic of korea": "south korea",
  "korea": "south korea",
  "ir iran": "iran",
  "iran ir": "iran",
  "bosnia": "bosnia and herzegovina",
  "bosnia-herzegovina": "bosnia and herzegovina",
  "bosnia herzegovina": "bosnia and herzegovina",
  "czech republic": "czechia",
  "turkiye": "turkey",
  "cote divoire": "ivory coast",
  "cote d ivoire": "ivory coast",
  "dr congo": "congo dr",
  "democratic republic of congo": "congo dr",
  "uae": "united arab emirates",
  "ksa": "saudi arabia",
  "holland": "netherlands",
  "cabo verde": "cape verde",
};

export function normalizeTeam(name: string): string {
  let n = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // 去音符 (Türkiye→Turkiye, Curaçao→Curacao)
    .replace(/['’.]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\b(national team|fc|nt)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return ALIASES[n] ?? n;
}

export function teamsMatch(a: string, b: string): boolean {
  const na = normalizeTeam(a);
  const nb = normalizeTeam(b);
  if (na === nb) return true;
  // 包含式兜底: "united states" vs "united states mens national team"
  if (na.length >= 4 && nb.length >= 4 && (na.includes(nb) || nb.includes(na))) return true;
  return false;
}
