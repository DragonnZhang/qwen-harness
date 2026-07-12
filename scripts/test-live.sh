#!/usr/bin/env bash
# The credentialed DashScope gate. It fails CLOSED with a concise message when the key is absent
# (acceptance.md, "Release command contract"), so a live run can never silently pass as a no-op.
set -euo pipefail

cd "$(dirname "$0")/.."

# Load a local .env if present, without echoing anything (the key must never reach the terminal).
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

if [ -z "${DASHSCOPE_API_KEY:-}" ]; then
  printf 'test:live: DASHSCOPE_API_KEY is not set.\n' >&2
  printf 'The live gate is credentialed and mandatory for final completion; it cannot run without a key.\n' >&2
  printf 'Set it (see .env.example) and re-run. It is never printed, logged, or committed.\n' >&2
  exit 1
fi

exec pnpm exec vitest run --project live "$@"
