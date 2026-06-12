// 赔率归一:全部转成隐含概率(含水)。devig 在读取层做,采集层只存原始值+隐含概率。

export function decimalToProb(decimalOdds: number): number | null {
  if (!Number.isFinite(decimalOdds) || decimalOdds <= 1) return null;
  return 1 / decimalOdds;
}

export function americanToProb(american: number): number | null {
  if (!Number.isFinite(american) || american === 0) return null;
  return american > 0 ? 100 / (american + 100) : -american / (-american + 100);
}

// Polymarket/Kalshi 价格本身就是概率(0-1)
export function pmPriceToProb(price: number): number | null {
  if (!Number.isFinite(price) || price <= 0 || price >= 1) return null;
  return price;
}

// Gamma API 的数组字段是 JSON 字符串(如 outcomePrices: "[\"0.169\",\"0.831\"]")
export function parseStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}
