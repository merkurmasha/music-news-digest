# music-news-digest

A config-driven news digest agent for the music industry/music tech space. It runs
on a schedule in self-hosted [n8n](https://n8n.io/), reads RSS feeds you configure,
scores each item for relevance with a small LLM against a rubric you write, and
sends the items that pass a threshold to your Telegram chat. Built as a portfolio
case study.

## What it does

1. Fetches items from the RSS feeds listed in `config/config.json`.
2. Deduplicates items and skips ones already sent in a previous run.
3. Scores each item (headline + short snippet only) 0–10 against the rubric in
   the config, using a small/cheap LLM. The model returns structured JSON: a
   score, a one-line summary, and a one-line "why it matters".
4. Keeps items at or above the configured threshold.
5. Sends the kept items as a digest message to your Telegram chat.
6. Logs every run (timestamp, items fetched, items kept, tokens, cost, errors)
   and tracks the last successful run, so a day the pipeline didn't run gets
   caught up on the next run.
7. A separate error workflow sends you a Telegram alert if a run fails.

## Architecture overview

```
Schedule trigger
      │
      ▼
Read config (sources, rubric, threshold, telegram target)
      │
      ▼
Fetch RSS feeds ──▶ Deduplicate (skip already-sent items)
      │
      ▼
Score each item with LLM (rubric → {score, summary, why_it_matters})
      │
      ▼
Filter: keep score >= threshold
      │
      ▼
Send Telegram digest ──▶ Append run log (counts, tokens, cost, errors)

   (any node failing above triggers the separate error workflow,
    which sends a Telegram alert)
```

Phase 1 (project scaffold) and Phase 2 (the n8n workflows) are built. Scoring
uses the Anthropic API — model `claude-haiku-5-5` by default, set in
`config/config.json` under `llm.model`. An evaluation script for the scoring
rubric (Phase 3) is not built yet.

## Folder structure

| Path | Purpose |
|---|---|
| `docker-compose.yml` | Runs n8n locally in Docker with a persistent named volume. |
| `.env.example` | Template listing every secret/env var n8n needs. Copy to `.env`. |
| `config/config.example.json` | Template for the pipeline config: RSS sources, scoring rubric, LLM model, threshold, Telegram chat ID. Copy to `config/config.json`. |
| `workflows/` | The two n8n workflows (`digest.json`, `error-handler.json`) — import these into the n8n editor. See `workflows/README.md`. |
| `data/` | Runtime state written by the digest workflow: the seen-item dedupe cache and the run log. Empty until the workflow runs once. |
| `scripts/` | Helper scripts — currently `check-secrets.sh`, a pre-commit secret scan. |

## Setup

### 1. Prerequisites

- [Docker](https://www.docker.com/) and Docker Compose installed.
- A Telegram account.
- An [Anthropic API key](https://console.anthropic.com/) for scoring. The
  default model (`claude-haiku-5-5`, set in `config/config.json`) is cheap —
  it only scores a headline + short snippet per item, roughly $0.10/$0.50
  per million input/output tokens.

### 2. Create a Telegram bot and get your chat ID

*(This part happens outside the terminal, in the Telegram app / website.)*

1. Message [@BotFather](https://t.me/BotFather) on Telegram, send `/newbot`,
   and follow the prompts. BotFather gives you a **bot token** — save it.
2. Start a chat with your new bot (search for it by the username you gave it)
   and send it any message, so Telegram has a chat to report back.
3. Get your **chat ID**: open this URL in a browser, replacing
   `<BOT_TOKEN>`:
   `https://api.telegram.org/bot<BOT_TOKEN>/getUpdates`
   Look for `"chat":{"id":...}` in the response — that number is your chat ID.

### 3. Configure secrets

```bash
cp .env.example .env
```

Edit `.env` and fill in:
- `N8N_ENCRYPTION_KEY` — generate with `openssl rand -hex 32`
- `LLM_API_KEY` — your Anthropic API key (used to call `claude-haiku-5-5` by
  default — see `config/config.json`'s `llm.model` to change it)
- `TELEGRAM_BOT_TOKEN` — from step 2

**Never commit `.env`.** It's already excluded in `.gitignore`.

### 4. Configure the pipeline

```bash
cp config/config.example.json config/config.json
```

Edit `config/config.json`:
- `sources` — the RSS feeds you want to track (3 samples are included).
- `rubric` — adjust the scoring instructions/criteria to match what you
  personally consider relevant.
- `threshold` — the minimum score (0–10) an item needs to be sent.
- `telegram.chat_id` — the chat ID from step 2.

### 5. Start n8n

```bash
docker compose up -d
```

Expected output: Docker pulls the `n8nio/n8n` image (first run only) and
starts a container named `music-news-digest-n8n`.

Check it's running:

```bash
docker compose ps
```

You should see the container with status `Up`.

### 6. Open n8n and import the workflows

Go to **http://localhost:5678** in your browser and finish the one-time
n8n account setup (local only — this account isn't sent anywhere).

Then import both workflows and link the error handler — full steps in
[`workflows/README.md`](workflows/README.md). Short version: import
`workflows/error-handler.json`, import `workflows/digest.json`, set
`digest.json`'s workflow setting **Error Workflow** to point at the error
handler, run `digest.json` once manually to confirm it works end to end,
then activate it.

### 7. Before every commit

```bash
./scripts/check-secrets.sh
```

This scans the files git would actually commit for things that look like API
keys or tokens. It's a heuristic, not a guarantee — review your `git diff`
too.

## Security notes

- `docker-compose.yml` sets `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`, which lets
  the Code nodes in `workflows/digest.json` and `workflows/error-handler.json`
  read `LLM_API_KEY` and `TELEGRAM_BOT_TOKEN` via `$env` instead of going
  through n8n's credential store. That's an acceptable tradeoff for this
  project's intended use — a single user, running n8n only on localhost, with
  secrets that already live in `.env` and nowhere else. **If you ever expose
  this n8n instance beyond localhost** (a tunnel, a VPS, a shared network),
  don't rely on this setting — switch those two secrets to n8n credentials
  instead, which keep them out of reach of any workflow code that didn't
  explicitly request them.

## Limitations

- **Runs on a local machine.** If your laptop is off, asleep, or offline when
  the schedule fires, that run is simply missed — there's no cloud scheduler
  to pick up the slack. The "last successful run" tracking means a missed
  day gets caught up on the *next* run (within the configured lookback
  window), but you won't get same-day alerts for a day you never ran.
- **Single user, single Telegram target.** Not designed for multiple
  recipients or multi-tenant config.
- **No paid hosting.** Everything here assumes n8n Community Edition and a
  cheap/small LLM model, by design — this is a portfolio project, not a
  production service.

## License

See [LICENSE](LICENSE).
