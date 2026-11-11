#!/usr/bin/env bash
# The first-run check: says what is missing, verifies the toolchain, runs the type check and the tests.
# Exits non-zero with a list when something required is missing.
#
#   ./check.sh          first-run check, type check, tests
#   ./check.sh usage    key=value counters from the SQLite store (read by `teyla products`)
set -uo pipefail
cd "$(dirname "$0")"

case "${1:-}" in
  usage)
    if [ -d node_modules ]; then
      npm run -s usage
    else
      echo "usage_probe=not_installed"
    fi
    exit 0 ;;
esac

missing=()
warnings=()

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

# --- env vars: nothing is required; each missing one switches a feature off ---------------------
if [ -z "${ACCOUNTS_URL:-}" ] || [ -z "${ACCOUNTS_SERVICE_CASANOPASA:-}" ]; then
  warnings+=("AI is off: set ACCOUNTS_URL and ACCOUNTS_SERVICE_CASANOPASA (the accounts hub). Extraction uses rules only and replies use templates.")
elif [ "$(printf '%s' "${CASANOPASA_AI:-}" | tr '[:upper:]' '[:lower:]')" = "off" ]; then
  warnings+=("AI is off: CASANOPASA_AI=off (the kill switch).")
fi
[ -n "${CASANOPASA_DB_PATH:-}" ] || warnings+=("CASANOPASA_DB_PATH is not set: the store will use ./data/casanopasa.db")
[ -n "${CASANOPASA_FILES_KEY:-}" ] || warnings+=("CASANOPASA_FILES_KEY is not set: needed from S1.2 (dossier documents). Generate one with: openssl rand -hex 32")

# --- toolchain ----------------------------------------------------------------------------------
if command -v node >/dev/null 2>&1; then
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$node_major" -ge 24 ] || missing+=("toolchain: node >= 24 (found $(node -v)); node:sqlite needs it")
else
  missing+=("toolchain: node >= 24")
fi
command -v npm >/dev/null 2>&1 || missing+=("toolchain: npm")
[ -d node_modules ] || missing+=("run: npm ci")

if [ "${#missing[@]}" -gt 0 ]; then
  echo "MISSING:"
  for m in "${missing[@]}"; do echo "  - $m"; done
  exit 1
fi

npx tsc --noEmit || { echo "npx tsc --noEmit FAILED"; exit 1; }
npx vitest run || { echo "npx vitest run FAILED"; exit 1; }

echo "OK"
for w in ${warnings[@]+"${warnings[@]}"}; do echo "  note: $w"; done
exit 0
