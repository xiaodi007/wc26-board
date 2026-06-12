# wc26-board

2026 世界杯赔率聚合 dashboard(**纯个人自用**:只读聚合 + 分析,不下单、不对外发布)。

当前状态:Phase A 基线已收口,Kalshi 已接入 daemon 轮询;采集、健康检查、当前赔率、体彩抓取/导入、避坑指数均可用,后台继续攒不可回填的赔率历史。
体彩竞彩保持**手动低频抓取/导入**,不进 daemon 高频轮询。下一步:决策 dashboard + AI 分析面板。

## 快速开始

```bash
npm install
cp .env.example .env        # 填 ODDS_API_KEY(the-odds-api.com 免费注册;不填则纯 Polymarket 模式)
npm run bootstrap           # 建库 + 赛程导入 + 首轮快照
npm run status              # 体检
npm run health              # Phase A 健康检查(失败时非 0 exit)
npm run current             # 查看下一批比赛的三向归一概率(home/draw/away)
npm run board               # 决策 board: http://127.0.0.1:4626(卡片流+避坑榜+夺冠+走势)
npm run avoid:sporttery     # 体彩相对国际盘概率偏高的避坑排行
npm run fetch:sporttery     # 低频手动抓取中国竞彩 HAD/HHAD
npm run import:sporttery -- data/imports/sporttery.csv # 半自动导入竞彩胜平负 SP
bash bin/install-launchd.sh # 常驻采集(launchd KeepAlive)
tail -F logs/daemon.log
```

## 当前能力

- SQLite 本地库: `event / market / outcome / snapshot / meta`,snapshot 只追加;`event.fixture_key` 用于跨源合并同一场比赛。
- Polymarket:daemon 默认 5min 抓冠军盘 + 单场主三元;严格过滤 `fifwc-{home}-{away}-{date}` 主事件,跳过 props/半场/比分等衍生盘。
- Kalshi:daemon 默认 5min 抓冠军盘(`KXMENWORLDCUP-26`,48 队二元)+ 单场系列(`KXWCGAME`,两队+TIE 三个二元);公开行情接口无需鉴权,按队名+赛日挂到现有 fixture,不造孤立 event。
- The Odds API:有 key 时按免费层约 90min 抓欧洲区 `h2h` 书商 1X2;配额写入 `meta`,由 `npm run status` 显示。
- 体彩竞彩:用官方计算器公开 JSON 接口手动低频抓 `HAD`/`HHAD`;如果被 WAF 拦截,退回本地 CSV/JSON 导入。
- 当前读层: `npm run current` 输出下一批比赛的 Polymarket / Pinnacle / 体彩 HAD / 国际书商均值三向归一概率。
- 避坑指数: `npm run avoid:sporttery` 输出体彩 HAD 隐含概率高于国际书商均值的选项,用于识别相对不划算方向,不是投注建议。

## 命令

| 命令 | 作用 |
|---|---|
| `npm run bootstrap` | 建库,导入 Odds API 赛程/书商盘,抓 Polymarket 冠军盘 + 单场盘 |
| `npm run poll` | 手动跑一轮 Polymarket/OddsAPI 采集 |
| `npm run daemon` | 前台跑常驻采集进程 |
| `bash bin/install-launchd.sh` | 安装 macOS launchd KeepAlive daemon |
| `npm run board` | 本地只读决策 board(默认 http://127.0.0.1:4626) |
| `npm run status` | 查看事件/fixture 数、各源快照量、最新时间、API 配额 |
| `npm run health` | Phase A 健康检查:fixture key、覆盖率、PM 延迟、OddsAPI/体彩新鲜度 |
| `npm run current -- --limit=8` | 查看当前三向归一概率(home/draw/away) |
| `npm run avoid:sporttery -- --limit=20 --threshold=2` | 体彩 HAD 相对国际书商均值偏高的避坑排行 |
| `npm run fetch:sporttery` | 手动抓取官方竞彩计算器 HAD/HHAD |
| `npm run import:sporttery -- <file>` | 从本地 CSV/JSON 导入竞彩 HAD 兜底数据 |

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

## 设计要点(来源:三模型讨论,raw 在 sui-research/sources/raw/wc26-*-2026-06-12.md)

- 4+1 表 schema:event / market / outcome / snapshot / meta;snapshot 只追加,存原始价+隐含概率,devig 在读取层
- 跨源同场比赛用 `fixture_key = normalized(home)|normalized(away)|kickoff_utc` 对齐;source event id 保留原样。
- 大陆直连 PM 链路偶发 HTTP 000:所有请求 3 次重试+退避,单源故障不拖垮整轮
- 球队名归一:normalize + 别名表 + 包含兜底;unmatched 必打日志
- Odds API 配额硬保护:间隔不到 80% 不发请求;配额余量记录在 meta 表(`npm run status` 可见)

## 后续阶段

- Phase A 观测:跑满 24h 增长验证,按 unmatched/health 输出继续补队名别名和源覆盖。这是剩余观测项,不是功能缺口。
- ~~Kalshi 接入~~:已完成(冠军盘 + 单场,daemon 5min)。
- ~~Phase B 决策 dashboard~~:已完成(`npm run board`):比赛卡片流(共识条 + 体彩 diff 着色 + sparkline)、避坑/划算双榜、夺冠 Top10(PM vs Kalshi 互证)、详情页全源表 + 48h 三向走势 + HHAD、health 摘要;书商共识用中位数抗离群。
- Phase B AI 分析面板:单场数据组装(~1.5k tokens 高密度上下文)、prompt 透明可编辑、Claude API 调用、分析历史落库。
- Phase C:HHAD 视图、可选告警。

## 交接检查清单

- `npm exec tsc -- --noEmit` 通过。
- `npm run health` 无 FAIL;WARN 可接受但必须能解释(例如 OddsAPI 配额低频、体彩手动低频)。
- `npm run status` 可查看 source/fixture/snapshot/API 配额状态。
- `npm run current -- --limit=4` 可正常读取下一批比赛三向概率。
- `npm run avoid:sporttery` 可输出体彩 HAD 相对国际书商均值偏高的排行。
- `git diff --check` 无空白错误。
- 只读 SQL 确认:`event.fixture_key` 无空值、无孤立 `sporttery-*` event、Polymarket 单场 fixture 覆盖约 70、snapshot 行数持续增长。

## 推荐提交摘要

推荐 commit title:`Phase A: solidify odds collector baseline`

- collector:Polymarket/OddsAPI bootstrap、daemon、status、health 基线。
- fixture alignment:`fixture_key` 迁移和跨源同场合并。
- sporttery:官方公开接口低频抓取 + CSV/JSON 兜底导入。
- read queries:`current` 三向归一和 `avoid:sporttery` 避坑排行。
- health/docs:Phase A 健康检查、命令说明、交接检查清单和下一步路线。

## 合规边界

纯本地、无账号、无分享、私有仓库。不对外发布含境外赔率展示的版本;不做任何下注引导/代购(刑事红线,详见计划文件合规节)。避坑指数只表达相对不划算信号,不构成下注建议。体彩接口只做公开页面同源数据的低频读取;不做反爬绕过和自动化高频抓取。
