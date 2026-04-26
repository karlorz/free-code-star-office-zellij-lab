#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if git -C "${REPO_ROOT}" ls-files --error-unmatch .env >/dev/null 2>&1; then
  echo "[secret-scan] .env is tracked; remove it from git before committing" >&2
  exit 1
fi

patterns=(
  'ZELLIJ_WEB_TOKEN=("?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"?)'
  '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
)

for pattern in "${patterns[@]}"; do
  if git -C "${REPO_ROOT}" grep -En "${pattern}" -- . ':!.env' ':!scripts/check-no-secrets.sh' >/tmp/free-code-secret-scan.$$; then
    echo "[secret-scan] potential secret pattern found in tracked files:" >&2
    cat /tmp/free-code-secret-scan.$$ >&2
    rm -f /tmp/free-code-secret-scan.$$
    exit 1
  fi
  rm -f /tmp/free-code-secret-scan.$$
done

echo "[secret-scan] ok"
