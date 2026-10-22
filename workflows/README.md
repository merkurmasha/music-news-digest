# workflows

Exported n8n workflow JSON, built in Phase 2:

- `digest.json` — the main pipeline: read config/state → fetch every enabled
  source (RSS + Telegram, each isolated so one failing doesn't stop the
  others) → dedupe/filter by recency → score with Claude (+ optional CSV
  export of every candidate) → save state + log → send Telegram digest.
- `error-handler.json` — fires on a *fatal* failure in `digest.json` (bad
  LLM/Telegram credentials, the Anthropic API itself erroring, config
  missing) and sends a Telegram alert. A single source failing to fetch is
  caught inside `digest.json` and logged, not fatal — see
  `workflows/digest.json`'s "Fetch All Sources" node.

Both workflows do their own file I/O (reading `/config/config.json`, reading
and writing `/data/state.json`, `/data/run-log.ndjson`, and — if enabled —
`/data/candidates.csv`) from inside `Code` nodes via Node's `fs` module, and
call the Anthropic/Telegram/RSS/Telegram-preview HTTP endpoints via
`this.helpers.httpRequest` from inside `Code` nodes (Code nodes have no
global `fetch`) — there are no credentials to configure in the n8n UI.
Secrets (`LLM_API_KEY`, `TELEGRAM_BOT_TOKEN`) are read from the container's
environment via the `$env` expression variable, which n8n populates from
`.env` through `docker-compose.yml`'s `env_file` (this requires
`N8N_BLOCK_ENV_ACCESS_IN_NODE=false`, also set in `docker-compose.yml` — see
the main README's "Security notes").

This only works because `docker-compose.yml` sets
`NODE_FUNCTION_ALLOW_BUILTIN=fs` (lets Code nodes `require('fs')`) and mounts
`./data` read-write at `/data`. If you changed docker-compose, re-run
`docker compose up -d` to pick that up before importing.

## Import

1. Open **http://localhost:5678**.
2. **Workflows → Import from File** → select `workflows/error-handler.json`.
   Save it.
3. **Workflows → Import from File** → select `workflows/digest.json`. Save
   it.
4. Open `digest.json` → **Workflow settings** (⋯ menu) → **Error Workflow**
   → select "Music News Digest - Error Handler". This is what makes a fatal
   failure (bad API key, Anthropic/Telegram API erroring, config missing)
   send you an alert instead of failing silently. A single source (one RSS
   feed, one Telegram channel) failing to fetch does *not* trigger this —
   it's caught and logged in the run log instead.
5. Make sure `config/config.json` exists (copy it from
   `config/config.example.json` and edit it — see the main README's
   "Adjusting it for your own sources") and that `.env` has real values for
   `N8N_ENCRYPTION_KEY`, `LLM_API_KEY`, and `TELEGRAM_BOT_TOKEN`.
6. Open `digest.json` and run it once manually (▶ **Execute workflow**) to
   confirm: config/state load, sources fetch, Claude scores, and (if
   anything cleared the threshold) a Telegram message arrives. Check
   `data/run-log.ndjson` for the logged result — it includes a per-source
   breakdown (`sources: [...]`) so you can see each feed/channel's fetched
   count or error.
7. Toggle `digest.json` **Active** once a manual run looks right. It then
   runs on the Schedule Trigger's interval — once a day at 11:00 by default
   (n8n's instance timezone, set via `GENERIC_TIMEZONE` in
   `docker-compose.yml`, is Europe/Madrid) — edit that node to change it.

## Known caveats

- n8n reassigns node/workflow IDs on import and does not pre-select
  anything — there's nothing to reconnect here since neither workflow uses
  n8n credentials, but double-check step 4 (linking the error workflow)
  since that link isn't carried in either file.
- A single source failing (feed down, Telegram preview page unreachable or
  reshaped) is caught in the "Fetch All Sources" node and logged per-source
  in the run log — it does not abort the run or trigger the error alert.
  Only infra/auth-level failures (bad Anthropic/Telegram credentials, those
  APIs erroring) do.
- Telegram channels are fetched at most once every 24 hours each (tracked in
  `data/state.json`'s `telegram_last_fetch`) — running the workflow manually
  more often than that will show `fetched: 0` with `skipped: "fetched less
  than 24h ago"` for those sources, which is expected.
- `data/state.json`, `data/run-log.ndjson`, and (if `eval.export_candidates_csv`
  is on) `data/candidates.csv` are created on first run; they don't exist yet
  right after `git clone`.
