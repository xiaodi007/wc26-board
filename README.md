# wc26-board

2026 世界杯赔率聚合 dashboard(**纯个人自用**:只读聚合 + 分析,不下单、不对外发布)。

当前为 Phase A:最小采集器,只攒赔率历史(历史不可回填,先跑起来)。
UI + AI 分析窗口为 Phase B(2026-06-21 后,见 `~/.claude/plans/dashboard-poly-market-keshi-serialized-pizza.md`)。

## 快速开始

```bash
npm install
cp .env.example .env        # 填 ODDS_API_KEY(the-odds-api.com 免费注册;不填则纯 Polymarket 模式)
npm run bootstrap           # 建库 + 赛程导入 + 首轮快照
npm run status              # 体检
bash bin/install-launchd.sh # 常驻采集(launchd KeepAlive)
tail -F logs/daemon.log
```

## 数据源

| 源 | 认证 | 频率 | 内容 |
|---|---|---|---|
| Polymarket Gamma | 无需 | 5min | 冠军盘(60 队二元)+ 单场主三元(series `soccer-fifwc` id=11433,每场 3 个 moneyline 二元:主胜/客胜/平局) |
| The Odds API | key(免费 500/月) | 90min(免费层) | 书商 1X2,欧洲区;credit=市场数×地区数 |
| Kalshi | — | — | Phase B |
| 体彩竞彩 | — | — | Phase C,半自动导入(不写爬虫) |

实测备注(2026-06-12 探明,详见 polymarket.ts 注释):
- 主事件 ticker `fifwc-{home}-{away}-{date}`;带后缀的是子事件(Player Props/Halftime/Exact Score 等),必须按严格 ticker 正则过滤,否则污染 event 表
- 三个二元价加总 ≈1.015(独立交易的 overround),三向归一(multiplicative)放读取层
- **launchd 不继承 shell 代理变量**:HTTPS_PROXY 必须写进 `.env`,大陆直连 gamma-api 高频 HTTP 000

## 设计要点(来源:三模型讨论,raw 在 sui-research/sources/raw/wc26-*-2026-06-12.md)

- 4 表 schema:event / market / outcome / snapshot(只追加,存原始价+隐含概率,devig 在读取层)
- 大陆直连 PM 链路偶发 HTTP 000:所有请求 3 次重试+退避,单源故障不拖垮整轮
- 球队名归一:normalize + 别名表 + 包含兜底;unmatched 必打日志
- Odds API 配额硬保护:间隔不到 80% 不发请求;配额余量记录在 meta 表(`npm run status` 可见)

## 合规边界

纯本地、无账号、无分享、私有仓库。不对外发布含境外赔率展示的版本;不做任何下注引导/代购(刑事红线,详见计划文件合规节)。
