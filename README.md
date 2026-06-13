# wc26-board

2026 世界杯赔率聚合 dashboard(**个人研究/本地只读**:只读聚合 + 分析,不下单、不托管公开运行实例;公开仓库只包含源码,不包含 `.env`、SQLite、日志或导出数据)。

当前状态:Phase E+ 完成 — board 已升级为 premium market intelligence UI(左侧导航、AI Brief、Polymarket liquidity/participation 风险面板、机会榜、详情页),支持 `?lang=zh|en` 中英文切换;新增 Walrus sanitized public snapshot 导出/发布命令;新增近似开球时间 fixture 归并、health split 检查、移动端溢出修复和 board 端口回退。
Phase D 同步完成:Polymarket `participants` 不再显示为全市场人数,改为 `PM active traders 24h` 与 `Top holder depth`;`liquidity` 使用 Gamma market 字段,holder/trade 数据失败时降级且 sampled 可见。
体彩竞彩保持**手动低频抓取/导入**,不进 daemon 高频轮询。AI 一键分析可在 `.env` 通过 `AI_PROVIDER` 选择 `anthropic` / `deepseek` / `kimi` / `openai-compatible`(不配 key 则降级为 prompt 预览+复制);告警推送需配 `SERVERCHAN_KEY`(不配则只落库、页面可见)。

## 快速开始

```bash
npm install
cp .env.example .env        # 填 ODDS_API_KEY(the-odds-api.com 免费注册;不填则纯 Polymarket 模式)
npm run bootstrap           # 建库 + 赛程导入 + 首轮快照
npm run status              # 体检
npm run health              # Phase A 健康检查(失败时非 0 exit)
npm run current             # 查看下一批比赛的三向归一概率(home/draw/away)
npm run board               # 决策 board:默认 http://127.0.0.1:4626;占用时自动尝试 4627-4636
npm run avoid:sporttery     # 体彩相对国际盘概率偏高的避坑排行
npm run fetch:sporttery     # 低频手动抓取中国竞彩 HAD/HHAD
npm run import:sporttery -- data/imports/sporttery.csv # 半自动导入竞彩胜平负 SP
npm run export:walrus       # 生成 sanitized Walrus JSON 快照到 data/walrus-feed/
npm run publish:walrus:testnet # 使用 WALRUS_PUBLISHER_URL 发布快照 manifest 到 Walrus testnet
bash bin/install-launchd.sh # 常驻采集(launchd KeepAlive)
tail -F logs/daemon.log
```

## 当前能力

- SQLite 本地库: `event / market / outcome / snapshot / meta`,snapshot 只追加;`event.fixture_key` 用于跨源合并同一场比赛。同队同日且开球时间相差不超过 45 分钟的源事件会统一到 canonical fixture,优先书商/OddsAPI 赛程,其次 Polymarket,避免 `USA vs Paraguay` 这类 2 分钟偏差拆成两场。
- Polymarket:daemon 默认 5min 抓冠军盘 + 单场主三元;严格过滤 `fifwc-{home}-{away}-{date}` 主事件,跳过 props/半场/比分等衍生盘。
- Kalshi:daemon 默认 5min 抓冠军盘(`KXMENWORLDCUP-26`,48 队二元)+ 单场系列(`KXWCGAME`,两队+TIE 三个二元);公开行情接口无需鉴权,按队名+赛日挂到现有 fixture,不造孤立 event。
- The Odds API:有 key 时按免费层约 90min 抓欧洲区 `h2h` 书商 1X2;配额写入 `meta`,由 `npm run status` 显示。
- 体彩竞彩:用官方计算器公开 JSON 接口手动低频抓 `HAD`/`HHAD`;如果被 WAF 拦截,退回本地 CSV/JSON 导入。
- 当前读层: `npm run current` 输出下一批比赛的 Polymarket / Kalshi / Pinnacle / 体彩 HAD / 书商中位三向归一概率。
- 避坑指数: `npm run avoid:sporttery` 输出体彩 HAD 隐含概率高于国际书商共识的选项,用于识别相对不划算方向,不是投注建议。
- 决策 board: `npm run board` 起本地只读页面(默认 127.0.0.1:4626;默认端口占用时自动尝试 4627-4636)——premium dark market radar,支持 `?lang=zh|en`;首页显示 PM liquidity、24h active traders、top holder depth、机会榜、AI Brief、Walrus Proof;详情页显示 match hero、多平台 odds、PM market metrics、price trend、team basics、risk panel。
- Polymarket market intelligence:Gamma `liquidityNum/liquidityClob`、`volume24hr/volumeNum`、`spread`、`lastTradePrice`、`conditionId` 落库;Data API `/holders` 只作为 top-holder depth/concentration,`/trades` 只作为 24h active traders/trade count,永不包装成 total participants。
- Walrus public data feed:`npm run export:walrus` 导出 aggregate-only JSON(`radar-latest.json`,`opportunities-latest.json`,`matches/*.json`,`manifest-latest.json`);`npm run publish:walrus:testnet` 可通过 publisher 上传并把最新 manifest blob 写入 `meta` 供 UI 显示。
- LIVE: 开球后 2.5h 内场次不消失——主页置顶「进行中」(LIVE 徽标+已比分钟数),体彩标注已停售并退出避坑比价;PM/Kalshi 盘中实时概率照常流入。
- 告警: daemon 每分钟检测**主力源盘口突变(≥3pp)**、**体彩 vs 共识新条目**、**health FAIL**,`alert_log` 表 UNIQUE 去重;配 `SERVERCHAN_KEY` 后合并成一条微信推送(免费配额小,绝不一事一推,另有 `ALERT_MAX_PER_DAY` 日上限,默认 5);Server酱请求用独立直连 Agent 绕开 HTTPS_PROXY。
- AI 分析: 详情页一键生成结构化解读(倾向/信号/风险/体彩视角),prompt 透明可编辑,分析历史落库;调用层可插拔,默认 Anthropic,也支持 DeepSeek/Kimi/其它 OpenAI-compatible `/chat/completions`;数据组装为 ~1.5k tokens 高密度上下文(归一概率、预计算价差、关键点走势、夺冠锚、新鲜度)。

## 命令

| 命令 | 作用 |
|---|---|
| `npm run bootstrap` | 建库,导入 Odds API 赛程/书商盘,抓 Polymarket 冠军盘 + 单场盘 |
| `npm run poll` | 手动跑一轮 Polymarket/OddsAPI 采集 |
| `npm run daemon` | 前台跑常驻采集进程 |
| `bash bin/install-launchd.sh` | 安装 macOS launchd KeepAlive daemon |
| `npm run board` | 本地只读决策 board(默认 http://127.0.0.1:4626;默认端口占用时自动尝试 4627-4636) |
| `npm run status` | 查看事件/fixture 数、各源快照量、最新时间、API 配额 |
| `npm run health` | 健康检查:fixture key、近似同场 split、覆盖率、PM/Kalshi 延迟、OddsAPI/体彩新鲜度 |
| `npm run current -- --limit=8` | 查看当前三向归一概率(home/draw/away) |
| `npm run avoid:sporttery -- --limit=20 --threshold=2` | 体彩 HAD 相对国际书商均值偏高的避坑排行 |
| `npm run fetch:sporttery` | 手动抓取官方竞彩计算器 HAD/HHAD |
| `npm run import:sporttery -- <file>` | 从本地 CSV/JSON 导入竞彩 HAD 兜底数据 |
| `npm run export:walrus` | 导出 sanitized public JSON 快照到 `data/walrus-feed/` |
| `npm run publish:walrus:testnet` | 发布 Walrus feed;需 `.env` 配 `WALRUS_PUBLISHER_URL` |

## Walrus / Overflow 数据层

Walrus feed 是公开、可验证的数据快照,用于 hackathon/demo 的 data layer 叙事,不是把本地数据库直接公开。

- 发布内容:聚合后的 match/opportunity/market metrics、risk signals、sampled flags、source freshness、schema/version/hash。
- 不发布内容:API keys、私钥、完整 SQLite、raw holder wallet addresses、个人配置。
- 默认目录:`data/walrus-feed/`(已 gitignore)。
- schema:`wc26.market_radar.v1`。
- testnet 发布:设置 `WALRUS_PUBLISHER_URL` 后运行 `npm run publish:walrus:testnet`;成功后 UI 的 `Walrus Proof` 面板展示最新 manifest blob/network/schema/published time。
- Overflow 定位:优先按 Walrus Specialized Track 讲“AI-assisted sports market intelligence + verifiable off-chain data snapshots”,避免 betting 推荐叙事。

## AI provider 配置

详情页 AI 分析默认走 Anthropic,保持旧 `.env` 兼容;大陆环境可把 `AI_PROVIDER` 切到 DeepSeek/Kimi/其它 OpenAI-compatible 服务。无 key 时页面仍展示完整 prompt,可复制到任意 AI 手动使用。

| provider | `AI_PROVIDER` | 默认 base | 默认模型 | key |
|---|---|---|---|---|
| Anthropic | `anthropic` | `https://api.anthropic.com` | `claude-sonnet-4-6` | `ANTHROPIC_API_KEY` |
| DeepSeek | `deepseek` | `https://api.deepseek.com` | `deepseek-v4-flash` | `DEEPSEEK_API_KEY` |
| Kimi/Moonshot | `kimi` | `https://api.moonshot.cn/v1` | `kimi-k2.6` | `KIMI_API_KEY` 或 `MOONSHOT_API_KEY` |
| 通用兼容口 | `openai-compatible` | 必填 | 必填 | `OPENAI_COMPAT_API_KEY` 或 `OPENAI_API_KEY` |

DeepSeek thinking 可用 `DEEPSEEK_THINKING=on`,此时默认切到 `DEEPSEEK_THINKING_MODEL=deepseek-v4-pro` 并带 `reasoning_effort=high`。Kimi 默认 `KIMI_DEFAULT_TEMPERATURE=1`,避免 K2 系列拒绝任意温度值。分析结果的 `model` 字段会以 `provider:model` 形式写入 `ai_analysis`,方便回看不同模型输出。

DeepSeek 示例:

```env
AI_PROVIDER=deepseek
DEEPSEEK_API_KEY=...
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_CHAT_MODEL=deepseek-v4-flash
```

Kimi 示例:

```env
AI_PROVIDER=kimi
KIMI_API_KEY=...
KIMI_BASE_URL=https://api.moonshot.cn/v1
KIMI_CHAT_MODEL=kimi-k2.6
KIMI_DEFAULT_TEMPERATURE=1
```

其它 OpenAI-compatible 示例:

```env
AI_PROVIDER=openai-compatible
OPENAI_COMPAT_API_KEY=...
OPENAI_COMPAT_BASE_URL=https://example.com/v1
OPENAI_COMPAT_MODEL=your-chat-model
```

## 数据源

| 源 | 认证 | 频率 | 内容 |
|---|---|---|---|
| Polymarket Gamma | 无需 | 5min | 冠军盘(60 队二元)+ 单场主三元(series `soccer-fifwc` id=11433,每场 3 个 moneyline 二元:主胜/客胜/平局) |
| Kalshi | 无需(公开行情) | 5min | 冠军盘 `KXMENWORLDCUP-26`(48 队二元)+ 单场 series `KXWCGAME`(每场两队+TIE 三个二元) |
| The Odds API | key(免费 500/月) | 90min(免费层) | 书商 1X2,欧洲区;credit=市场数×地区数 |
| 体彩竞彩 | 官方公开计算器接口/手工 CSV | 手动低频 | 胜平负 HAD + 让球胜平负 HHAD |

## 体彩接入

`npm run fetch:sporttery` 调用中国竞彩网足球胜平负计算器页面使用的公开 JSON 接口:

- 页面:`https://www.sporttery.cn/jc/jsq/zqspf/`
- 数据:`https://webapi.sporttery.cn/gateway/uniform/football/getMatchCalculatorV1.qry?channel=c&poolCode=hhad%2Chad`
- 写库:`source='sporttery'`;`market_type='sporttery_had'` 或 `sporttery_hhad`
- HAD 用于 `npm run current` 的 `sporttery` 列;HHAD 先入库,后续单独做让球视图/避坑指数。

边界:只手动低频触发,不登录,不绕验证码/签名/WAF,不代理池,不并发,不接入 daemon 高频轮询。如果接口被 WAF 拦截,退回手工文件导入。

把手工导出的文件放到 `data/imports/` 后运行 `npm run import:sporttery -- data/imports/sporttery.csv`。CSV 表头支持英文或常见中文名:

```csv
home_team,away_team,kickoff_local,home_win,draw,away_win,match_id
Canada,Bosnia & Herzegovina,2026-06-13 03:00,1.91,3.68,4.92,had-001
```

也支持 `主队,客队,比赛时间,胜,平,负,场次`。无时区的比赛时间按北京时间解析;JSON 输入可为数组,或包含 `matches`/`data`/`rows` 数组的对象。

## 体彩避坑指数

`npm run avoid:sporttery -- --limit=20 --threshold=2` 只读本地库,比较体彩 HAD 三向归一概率与国际书商共识(`book_avg`,自 Phase B 起为**中位数**——实测单家书商会出现 ±37pp 的离群/过期盘,均值会被拖偏)。

- `diff_pp = (sporttery_prob - book_avg_prob) * 100`
- 默认只显示 `diff_pp >= 2.0` 且国际书商数 `books >= 5` 的选项。
- outcome 显示为主队名 / `draw` / 客队名,避免误读 home/away。
- 这个排行表示“体彩隐含概率相对偏高、回报相对不划算”,不是下注建议。

## 实测备注

- 主事件 ticker `fifwc-{home}-{away}-{date}`;带后缀的是子事件(Player Props/Halftime/Exact Score 等),必须按严格 ticker 正则过滤,否则污染 event 表
- 三个二元价加总 ≈1.015(独立交易的 overround),三向归一(multiplicative)放读取层
- 体彩官方接口返回中文队名;`teams.ts` 维护中文别名,用于合并到现有英文 fixture。
- **launchd 不继承 shell 代理变量**:HTTPS_PROXY 必须写进 `.env`,大陆直连 gamma-api 高频 HTTP 000
- Kalshi 价格字段已迁移为 `*_dollars` 字符串(`response_price_units=usd_cent`),旧整数 cent 字段不再返回;冠军盘 series `KXMWORLDCUP` 是空壳,正确的是 `KXMENWORLDCUP`;单场 API 不给精确 kickoff,按队名+赛日±1 天匹配现有 fixture。
- 部分源开球时间会有 2-30 分钟偏差;启动/写入时会把同队同日 45 分钟内事件归并到一个 canonical `fixture_key`,health 会 fail 任何未来 split。

## 设计要点(来源:三模型讨论,raw 在 sui-research/sources/raw/wc26-*-2026-06-12.md)

- 4+1 表 schema:event / market / outcome / snapshot / meta;snapshot 只追加,存原始价+隐含概率,devig 在读取层
- 跨源同场比赛用 `fixture_key = normalized(home)|normalized(away)|kickoff_utc` 对齐;source event id 保留原样。由于源之间 kickoff 可能有分钟级偏差,同队同日 45 分钟内事件会统一到 canonical key(书商/OddsAPI 优先,其次 Polymarket)。
- 大陆直连 PM 链路偶发 HTTP 000:所有请求 3 次重试+退避,单源故障不拖垮整轮
- 球队名归一:normalize + 别名表 + 包含兜底;unmatched 必打日志
- Odds API 配额硬保护:间隔不到 80% 不发请求;配额余量记录在 meta 表(`npm run status` 可见)

## 后续阶段

- Phase A 观测:跑满 24h 增长验证,按 unmatched/health 输出继续补队名别名和源覆盖。这是剩余观测项,不是功能缺口。
- ~~Kalshi 接入~~:已完成(冠军盘 + 单场,daemon 5min)。
- ~~Phase B 决策 dashboard~~:已完成(`npm run board`):比赛卡片流(共识条 + 体彩 diff 着色 + sparkline)、避坑/划算双榜、夺冠 Top10(PM vs Kalshi 互证)、详情页全源表 + 48h 三向走势 + HHAD、health 摘要;书商共识用中位数抗离群。
- ~~Phase B AI 分析面板~~:已完成:`src/ai/context.ts` 组装高密度上下文,`src/ai/analyze.ts` 通过 provider registry 调 Anthropic 或 OpenAI-compatible 口(DeepSeek 默认 `https://api.deepseek.com` + `deepseek-v4-flash`;Kimi 默认 `https://api.moonshot.cn/v1` + `kimi-k2.6`;`.env` 可覆盖),结果落 `ai_analysis` 表;模板存 meta 可在页面编辑;无 key 降级为复制 prompt。**待办:配任一 provider key 后跑一次真实调用验证。**
- ~~Phase C~~:已完成:HHAD 让球盘主页面板、Server酱告警(实测推送+去重通过)、LIVE 进行中场次(待 6/13 凌晨开赛实测观感)。
- ~~Phase D/E~~:已完成:PM market intelligence、active traders/top-holder 口径修正、premium radar UI、中英文切换、Walrus sanitized feed、fixture split 修复、health 覆盖和 board 端口回退。
- 后续候选:AI 批量分析当日场次(早报)、让球盘公平概率建模(由 1X2 推导,需进球模型)、完赛比分采集。

## 交接检查清单

- `npm exec tsc -- --noEmit` 通过。
- `npm run health` 无 FAIL;WARN 可接受但必须能解释(例如 OddsAPI 配额低频、体彩手动低频);必须包含 approximate fixture merge check。
- `npm run status` 可查看 source/fixture/snapshot/API 配额状态。
- `npm run current -- --limit=4` 可正常读取下一批比赛三向概率。
- `npm run avoid:sporttery` 可输出体彩 HAD 相对国际书商均值偏高的排行。
- `env AI_PROVIDER=deepseek DEEPSEEK_API_KEY=dummy node --import tsx -e 'const m = await import("./src/ai/analyze.ts"); console.log(m.currentAiProvider())'` 可看到 DeepSeek 默认 base/model,且不发外部请求。
- `git diff --check` 无空白错误。
- 只读 SQL 确认:`event.fixture_key` 无空值、无孤立 `sporttery-*` event、近似同场 split 为 0、Polymarket 单场 fixture 覆盖约 70、snapshot 行数持续增长。
- 浏览器检查:桌面/移动端 `?lang=zh|en` 首页、机会页、详情页无 console error;英文页无残留中文 UI 文案;390px 宽度无整页横向滚动。
- Public repo 前检查:`.env`、SQLite、logs、`data/walrus-feed/` 均被 ignore;tracked 文件中无真实 key/token/private key。

## 推荐提交摘要

推荐 commit title:`Phase E+: review, fixture merge, docs, and public repo prep`

- fixture:近似开球时间 canonical merge,health split 检查,current/board 去重。
- board:英文 UI 文案补齐、移动端溢出修复、默认端口自动回退。
- docs:README 与 `docs/REVIEW_CHECKLIST.md` 更新,Public repo 前敏感信息边界确认。

## 合规边界

源码可公开;运行实例、`.env`、SQLite、日志、raw 导入和 Walrus 本地导出数据不公开提交。不做任何下注引导/代购;避坑指数只表达相对不划算信号,不构成投注建议、金融建议或收益承诺。体彩接口只做公开页面同源数据的低频读取;不登录、不绕验证码/签名/WAF、不代理池、不自动化高频抓取。
