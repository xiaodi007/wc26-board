import type {
  AiBriefItem,
  MarketExplanationParts,
  OpportunityTag,
  RiskLevel,
  RiskNoteKey,
  RiskSignalKey,
  SuggestedAction,
} from "../queries/marketIntelligence.js";
import { compactMoney, compactNumber, percent } from "../queries/marketIntelligence.js";
import type { Label } from "../queries/currentOdds.js";

export type Locale = "zh" | "en";

export function parseLocale(raw: string | null | undefined): Locale {
  return raw === "en" ? "en" : "zh";
}

export const LOCALE_NAME: Record<Locale, string> = {
  zh: "中文",
  en: "English",
};

export const COPY = {
  zh: {
    appName: "WC Radar",
    appSub: "预测市场雷达",
    search: "搜索球队、比赛、市场或平台...",
    opportunities: "市场机会",
    sidebar: {
      radar: "世界杯雷达",
      opportunities: "市场机会",
      review: "赛后复盘",
      alerts: "价格提醒",
      walrus: "Walrus 数据",
      api: "数据 API",
    },
    worldCup: "世界杯 2026",
    freeTier: "本地只读",
    aiBrief: "AI 简报",
    signals: "5 条信号",
    heroTitle: "World Cup Market Radar",
    metrics: {
      totalMarkets: "总市场",
      volume24h: "24h 成交额",
      pmLiquidity: "PM 流动性",
      activeTraders: "PM 活跃交易者 24h",
      holderDepth: "Top Holder 深度",
      closingSoon: "即将关闭",
      divergence: "赔率分歧",
      opportunities: "高置信机会",
    },
    metricHints: {
      totalMarkets: "Polymarket 单场 outcome",
      volume24h: "PM moneyline 汇总",
      pmLiquidity: "Gamma 报告字段",
      activeTraders: "近 24h 去重钱包聚合",
      holderDepth: "仅 top holders 可见深度",
      closingSoon: "24 小时内",
      divergence: "跨平台差距 >= 3pp",
      opportunities: "评分 ≥70",
    },
    sections: {
      highLiquidity: "高流动性市场",
      divergence: "赔率分歧",
      divergenceSub: "跨平台隐含概率差",
      closing: "即将关闭",
      closingSub: "24 小时内",
      topOpps: "Top 市场机会",
      topOppsSub: "统一评分，已做风险折扣",
      fullRanking: "打开完整排行",
      ranking: "统一机会排行",
      rankingSub: "热度、流动性、分歧和风险合并评分",
      sourceOdds: "多平台赔率对比",
      related: "相关市场",
      priceTrend: "价格趋势",
      riskPanel: "风险提示",
      matchSummary: "AI 比赛结论",
      walrusProof: "Walrus Proof",
    },
    labels: {
      home: "主胜",
      draw: "平局",
      away: "客胜",
      groupStage: "小组赛",
      stage: "阶段",
      start: "开赛",
      venue: "场地",
      status: "状态",
      fixture: "Fixture",
      detail: "详情",
      follow: "关注比赛",
      share: "分享",
      countdown: "距离开赛",
      live: "进行中",
      pending: "待生成",
      marketConsensus: "市场共识",
      aiProbabilityPending: "AI 概率待生成",
      noFabrication: "未从市场数据伪造结构化 AI 概率。",
      sampled: "sampled",
      topCap: "top cap",
      price: "价格",
      marketProb: "市场概率",
      aiProb: "AI 概率",
      gap: "概率差",
      liq: "流动性",
      traders: "24h 交易者",
      spread: "价差",
      volume: "成交额",
      holderConc: "Top holder 集中度",
      close: "关闭",
      currentPrice: "当前价格",
      platform: "平台",
      marketType: "市场类型",
      outcome: "Outcome",
      score: "评分",
      confidence: "信心",
      action: "建议动作",
      risk: "风险",
      insufficient: "数据不足",
      tbd: "待确认",
      rows: "行",
      latest: "最新",
      network: "网络",
      blob: "Blob",
      generated: "生成时间",
      published: "发布时间",
      schema: "Schema",
      syncDelayed: "Walrus 同步延迟",
      notPublished: "尚未发布",
    },
    empty: {
      liquidity: "下一轮 PM 采集后会显示 liquidity 指标。",
      divergence: "暂未发现明显分歧信号。",
      closing: "24 小时内暂无关闭市场。",
      trend: "走势数据积累中。",
      matchNotFound: "没有找到这场比赛，可能已完赛或当前读取窗口未覆盖。",
      walrus: "导出后会显示最新 Walrus blob。",
    },
    footer: "纯本地只读聚合，个人研究用途。不构成金融建议、投注建议，也不保证收益。PM holder depth 仅代表 top-holder 数据；active traders 可能在 API limit 触发时被标记 sampled。",
    oppFooter: "动作标签只用于筛选：观察、设提醒、谨慎、暂不推荐。它们不是投注指令。",
  },
  en: {
    appName: "WC Radar",
    appSub: "Prediction market radar",
    search: "Search team, match, market, platform...",
    opportunities: "Market Opportunities",
    sidebar: {
      radar: "World Cup Radar",
      opportunities: "Market Opportunities",
      review: "Post-match Review",
      alerts: "Price Alerts",
      walrus: "Walrus Data",
      api: "Data API",
    },
    worldCup: "World Cup 2026",
    freeTier: "Local read-only",
    aiBrief: "AI Brief",
    signals: "5 signals",
    heroTitle: "World Cup Market Radar",
    metrics: {
      totalMarkets: "Total Markets",
      volume24h: "24h Volume",
      pmLiquidity: "PM Liquidity",
      activeTraders: "PM Active Traders 24h",
      holderDepth: "Top Holder Depth",
      closingSoon: "Closing Soon",
      divergence: "Odds Divergence",
      opportunities: "High-conf picks",
    },
    metricHints: {
      totalMarkets: "Polymarket match outcomes",
      volume24h: "PM moneyline market sum",
      pmLiquidity: "Gamma-reported liquidity",
      activeTraders: "Market-level unique wallet sum",
      holderDepth: "Visible top holders only",
      closingSoon: "Within 24 hours",
      divergence: "Cross-platform gap >= 3pp",
      opportunities: "score ≥70",
    },
    sections: {
      highLiquidity: "High Liquidity Markets",
      divergence: "Odds Divergence",
      divergenceSub: "cross-platform implied probability gap",
      closing: "Closing Soon",
      closingSub: "within 24h",
      topOpps: "Top Market Opportunities",
      topOppsSub: "one unified score, risk-adjusted",
      fullRanking: "Open full ranking",
      ranking: "Unified Opportunity Ranking",
      rankingSub: "hot, liquid, divergent, and risk-adjusted",
      sourceOdds: "Multi-platform odds comparison",
      related: "Related Markets",
      priceTrend: "Price Trend",
      riskPanel: "Risk Panel",
      matchSummary: "AI Match Summary",
      walrusProof: "Walrus Proof",
    },
    labels: {
      home: "Home",
      draw: "Draw",
      away: "Away",
      groupStage: "Group Stage",
      stage: "Stage",
      start: "Start",
      venue: "Venue",
      status: "Status",
      fixture: "Fixture",
      detail: "Detail",
      follow: "Follow",
      share: "Share",
      countdown: "Until start",
      live: "Live",
      pending: "Pending",
      marketConsensus: "market consensus",
      aiProbabilityPending: "AI probability pending",
      noFabrication: "Structured AI probabilities are not fabricated from market data.",
      sampled: "sampled",
      topCap: "top cap",
      price: "price",
      marketProb: "market prob",
      aiProb: "AI prob",
      gap: "gap",
      liq: "liq",
      traders: "24h traders",
      spread: "spread",
      volume: "volume",
      holderConc: "Top holder conc.",
      close: "close",
      currentPrice: "Current Price",
      platform: "Platform",
      marketType: "Market Type",
      outcome: "Outcome",
      score: "Score",
      confidence: "Confidence",
      action: "Action",
      risk: "Risk",
      insufficient: "Data insufficient",
      tbd: "TBD",
      rows: "rows",
      latest: "Latest",
      network: "Network",
      blob: "Blob",
      generated: "Generated",
      published: "Published",
      schema: "Schema",
      syncDelayed: "Walrus sync delayed",
      notPublished: "Not published yet",
    },
    empty: {
      liquidity: "PM liquidity metrics will appear after the next collector run.",
      divergence: "No divergence signal yet.",
      closing: "No markets closing within 24h.",
      trend: "Trend data is still accumulating.",
      matchNotFound: "This match was not found. It may be completed or outside the current read window.",
      walrus: "The latest Walrus blob will appear after export/publish.",
    },
    footer: "Purely local read-only aggregation for personal research. Not financial advice, not betting advice, and not a guarantee of profit. PM holder depth is top-holder data only; active traders may be sampled when API limits are hit.",
    oppFooter: "Actions are screening labels only: Watch, Set Alert, Be Cautious, or Not Recommended. They are not betting instructions.",
  },
} as const;

export type Copy = (typeof COPY)[Locale];

export const RISK_LEVEL_LABELS: Record<Locale, Record<RiskLevel, string>> = {
  zh: {
    low: "低摩擦",
    watch: "值得关注",
    elevated: "风险升高",
    insufficient: "数据不足",
  },
  en: {
    low: "Low friction",
    watch: "Worth watching",
    elevated: "Risk elevated",
    insufficient: "Data insufficient",
  },
};

export const ACTION_LABELS: Record<Locale, Record<SuggestedAction, string>> = {
  zh: {
    watch: "观察",
    set_alert: "设提醒",
    be_cautious: "谨慎",
    not_recommended: "暂不推荐",
  },
  en: {
    watch: "Watch",
    set_alert: "Set Alert",
    be_cautious: "Be Cautious",
    not_recommended: "Not Recommended",
  },
};

export const TAG_LABELS: Record<Locale, Record<OpportunityTag, string>> = {
  zh: {
    high_heat: "高热度",
    high_liquidity: "高流动性",
    odds_divergence: "赔率分歧",
    ai_probability_pending: "AI 概率待生成",
    closing_soon: "即将关闭",
    price_movement: "价格移动",
    beginner_friendly: "新手友好",
    high_risk: "高风险",
    data_missing: "数据缺失",
    sampled: "Sampled",
    model_edge: "模型偏离",
  },
  en: {
    high_heat: "High Heat",
    high_liquidity: "High Liquidity",
    odds_divergence: "Odds Divergence",
    ai_probability_pending: "AI Probability Pending",
    closing_soon: "Closing Soon",
    price_movement: "Price Movement",
    beginner_friendly: "Beginner Friendly",
    high_risk: "High Risk",
    data_missing: "Data Missing",
    sampled: "Sampled",
    model_edge: "Model Edge",
  },
};

export const RISK_SIGNAL_TITLES: Record<Locale, Record<RiskSignalKey, string>> = {
  zh: {
    liquidity: "流动性风险",
    holder_concentration: "Holder 集中度风险",
    thin_trading: "交易深度风险",
    volatility: "波动风险",
  },
  en: {
    liquidity: "Liquidity Risk",
    holder_concentration: "Holder Concentration Risk",
    thin_trading: "Thin Trading Risk",
    volatility: "Volatility Risk",
  },
};

export const RISK_NOTES: Record<Locale, Record<RiskNoteKey, string>> = {
  zh: {
    liquidity_missing: "尚未采集到 Polymarket Gamma liquidity 字段。",
    liquidity_thin: "流动性较薄或价差较宽，价格信号可能更嘈杂。",
    liquidity_watch: "市场可用，但流动性还不算很深。",
    liquidity_deep: "Polymarket 流动性较深，适合做更干净的信号读取。",
    holder_missing: "本次快照缺少 top holder 数据。",
    holder_dominant: "可见 top holder 集合中单一 holder 占比较高。",
    holder_watch: "Top holder 深度有限或集中度略高。",
    holder_distributed: "可见 top holders 分布相对健康。",
    trading_missing: "尚未采集到近 24h 交易活跃度。",
    trading_thin: "近期参与较薄，价格变化可能夸大真实共识。",
    trading_watch: "有交易参与，但广度还不算强。",
    trading_broad: "近 24h PM 交易广度支持更稳定的解读。",
    volatility_sharp: "近期 Polymarket 价格移动较剧烈。",
    volatility_watch: "近期价格移动值得关注。",
    volatility_contained: "近期价格波动处于可控范围。",
  },
  en: {
    liquidity_missing: "Polymarket Gamma liquidity has not been captured yet.",
    liquidity_thin: "Thin liquidity or wide spread can make price signals noisy.",
    liquidity_watch: "Market is usable, but liquidity is not especially deep.",
    liquidity_deep: "Polymarket liquidity is deep enough for cleaner signal reading.",
    holder_missing: "Top holder data is unavailable for this market snapshot.",
    holder_dominant: "One top holder dominates the visible holder set.",
    holder_watch: "Top holder depth is modest or somewhat concentrated.",
    holder_distributed: "Visible top holders are reasonably distributed.",
    trading_missing: "Recent trade activity has not been captured yet.",
    trading_thin: "Recent participation is thin, so moves can overstate conviction.",
    trading_watch: "Participation is present but not broad.",
    trading_broad: "Recent PM trading breadth supports a cleaner read.",
    volatility_sharp: "Recent Polymarket movement is sharp.",
    volatility_watch: "Recent movement is worth monitoring.",
    volatility_contained: "Recent price movement is contained.",
  },
};

export function outcomeLabel(locale: Locale, label: Label): string {
  return COPY[locale].labels[label];
}

export function marketTypeLabel(locale: Locale, marketType: string): string {
  if (marketType === "match_winner") return locale === "zh" ? "胜平负" : "Match Winner";
  return marketType;
}

export function explainMarket(locale: Locale, parts: MarketExplanationParts): string {
  if (locale === "zh") {
    const liquidity = parts.liquidity !== null ? `PM liquidity ${compactMoney(parts.liquidity)}` : "PM liquidity 待采集";
    const traders =
      parts.activeTraders !== null
        ? `24h active traders ${compactNumber(parts.activeTraders)}${parts.sampled ? " (sampled)" : ""}`
        : "active traders 待采集";
    const concentration = parts.concentration !== null ? `top-holder concentration ${percent(parts.concentration)}` : "top-holder concentration 待采集";
    return `${liquidity}，${traders}，${concentration}；跨平台概率差 ${parts.divergencePp.toFixed(1)}pp。`;
  }
  const liquidity = parts.liquidity !== null ? `PM liquidity ${compactMoney(parts.liquidity)}` : "PM liquidity data is pending";
  const traders =
    parts.activeTraders !== null
      ? `${compactNumber(parts.activeTraders)} active traders in 24h${parts.sampled ? " (sampled)" : ""}`
      : "active trader data is pending";
  const concentration = parts.concentration !== null ? `top-holder concentration ${percent(parts.concentration)}` : "top-holder concentration pending";
  return `${liquidity}, ${traders}, and ${concentration}; cross-platform gap is ${parts.divergencePp.toFixed(1)}pp.`;
}

export function briefTitle(locale: Locale, item: AiBriefItem): string {
  const titles = {
    zh: {
      market_pulse: "市场脉搏",
      top_opportunity: "Top 机会",
      largest_divergence: "最大赔率分歧",
      closing_soon: "即将关闭",
      risk_alert: "风险提示",
    },
    en: {
      market_pulse: "Market Pulse",
      top_opportunity: "Top Opportunity",
      largest_divergence: "Largest Divergence",
      closing_soon: "Closing Soon",
      risk_alert: "Risk Alert",
    },
  } as const;
  return titles[locale][item.key];
}

export function briefTag(locale: Locale, item: AiBriefItem): string {
  const tags = {
    zh: {
      signal: "信号",
      worth_watching: "值得关注",
      odds_gap: "赔率差",
      set_alert: "设提醒",
      risk_elevated: "风险升高",
      calm: "平稳",
    },
    en: {
      signal: "Signal",
      worth_watching: "Worth watching",
      odds_gap: "Odds gap",
      set_alert: "Set alert",
      risk_elevated: "Risk elevated",
      calm: "Calm",
    },
  } as const;
  return tags[locale][item.tag];
}

export function briefText(locale: Locale, item: AiBriefItem, match = item.match, outcomeName = item.outcomeName): string {
  const count = item.count ?? 0;
  if (locale === "zh") {
    if (item.key === "market_pulse") return `${count} 场比赛因 PM liquidity、volume、参与度或价格移动出现热度升高。`;
    if (item.key === "top_opportunity") {
      return match && outcomeName ? `${outcomeName} · ${match} 当前机会评分 ${item.score ?? "-"}。` : "当前暂无可排序市场。";
    }
    if (item.key === "largest_divergence") {
      return match ? `${match} 的跨平台隐含概率差达到 ${(item.gapPp ?? 0).toFixed(1)}pp。` : "当前暂无跨平台分歧数据。";
    }
    if (item.key === "closing_soon") return `${count} 个活跃市场将在 24h 内关闭。`;
    return count ? `${count} 场比赛存在流动性、holder、交易或波动风险升高。` : "当前扫描中没有明显升高的 PM 市场风险。";
  }
  if (item.key === "market_pulse") return `${count} matches show elevated heat from PM liquidity, volume, participation, or price movement.`;
  if (item.key === "top_opportunity") {
    return match && outcomeName ? `${outcomeName} in ${match} leads the ranking with score ${item.score ?? "-"}.` : "No ranked market is available yet.";
  }
  if (item.key === "largest_divergence") {
    return match ? `${match} shows a ${(item.gapPp ?? 0).toFixed(1)}pp cross-platform probability gap.` : "No cross-platform divergence is available yet.";
  }
  if (item.key === "closing_soon") return `${count} active markets close within 24h.`;
  return count ? `${count} matches have elevated liquidity, holder, trading, or volatility risk.` : "No elevated PM market risk across the current scan.";
}
