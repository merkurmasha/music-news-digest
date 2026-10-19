# workflows

Exported n8n workflow JSON files live here (added in Phase 2):

- `digest.json` — the main pipeline: fetch → dedupe → score → filter → send → log.
- `error-handler.json` — the error workflow that alerts you on Telegram when `digest.json` fails.

Import either file via the n8n editor: **Workflows → Import from File**.
