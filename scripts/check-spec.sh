#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

required=(
  README.md
  AGENTS.md
  SECURITY.md
  task.md
  docs/architecture/design.md
  docs/product/capability-matrix.md
  docs/product/defaults.md
  docs/execution/implementation-protocol.md
  docs/quality/acceptance.md
  docs/security/threat-model.md
  docs/references/sources.md
)

for path in "${required[@]}"; do
  test -s "$path" || { printf 'missing required specification: %s\n' "$path" >&2; exit 1; }
done

if grep -RIE --exclude-dir=.git 'sk-[A-Za-z0-9]{16,}|gh[opusr]_[A-Za-z0-9]+' .; then
  printf 'possible committed credential found\n' >&2
  exit 1
fi

if grep -RIE --exclude-dir=.git '/Users/[^ /]+/|/home/[^ /]+/' .; then
  printf 'machine-specific absolute user path found\n' >&2
  exit 1
fi

for n in $(seq -w 1 20); do
  grep -Fq "https://learn.shareai.run/en/s${n}/" docs/references/sources.md || {
    printf 'missing frozen ShareAI source s%s\n' "$n" >&2
    exit 1
  }
done

grep -Fq 'DASHSCOPE_API_KEY=' .env.example
test "$(sed -n 's/^DASHSCOPE_API_KEY=//p' .env.example)" = '' || {
  printf '.env.example must not contain a key value\n' >&2
  exit 1
}

printf 'specification checks passed\n'
