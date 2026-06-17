# AI Betting Plan

The AI betting plan is a simulation and decision-support layer. It does not
place bets, route orders, custody funds, or guarantee profit.

## Provider Support

Supported providers:

- Anthropic
- DeepSeek
- Kimi/Moonshot
- generic OpenAI-compatible `/chat/completions`

Provider configuration lives in `.env.example`. If no key is configured, the
board falls back to prompt preview and copy mode.

## Temporary Keys

The board-level and match-level betting dialogs can accept temporary provider
settings for one request:

- provider;
- base URL;
- model;
- API key;
- bankroll;
- maximum daily loss.

Temporary keys, bankroll, stake amounts, and user risk inputs are not written to
`.env`, SQLite, logs, or Walrus exports.

## Inputs

The AI receives a compact market context containing:

- normalized market probabilities;
- offered odds where available;
- source freshness;
- market disagreement;
- liquidity and activity signals;
- line movement;
- match-level or board-level scope;
- risk constraints supplied by the user.

## Local Calculation

The model estimates probabilities, reasoning, risks, and cancellation
conditions. Local code then calculates:

- offered-odds based returns;
- expected value;
- 25% Kelly fraction;
- 1% bankroll single-bet cap;
- maximum daily-loss cap;
- potential net profit;
- worst-case loss.

The app uses real offered prices when available, preferring Sporttery raw SP,
then Polymarket/Kalshi ask or last prices, then bookmaker decimal odds. It does
not calculate returns from normalized probability alone.

## Output Buckets

Recommendations are grouped into:

- can buy;
- watch first;
- avoid.

These are screening labels for discipline and review. They are not betting
instructions.

## Safety Language

Use the feature as probability research and risk simulation. The project should
not claim guaranteed returns, guaranteed win-rate improvement, or financial
advice.
