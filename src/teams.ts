// 球队名跨平台归一。deepseek 三大翻车点之首:匹配失败必须打日志,绝不静默丢。
// 策略:规范化(小写/去音符/去缀)→ 别名表 → 包含式模糊兜底。
// 别名表按 unmatched 日志增量补,不预设完整 48 队清单(避免硬编码错误)。

const ALIASES: Record<string, string> = {
  "加拿大": "canada",
  "波黑": "bosnia and herzegovina",
  "美国": "united states",
  "巴拉圭": "paraguay",
  "卡塔尔": "qatar",
  "瑞士": "switzerland",
  "巴西": "brazil",
  "摩洛哥": "morocco",
  "海地": "haiti",
  "苏格兰": "scotland",
  "澳大利亚": "australia",
  "土耳其": "turkey",
  "德国": "germany",
  "库拉索": "curacao",
  "荷兰": "netherlands",
  "日本": "japan",
  "科特迪瓦": "ivory coast",
  "厄瓜多尔": "ecuador",
  "瑞典": "sweden",
  "突尼斯": "tunisia",
  "西班牙": "spain",
  "佛得角": "cape verde",
  "比利时": "belgium",
  "埃及": "egypt",
  "沙特阿拉伯": "saudi arabia",
  "乌拉圭": "uruguay",
  "伊朗": "iran",
  "新西兰": "new zealand",
  "法国": "france",
  "塞内加尔": "senegal",
  "伊拉克": "iraq",
  "挪威": "norway",
  "阿根廷": "argentina",
  "阿尔及利亚": "algeria",
  "奥地利": "austria",
  "约旦": "jordan",
  "葡萄牙": "portugal",
  "刚果(金)": "congo dr",
  "刚果金": "congo dr",
  "英格兰": "england",
  "克罗地亚": "croatia",
  "加纳": "ghana",
  "巴拿马": "panama",
  "乌兹别克斯坦": "uzbekistan",
  "乌兹别克": "uzbekistan",
  "哥伦比亚": "colombia",
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
  const raw = name.toLowerCase().trim();
  if (ALIASES[raw]) return ALIASES[raw];
  let n = raw
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

// 英文队名 → 中文展示名(取别名表里第一个中文别名;dashboard 用)
const ZH_BY_CANONICAL: Record<string, string> = {};
for (const [alias, canonical] of Object.entries(ALIASES)) {
  if (/[一-鿿]/.test(alias) && !(canonical in ZH_BY_CANONICAL)) ZH_BY_CANONICAL[canonical] = alias;
}

export function zhTeamName(name: string): string | null {
  return ZH_BY_CANONICAL[normalizeTeam(name)] ?? null;
}

export function teamsMatch(a: string, b: string): boolean {
  const na = normalizeTeam(a);
  const nb = normalizeTeam(b);
  if (na === nb) return true;
  // 包含式兜底: "united states" vs "united states mens national team"
  if (na.length >= 4 && nb.length >= 4 && (na.includes(nb) || nb.includes(na))) return true;
  return false;
}
