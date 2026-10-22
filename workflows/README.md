# workflows

Two n8n workflows:

- `digest.json` — the main pipeline. Two triggers feed the same logic:
  the **Schedule Trigger** (daily, scheduled mode) and the **Manual
  Backfill Trigger** (run by hand, backfill mode — never sends to
  Telegram, never touches `data/state.json`; see the main README's
  "Backfill mode" section). From there: read config/state → fetch every
  enabled source (RSS + Telegram, each isolated so one failing doesn't
  stop the others) → dedupe/filter by window → score with Claude (+ CSV
  export of every candidate) → cap, group, and split into Telegram
  messages (scheduled only) → save state + log → send.
- `error-handler.json` — fires on a *fatal* failure in `digest.json` (bad
  LLM/Telegram credentials, the Anthropic API itself erroring, config
  missing) and sends a Telegram alert. A single source failing to fetch is
  caught inside `digest.json` and logged, not fatal — see that file's
  "Fetch All Sources" node.

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
the main README's "Known gotchas").

This only works because `docker-compose.yml` sets
`NODE_FUNCTION_ALLOW_BUILTIN=fs` (lets Code nodes `require('fs')`) and mounts
`./data` read-write at `/data`. If you changed docker-compose, re-run
`docker compose up -d` to pick that up before importing.

## Import and publish

Full step-by-step is in the main [`README.md`](../README.md#setup) (Setup
steps 8–12); short version, in order:

1. Import `workflows/error-handler.json` and **publish** it — save, then
   switch it Active. It must be published *before* you try to select it as
   an Error Workflow elsewhere, or it won't show up in that dropdown yet.
2. Import `workflows/digest.json` and save it (don't activate yet).
3. `digest.json` → **Workflow settings** (⋯ menu) → **Error Workflow** →
   select "Music News Digest - Error Handler".
4. Run `digest.json` once manually (▶ **Execute workflow**, from the
   Schedule Trigger path) to confirm it works end to end. Check
   `data/run-log.ndjson` — it includes a per-source breakdown
   (`sources: [...]`) so you can see each feed/channel's fetched count or
   error.
5. Publish `digest.json` once that manual run looks right. It then runs on
   the Schedule Trigger's interval — daily at 11:00 by default (n8n's
   instance timezone, set via `GENERIC_TIMEZONE` in `docker-compose.yml`,
   is Europe/Madrid) — edit that node to change it.

To run a **backfill** instead of a scheduled test, execute `digest.json`
starting from the **Manual Backfill Trigger** node specifically (right-click
it → Execute, or use the start-node dropdown next to the main Execute
button) rather than step 4's path. See the main README for what a backfill
does and why it's always safe to run.

## Known caveats specific to these files

(General operational gotchas — the error-workflow dropdown, deleting
`state.json` to resend, a sleeping laptop missing a run, and so on — are in
the main README's "Known gotchas," not duplicated here.)

- n8n reassigns node/workflow IDs on import and does not pre-select
  anything — there's nothing to reconnect automatically since neither
  workflow uses n8n credentials, but you do need to redo step 3 above
  (linking the error workflow) after a fresh import, since that link isn't
  carried in either file.
- `data/state.json`, `data/run-log.ndjson`, and (if
  `eval.export_candidates_csv` is on) `data/candidates.csv` don't exist
  right after `git clone` — they're created on first run.
