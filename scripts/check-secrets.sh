#!/usr/bin/env bash
# Heuristic scan for likely API keys/tokens before you commit.
# Not a replacement for a real secret scanner (e.g. gitleaks) — just a quick
# sanity check for this project. Run it before every `git add` / `git commit`.
#
# Usage: ./scripts/check-secrets.sh

set -euo pipefail
cd "$(dirname "$0")/.."

FOUND=0

# Files git would actually commit: tracked files + untracked-but-not-ignored files.
# This deliberately skips anything .gitignore already excludes (like real .env).
FILES=$(git ls-files --cached --others --exclude-standard)

PATTERNS=(
  'sk-[A-Za-z0-9]{20,}'                 # OpenAI-style keys
  'AIza[0-9A-Za-z_-]{35}'               # Google API keys
  'ghp_[A-Za-z0-9]{36}'                 # GitHub personal access tokens
  'xox[baprs]-[A-Za-z0-9-]{10,}'        # Slack tokens
  '[0-9]{8,10}:[A-Za-z0-9_-]{35}'       # Telegram bot token shape
)

SAFE_MARKERS='changeme_|YOUR_TELEGRAM|placeholder'

for f in $FILES; do
  # Skip this script itself (it contains the patterns as text) and example files'
  # legitimate placeholder-looking strings are filtered by SAFE_MARKERS below.
  [ "$f" = "scripts/check-secrets.sh" ] && continue
  [ -f "$f" ] || continue

  for pat in "${PATTERNS[@]}"; do
    matches=$(grep -nEI "$pat" "$f" 2>/dev/null | grep -Ev "$SAFE_MARKERS" || true)
    if [ -n "$matches" ]; then
      echo "⚠️  Possible secret in $f:"
      echo "$matches" | sed 's/^/    /'
      FOUND=1
    fi
  done
done

# Extra check: make sure .env itself was never accidentally staged.
if git ls-files --cached | grep -qx '\.env'; then
  echo "⚠️  .env is tracked by git! Run: git rm --cached .env"
  FOUND=1
fi

if [ "$FOUND" -eq 0 ]; then
  echo "✅ No obvious secrets found in files git would commit."
else
  echo
  echo "Review the matches above before committing."
  exit 1
fi
