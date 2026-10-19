# workflows

Exported n8n workflow JSON, built in Phase 2:

- `digest.json` — the main pipeline: read config/state → fetch RSS →
  dedupe/filter/cap → score with Claude → save state + log → send Telegram
  digest.
- `error-handler.json` — fires on any failure in `digest.json` and sends a
  Telegram alert.

Both workflows do their own file I/O (reading `/config/config.json`, reading
and writing `/data/state.json` and `/data/run-log.ndjson`) from inside `Code`
nodes via Node's `fs` module, and call the Anthropic and Telegram HTTP APIs
directly via `fetch` from inside `Code` nodes — there are no credentials to
configure in the n8n UI. Secrets (`LLM_API_KEY`, `TELEGRAM_BOT_TOKEN`) are
read from the container's environment via the `$env` expression variable,
which n8n populates from `.env` through `docker-compose.yml`'s `env_file`.

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
   → select "Music News Digest - Error Handler". This is what makes a failed
   run (bad API key, feed down, Telegram unreachable, etc.) send you an
   alert instead of failing silently.
5. Make sure `config/config.json` exists (copy it from
   `config/config.example.json` and edit it — see the main README) and that
   `.env` has real values for `N8N_ENCRYPTION_KEY`, `LLM_API_KEY`, and
   `TELEGRAM_BOT_TOKEN`.
6. Open `digest.json` and run it once manually (▶ **Execute workflow**) to
   confirm: config/state load, feeds fetch, Claude scores, and (if anything
   cleared the threshold) a Telegram message arrives. Check
   `data/run-log.ndjson` for the logged result.
7. Toggle `digest.json` **Active** once a manual run looks right. It then
   runs on the Schedule Trigger's interval (every 6 hours by default — edit
   that node to change it).

## Known caveats

- n8n reassigns node/workflow IDs on import and does not pre-select
  anything — there's nothing to reconnect here since neither workflow uses
  n8n credentials, but double-check step 4 (linking the error workflow)
  since that link isn't carried in either file.
- If a single RSS feed is unreachable, `RSS Feed Read` throws and the whole
  run aborts (triggering the error alert) rather than silently skipping just
  that source. This is deliberate — a quiet partial failure is worse than a
  loud one for a personal alerting tool — but worth knowing if one of your
  three sample feeds is flaky.
- `data/state.json` and `data/run-log.ndjson` are created on first run; they
  don't exist yet right after `git clone`.
