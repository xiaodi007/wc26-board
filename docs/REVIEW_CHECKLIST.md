# WC26 Board Review Checklist

Last reviewed: 2026-06-13

## Scope

- Review all local CLI, data, board, API, export, docs, and public-repo readiness paths.
- Do not publish Walrus testnet data during review.
- Do not call a real AI provider during review; only verify provider selection and no-key fallback.
- Keep `.env`, SQLite databases, logs, imports, and Walrus local export artifacts out of Git.

## Functional Checks

Run before commit:

```bash
npm exec tsc -- --noEmit
git diff --check
npm run status
npm run health
npm run results
npm run current -- --limit=4
npm run avoid:sporttery -- --limit=8 --threshold=2
env AI_PROVIDER=deepseek DEEPSEEK_API_KEY=dummy node --import tsx -e 'const m = await import("./src/ai/analyze.ts"); console.log(m.currentAiProvider())'
npm run export:walrus
```

Expected:

- `npm run health` has no FAIL and includes `approximate fixture merge check clean`.
- `npm run current -- --limit=4` shows `USA vs Paraguay` once, with Polymarket, Kalshi, Sporttery, and book median present.
- `npm run results` exits 0 and updates source-status metadata even when a
  fallback source matches zero rows.
- `npm run export:walrus` writes JSON artifacts under ignored `data/walrus-feed/`.
- AI provider dummy check prints DeepSeek base/model and makes no network request.

## Browser Checks

Use local board after starting:

```bash
npm run board
```

Expected:

- If `127.0.0.1:4626` is already in use and no `BOARD_PORT`/`PORT` is set, server logs a retry and starts on the next free port from `4627-4636`.
- Desktop `/`, `/?lang=zh`, `/radar`, `/radar?lang=en`,
  `/alerts?lang=zh`, `/opportunities?lang=zh`, `/review?lang=zh`, and a
  `/match?...&lang=zh` detail page load with no console errors.
- The root page is the judge/user landing page, and the live dashboard is at `/radar`.
- The sidebar price-alert link opens `/alerts?lang=zh`; `/radar?lang=zh#alerts`
  remains a working in-page fallback.
- `/review?lang=zh` shows scorelines for matched completed matches. The outer
  card score block shows both teams, with winner green, loser red, and draws in
  the neutral/amber state. When no `API_FOOTBALL_KEY` is configured, the page
  must clearly say score-only fallbacks do not provide goal-event timelines.
- `/radar?lang=zh` and `/` show matched final scores on match cards when
  `match_result` has a score, and they do not show fake score placeholders for
  future/unmatched fixtures.
- Priority match cards show a PM funding distribution bar or a clear unavailable state.
- 1X2 probability groups highlight only the highest probability item; lower
  probabilities should not be colored red as if they were match results.
- English UI does not show leftover Chinese UI labels such as `书商`, `体彩`, `走势积累中`, `风险升高`, or `数据不足`.
- English match pages may contain the language switch label `中文`, but should
  not render Chinese AI prompt templates as ordinary English UI. Prompt content
  can be hidden behind `data-prompt-b64` and copied through the copy action.
- Mobile width around 390px has no body-level horizontal scroll. Wide tables may scroll inside their own table containers.
- No-key AI analysis fallback shows copy-prompt mode and `/api/analyze?...&lang=en` returns an English no-key message.
- `/api/probability` defaults to compact JSON well below the previous multi-MB
  payload. Use `?detail=full` or `?fk=<fixture_key>` for full detail.

## Data Integrity

Expected:

- `event.fixture_key` has no null/empty values.
- No `sporttery-*` standalone event rows exist.
- Same normalized teams on the same UTC day and within 45 minutes share one `fixture_key`.
- Known prior splits are merged:
  - Canada vs Bosnia and Herzegovina
  - USA/United States vs Paraguay
  - Brazil vs Haiti
- Polymarket match fixture coverage remains about 70.

## Public Repo Readiness

Run before `gh repo create`:

```bash
git check-ignore -v data/wc26.db data/walrus-feed/manifest-latest.json .env logs/daemon.log
rg -n "(API_KEY|SECRET|TOKEN|PRIVATE|PASSWORD|gho_|sk-|BEGIN .*PRIVATE)" -S --glob '!node_modules/**' --glob '!data/**' --glob '!logs/**' --glob '!.env' .
git status --short
```

Expected:

- `.env`, `*.db`, `logs/`, `data/imports/`, and `data/walrus-feed/` are ignored.
- Secret scan only finds variable names, placeholders, or documentation examples, not real credentials.
- Commit contains source/docs/config examples only.

## Publish Steps

After checks pass:

```bash
git add .
git commit -m "Phase E+: review, fixture merge, docs, and public repo prep"
gh repo create xiaodi007/wc26-board --public --source=. --remote=origin --push
gh repo view xiaodi007/wc26-board --json nameWithOwner,visibility,url
```

Expected:

- Remote `origin` points to the new public GitHub repo.
- `main` is pushed.
- Repo URL is reachable.
