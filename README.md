# music-news-digest

## What it is

This is a self-hosted [n8n](https://n8n.io/) pipeline that watches the sources
you configure — RSS feeds and public Telegram channel previews today —
scores every new item against a rubric you write using a small, cheap LLM
(Anthropic's `claude-haiku-5-5` by default), and sends only the items that
clear your threshold to a Telegram chat, grouped by source and never
splitting an item across messages. It tracks what it's already sent so a
missed day gets caught up automatically, logs every run for later review,
and includes a separate backfill mode for pulling and scoring history to
build a labeled evaluation set for tuning the rubric.

**Nothing here is music-specific.** It was built first to track music-tech
industry news — real sources and a real rubric for that are what you'll see
if you read the code and commit history — but every source, the rubric, the
schedule, the caps, and the message wording come from `config/config.json`,
not from the workflow. Point it at any field you want to track news in; see
["Adjusting it for your own field"](#adjusting-it-for-your-own-field) below
for a full worked example retargeting it to climate tech.

### Architecture

```
Schedule Trigger (daily)          Manual Backfill Trigger (run by hand)
        │                                      │
        ▼                                      ▼
  Mark as Scheduled                      Mark as Backfill
        │                                      │
        └──────────────────┬───────────────────┘
                            ▼
                  Load Config & State
                            │
                            ▼
    Fetch every enabled source, each in its own try/catch
    (one feed/channel failing never stops the others):
      - rss:      HTTP GET the feed, parse items
      - telegram: HTTP GET https://t.me/s/<channel> preview
                  scheduled → throttled to once/24h per channel
                  backfill  → paginate backward with ?before=,
                              capped at 5 pages per channel
      - email:    not implemented — logged as a per-source error
                            │
                            ▼
   Dedupe by URL/permalink ──▶ Filter by window
     scheduled → since the last successful run (or
                 digest.first_run_lookback_days on a fresh state)
     backfill  → a fixed eval.backfill_days window, ignoring
                 already-sent items, capped at 300 candidates
                            │
                            ▼
      Score each item with the LLM (rubric → {score, summary,
      why_it_matters}) ──▶ append every scored candidate to
      data/candidates.csv (opt-in on schedule; always on for backfill)
                            │
                            ▼
             Keep items at or above the threshold
                            │
            ┌───────────────┴────────────────┐
            ▼ scheduled                        ▼ backfill
  Cap per source, then overall ▶ group      Never sends to Telegram,
  by source ▶ split into Telegram           never touches state.json
  messages at item boundaries (intro +
  header only on the first message) ▶ send
            │
            ▼
  Save state.json + append one line to
  data/run-log.ndjson (per-source counts,
  caps removed, tokens, cost, trigger type)

   (a fatal failure — bad LLM/Telegram credentials, the Anthropic API
    itself erroring, config missing — triggers the separate error
    workflow, which sends a Telegram alert; a single source failing
    to fetch does not)
```

### Folder structure

| Path | Purpose |
|---|---|
| `docker-compose.yml` | Runs n8n locally in Docker with a persistent named volume. |
| `.env.example` | Template listing every secret/env var n8n needs. Copy to `.env`. |
| `config/config.example.json` | Industry-neutral template for the pipeline config. Copy to `config/config.json` and adapt — see ["Adjusting it for your own field"](#adjusting-it-for-your-own-field). |
| `workflows/` | The two n8n workflows (`digest.json`, `error-handler.json`) — import these into the n8n editor. See `workflows/README.md`. |
| `data/` | Runtime state written by the digest workflow: the seen-item dedupe cache, per-channel Telegram fetch times, the run log, and (if enabled) `candidates.csv`. Empty until the workflow runs once. |
| `scripts/check-secrets.sh` | Pre-commit secret scan over the working tree (heuristic, not a guarantee). |
| `scripts/run-report.js` | Summarizes `data/run-log.ndjson` — run with `node scripts/run-report.js`. No setup needed. |

## Prerequisites

- **[Docker Desktop](https://www.docker.com/products/docker-desktop/)** (or
  any Docker Engine + Compose v2). Everything else here runs inside it.
- **[git](https://git-scm.com/)**, to clone this repo.
- **An [Anthropic API key](https://console.anthropic.com/)**, for scoring.
  This is billed separately from any Claude.ai/Claude subscription you might
  have — it's pay-as-you-go API usage, not covered by a subscription. It's
  cheap: scoring only looks at a title + short text excerpt per item, and a
  real backfill run in this project scored 101 items with `claude-haiku-5-5`
  for about **$0.0185 total** (roughly $0.0002/item).
- **A Telegram account**, to create a bot via [@BotFather](https://t.me/BotFather)
  — covered in Setup below.

## Setup

Follow these in order — several steps depend on the one before.

### 1. Clone the repo

```bash
git clone <this-repo-url>
cd music-news-digest
```

### 2. Create `.env`

```bash
cp .env.example .env
```

Edit `.env` and fill in:
- `N8N_ENCRYPTION_KEY` — generate one with `openssl rand -hex 32` and paste
  the output in. This is what n8n uses to encrypt anything it stores
  internally; it's not tied to any external account.
- `LLM_API_KEY` — your Anthropic API key from the prerequisites above.

Leave `TELEGRAM_BOT_TOKEN` for step 4, once you have it.

**Never commit `.env`.** It's already excluded in `.gitignore`.

### 3. Create a Telegram bot

*(This happens in the Telegram app, not the terminal.)*

Message [@BotFather](https://t.me/BotFather), send `/newbot`, and follow the
prompts. BotFather gives you a **bot token** — paste it into `.env`'s
`TELEGRAM_BOT_TOKEN` now.

### 4. Find your chat ID

1. Start a chat with your new bot (search for it by the username you gave
   it) and send it any message, so Telegram has something to report back.
2. Open this URL **in your browser**, with your bot token in place of
   `<BOT_TOKEN>`:
   `https://api.telegram.org/bot<BOT_TOKEN>/getUpdates`
3. Look for `"chat":{"id":...}` in the response — that number is your chat
   ID.

Use the browser for step 2, not a terminal command like `curl` — typing or
pasting the bot token into a shell command leaves it sitting in your shell
history in plain text. A browser's address bar is a much smaller place for
it to linger, and nothing here needs step 2 to be scriptable.

### 5. Create `config/config.json`

```bash
cp config/config.example.json config/config.json
```

Open `config/config.json` and set `telegram.chat_id` to the chat ID from
step 4. The example sources, rubric, and other settings will run as-is —
adapt them once you've confirmed everything works; see ["Adjusting it for
your own field"](#adjusting-it-for-your-own-field).

**Never commit `config/config.json`.** It's already excluded in
`.gitignore` — it's not secret the way `.env` is, but it's your personal
setup, not a template for others.

### 6. Start n8n

```bash
docker compose up -d
```

First run pulls the `n8nio/n8n` image. Check it came up:

```bash
docker compose ps
```

You should see `music-news-digest-n8n` with status `Up`.

### 7. Create your n8n owner account

Go to **http://localhost:5678** and complete the one-time account setup
n8n asks for on first launch. This account is local to your container —
it isn't sent anywhere and doesn't need to match any other account you have.

### 8. Import and publish the error handler first

**Workflows → Import from File** → select `workflows/error-handler.json`.
Save it, then switch it to **Active** (top-right toggle). This README calls
that combination — save, then Active — "publishing" a workflow.

Publishing the error handler *before* importing the digest matters: a
workflow only shows up in another workflow's **Error Workflow** dropdown
once it's been saved, and not reliably until it's also been activated. If
you import `digest.json` first, you won't see `error-handler.json` as an
option yet.

### 9. Import the digest workflow

**Workflows → Import from File** → select `workflows/digest.json`. Save it
(don't activate it yet — do that in step 11, after a manual test run).

### 10. Point the digest at the error handler

Open `digest.json` → **Workflow settings** (⋯ menu) → **Error Workflow** →
select "Music News Digest - Error Handler". This is what sends you a
Telegram alert if a run fails outright (bad API key, Anthropic/Telegram
down, config missing) — not if one RSS feed or Telegram channel is
temporarily unreachable; that's logged, not alerted on.

### 11. Run it once manually

Open `digest.json` and click **Execute workflow**. Confirm: config/state
load without error, sources fetch, Claude scores them, and either a digest
or a "nothing new passed the threshold" message arrives in your Telegram
chat. Check `data/run-log.ndjson` for the logged result — it has a
per-source breakdown so you can see each feed/channel's fetched count or
error.

### 12. Publish the digest workflow

Once the manual run looks right, save and switch `digest.json` to
**Active** too. It now runs on its own, on the Schedule Trigger's interval
— daily at 11:00 by default, in whatever timezone `docker-compose.yml`'s
`GENERIC_TIMEZONE` is set to (Europe/Madrid by default; edit both that and
the Schedule Trigger node if you want a different time or cadence).

### Before every commit

```bash
./scripts/check-secrets.sh
```

Scans the files git would actually commit for things that look like API
keys or tokens. It's a heuristic, not a guarantee — review your `git diff`
too.

## Known gotchas

- **Symptom: `error-handler.json` doesn't show up in the "Error Workflow"
  dropdown on `digest.json`.** Fix: it has to be saved *and* published
  (Active) first — see Setup step 8. Reopen the dropdown after publishing
  it; it should appear without needing to reimport anything.
- **Symptom: Code nodes can read `$env.LLM_API_KEY` / `$env.TELEGRAM_BOT_TOKEN`
  even though n8n blocks that by default.** This is deliberate:
  `docker-compose.yml` sets `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` so the
  workflow's Code nodes can read those two secrets directly from the
  container's environment (which `.env` populates via `env_file`), instead
  of going through n8n's credential store. That's an acceptable tradeoff for
  this project's intended use — a single user, running n8n only on
  localhost. **If you ever expose this n8n instance beyond localhost** (a
  tunnel, a VPS, a shared network), don't rely on this setting — move those
  two secrets into n8n credentials instead, which keep them out of reach of
  any workflow code that didn't explicitly request them.
- **Want to test without risking a real Telegram send?** Use the **Manual
  Backfill Trigger** node (right-click it → Execute workflow, or use the
  start-node dropdown next to the Execute button), not the Schedule
  Trigger. A backfill run **never sends anything to Telegram and never
  writes `data/state.json`** — it's always safe to run, any time, as many
  times as you like.
- **Symptom: you want Telegram to resend a digest you already received**
  (e.g. to check formatting after a config change). Fix: stop the
  container or otherwise pause the workflow, then delete `data/state.json`,
  then run `digest.json` manually again. With no `last_run_at`, it falls
  back to the `digest.first_run_lookback_days` window and everything inside
  it is eligible to resend. This also resets each Telegram channel's
  24-hour fetch throttle, so expect a fresh fetch from all of them too.
- **Symptom: no digest arrived on a day your laptop was off, asleep, or
  offline when the schedule fired.** This is expected, not a bug — there's
  no cloud scheduler backing this up. The next run's window reaches back to
  the last successful run, so anything from the missed day shows up in the
  *next* digest, just later than usual. There's no separate alert for a day
  that silently never ran at all.
- A single source failing (one feed down, one Telegram channel unreachable
  or reshaped) is caught and logged per-source — it does not abort the run
  or page the error workflow. Only infra/auth-level failures do.
- Each Telegram channel is only fetched at most once every 24 hours in
  scheduled mode (tracked in `data/state.json`'s `telegram_last_fetch`) —
  running the workflow manually more than that will show `fetched: 0` with
  `skipped: "fetched less than 24h ago"` for those sources. Expected, not an
  error — and this throttle doesn't apply during a backfill.
- `data/state.json`, `data/run-log.ndjson`, and (if enabled)
  `data/candidates.csv` don't exist right after `git clone` — they're
  created on first run.

## Adjusting it for your own field

Nothing is hardcoded in the workflow — every source, the rubric, the
threshold, the schedule, the caps, and the message wording come from
`config/config.json`. This section walks through retargeting the example
config for a different field (climate tech, as a stand-in for whatever
yours is), then documents every field.

### Worked example: climate tech

**Sources.** Keep the mix of `rss` and `telegram` source types — only the
URLs/channels and the rubric change.

- To find an RSS feed for a site you already read: look for a small RSS
  icon, or view the page's source (`Ctrl+U` / `Cmd+Option+U`) and search
  for `rss+xml` — sites that have a feed almost always link it in the page
  `<head>`. If that turns up nothing, try appending `/feed`, `/feed/`,
  `/rss`, or `/rss.xml` to the site's base URL; most blogging platforms
  (WordPress, Substack, Ghost) use one of those. As a real, working
  example: Canary Media (climate tech industry news) publishes its feed at
  `https://www.canarymedia.com/feed`.
- To find a Telegram source: once you know a public channel's `@handle`,
  its read-only preview always lives at `https://t.me/s/<handle>` (no `@`,
  no login) — open that URL directly in a browser to confirm the channel is
  public and actually renders posts before adding it to config. Use the
  bare handle (no `@`, no `t.me/`) as the `channel` value.

A climate-tech `sources` entry might look like:

```json
{
  "id": "canary-media",
  "name": "Canary Media",
  "type": "rss",
  "url": "https://www.canarymedia.com/feed",
  "language": "en",
  "enabled": true,
  "max_items": 20
}
```

**The rubric.** `rubric.instructions` is sent to the model verbatim
alongside each item's title and text excerpt — there's no separate
criteria/exclude structure, it's all one block of text you write. A rubric
that works well has four parts:

1. **Who the reader is**, specifically — not "someone interested in X" but
   a role with real stakes: *"a product manager at a company selling
   battery storage systems to utilities"* reads very differently from *"a
   climate policy researcher."* The more specific the persona, the more
   consistently the model will separate signal from noise.
2. **What scores 8-10** — concrete, high-stakes events specific to that
   reader: for climate tech, maybe funding rounds, new regulation, major
   technology breakthroughs with named companies, or policy decisions that
   change the economics of a specific technology.
3. **What scores 5-7** — useful context that doesn't demand action: market
   sizing reports, executive moves, general sector trend pieces.
4. **What scores 0-4 and should be excluded outright** — list the noise
   specific to your sources: for a climate-tech feed that might be general
   environmental activism with no business angle, opinion pieces, event
   recaps, or sponsored content.

Also tell it, explicitly, to write the summary and the "why it matters"
line in the same language as the item — the model follows this reliably
when asked, but won't do it unprompted.

A skeleton:

```
Score each item 0-10 for relevance to <specific reader persona>.

8-10: <concrete, high-stakes event types specific to this field>.
5-7: <useful context that doesn't demand immediate action>.
0-4: everything else, including <the specific noise you want excluded>.

Prefer concrete events (a deal, launch, ruling, funding round, policy
change) over commentary. Write the summary and the why-it-matters line in
the language of the item; the why-it-matters line should say why it
matters to this reader specifically.
```

**Threshold.** `threshold` is the minimum score (0–10) an item needs to
make the digest. Start around 5–6 and adjust after reading a few digests —
lower means more volume (and more noise), higher means fewer items but
you'll miss more borderline-relevant ones. The ["Backfill mode"](#backfill-mode-and-the-labeling-export)
section below covers tuning this against real history instead of guessing.

**Schedule time.** Edit the Schedule Trigger node's `triggerAtHour`/
`triggerAtMinute` (and `docker-compose.yml`'s `GENERIC_TIMEZONE` if you want
a different timezone than Europe/Madrid) to change when the daily run fires.

**Intro template.** `digest.intro_template` is the line sent above the
digest's header — rewrite it for your field, e.g.:

```json
"intro_template": "Climate tech news from {from} to {to}: {count} items from {sources} sources."
```

**Caps.** `digest.max_items_per_source` and `digest.max_items` bound how
big the digest gets even on a busy day — see the field table below for
exact semantics.

**Languages.** Each source's `language` field is metadata only — the
workflow doesn't branch on it. The model infers the item's actual language
from its text and is instructed (via the rubric) to reply in that same
language regardless of what `language` says; use the field for your own
reference when skimming `config.json`, not as a functional switch.

### Every config field

**`sources[]`** — array, one entry per feed/channel. Shared fields:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `id` | string | *(required)* | Stable kebab-case identifier. Used in dedupe keys, the run log, `telegram_last_fetch` state, and `data/candidates.csv`'s `source` column. Don't rename it once you've run the pipeline — state ties back to a source by this value. |
| `name` | string | *(required)* | Human-readable name, shown in the run log and the digest message. |
| `type` | `"rss"` \| `"telegram"` \| `"email"` | *(required)* | Picks which fetch logic runs. `"email"` is schema-only — see below. |
| `language` | string | *(none; free text)* | Metadata only — not read for any branching logic. See "Languages" above. |
| `enabled` | boolean | *(required)* | Set `false` to keep a source configured but skip it. |
| `max_items` | integer | `20` (if omitted) | Cap on how many of the source's most recent items are considered per run, before scoring. |
| `url` (rss only) | string | *(required for `type: "rss"`)* | The feed URL. Parsed with a small built-in regex parser (title/link/guid/pubDate/description/content:encoded) — no external library. Standard RSS 2.0; a very different shape (pure Atom, unusual namespaces) may need the parser extended. |
| `channel` (telegram only) | string | *(required for `type: "telegram"`)* | The bare handle, no `@` and no `t.me/` prefix (e.g. `"gensound"` for `@gensound`). Reads the public `https://t.me/s/<channel>` preview — no login, no API credentials. See the Telegram-specific gotchas above. |
| `mailbox` (email only) | object `{host, port, username, folder}` | *(required for `type: "email"`, but unused)* | **Schema only — see "The email source type" below.** |

**`llm`**

| Field | Type | Default | Meaning |
|---|---|---|---|
| `model` | string | *(required)* | The Anthropic model ID sent in every scoring request. |
| `cost_per_mtok_input` | number | `0` (if omitted) | USD per million input tokens — used only to estimate `estimated_cost_usd` in the run log, not sent to the API. |
| `cost_per_mtok_output` | number | `0` (if omitted) | USD per million output tokens, same purpose. |

**`rubric`**

| Field | Type | Default | Meaning |
|---|---|---|---|
| `instructions` | string | *(required)* | The entire scoring prompt, sent verbatim. See "The rubric" above. |

**Top level**

| Field | Type | Default | Meaning |
|---|---|---|---|
| `threshold` | integer, 0–10 | *(required — no built-in fallback)* | Minimum score an item needs to reach the digest; clamped in code to 0–10 even though the model isn't hard-constrained to that range. Leaving this out means nothing will ever pass (an `undefined` comparison is always false), so `config.example.json` always sets it. |

**`telegram`**

| Field | Type | Default | Meaning |
|---|---|---|---|
| `chat_id` | string | *(required)* | Where the digest and error alerts are sent — from Setup step 4. |

**`digest`**

| Field | Type | Default | Meaning |
|---|---|---|---|
| `intro_template` | string | `"Music industry news from {from} to {to}: {count} items from {sources} sources."` (code fallback — see note) | Sent above the digest header on every scheduled run. Placeholders: `{from}`/`{to}` (the window used that run, "22 Oct"/"22 Oct 2026" in Europe/Madrid time — collapses to "for {to}" on a same-day window if the template contains the literal phrase `from {from} to {to}`), `{count}` (items sent), `{sources}` (distinct sources contributing). **Always set this explicitly in your own config** — the code's built-in fallback (used only if this field is missing entirely) is leftover music-specific wording from this project's original setup, not a neutral default. |
| `first_run_lookback_days` | integer (days) | `7` | How far back a scheduled run looks when `data/state.json` has no `last_run_at` yet (first run, or right after deleting that file). Every later run uses the previous run's time instead. No effect on backfill mode. |
| `max_items_per_source` | integer | `8` | At most this many items from any one source make the digest, highest score first, even if more scored above the threshold. |
| `max_items` | integer | `30` | Total cap across all sources, applied after the per-source cap. |

**`eval`**

| Field | Type | Default | Meaning |
|---|---|---|---|
| `export_candidates_csv` | boolean | `false` | If `true`, every scored candidate on a scheduled run (kept or not) is appended to `data/candidates.csv`. Always on for a backfill run regardless of this setting — see below. |
| `backfill_days` | integer (days) | `30` | The fixed lookback window a backfill run uses, independent of `state.json`. |

## Backfill mode and the labeling export

A scheduled run only looks at what's new since the last run. **Backfill
mode** instead pulls and scores a fixed window of history — useful for
building an evaluation set to check whether your rubric actually agrees
with your own judgment, before letting it run unattended every day.

Run it from the n8n editor: open `digest.json` and execute it starting from
the **Manual Backfill Trigger** node specifically (not the Schedule
Trigger) — right-click that node and choose Execute, or use the start-node
dropdown next to the main Execute button if your n8n version only shows
one. It:

- Uses a fixed `eval.backfill_days` window (default 30) instead of "since
  the last successful run," and **ignores already-sent items** — the point
  is re-scoring history, not catching up on new items.
- **Never sends anything to Telegram and never writes `data/state.json`** —
  zero effect on the next scheduled run. Safe to run as often as you like.
- Paginates each Telegram channel backward (`?before=`) to cover the
  window, capped at 5 pages per channel. If that cap was hit before
  reaching the window's edge, that channel's run-log entry has
  `cap_hit: true` — its history for this backfill is incomplete.
- **Always** exports to `data/candidates.csv` (regardless of
  `eval.export_candidates_csv`) and **overwrites** that file at the start
  of the run, rather than appending.
- Caps at 300 candidates total (the most recent 300 within the window, if
  more qualify).
- Appends a `mode: "backfill"` entry to `data/run-log.ndjson` with a
  per-source breakdown (fetched, within-window, scored, score distribution,
  plus pagination cap-hit flags for Telegram) and the token/cost totals.

### Using it to tune a rubric

1. Set `eval.backfill_days` to a window with enough volume to judge against
   (a couple of weeks is usually plenty), then run a backfill.
2. Open `data/candidates.csv` — every candidate from that window is there,
   each with the model's `score` and an empty `label` column.
3. Hand-label a sample yourself in the `label` column (e.g. your own 0–10,
   or just "keep"/"drop") — enough to spot a pattern, not necessarily all
   of them.
4. Compare `model_score` against your `label`. Look specifically for
   *disagreements*: items you'd keep that scored low, or items you'd drop
   that scored high. Those tell you what's missing or over-weighted in the
   rubric text.
5. Rewrite `rubric.instructions` to address what you found — usually that
   means being more specific about the reader persona, or naming the exact
   noise you want excluded (see "The rubric" in the worked example above).
6. Re-run the backfill (it overwrites `candidates.csv` fresh) and repeat
   from step 3 until the model's scores track your own judgment closely
   enough that you'd trust it to run unattended.

The scheduled pipeline's own `threshold` is separate from this — once the
rubric itself is scoring sensibly, use the backfill's score distribution
(in the run log) to pick a `threshold` that keeps the volume you actually
want.

## The email source type

The `email` source type exists in the config schema — `{host, port,
username, folder}` under `mailbox` — **so the shape is documented, but the
IMAP fetch itself is not implemented.** An enabled `email` source is never
fetched; it's skipped every run with a logged per-source error
(`"email source type not implemented yet"`). Don't configure one expecting
it to do anything yet.

## Cost, limitations, and responsible use

- **Runs only while your machine is on.** There's no cloud scheduler behind
  this — if your laptop is off, asleep, or offline when the schedule fires,
  that run is simply missed (see "Known gotchas" above for what happens
  next).
- **Telegram preview scraping is not an official API.** Reading
  `https://t.me/s/<channel>` is HTML scraping of a public page, not a
  supported integration — Telegram can change that markup at any time and
  silently break parsing for one or more channels. It also only exposes
  roughly the most recent ~20 posts per page, with no private channels and
  no login.
- **This sends summaries and links only — it never republishes full
  article or post text.** `data/candidates.csv` and the LLM prompt itself
  hold short excerpts (title + a few hundred characters) for scoring
  purposes, not full content, and nothing here is designed to reproduce or
  redistribute a source's full articles or posts.
- **Never commit `.env`, `config/config.json`, or anything under `data/`.**
  All three are already excluded in `.gitignore` — `.env` and
  `config/config.json` because they hold your secrets/personal setup,
  `data/` because it's runtime state (dedupe cache, run log, and — if
  enabled — scored candidates) that doesn't belong in version control
  either way.
- **Single user, single Telegram target.** Not designed for multiple
  recipients or multi-tenant config.
- **No paid hosting, no production SLA.** This assumes n8n Community
  Edition and a cheap/small LLM model, by design — a personal tool and
  portfolio case study, not a production service.

## License

See [LICENSE](LICENSE) for this project's own code.

This project doesn't bundle or redistribute n8n — Setup has you install it
yourself via the official `n8n-nodes-base`/`n8nio/n8n` Docker image.
Self-hosting n8n is governed by [n8n's own license](https://github.com/n8n-io/n8n/blob/master/LICENSE.md)
(the Sustainable Use License), not this repo's — read it yourself before
relying on this for anything beyond personal use.
