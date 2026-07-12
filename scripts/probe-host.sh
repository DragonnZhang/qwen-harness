#!/usr/bin/env bash
# Reproduces the checkpoint-00 host capture.
# Records capability, never secret values. Safe to run and to paste into an issue.
set -uo pipefail

section() { printf '\n== %s ==\n' "$1"; }

section "platform"
cat /etc/os-release
uname -a
uname -m
getconf LONG_BIT

section "shell and terminal"
printf 'SHELL=%s TERM=%s COLORTERM=%s\n' "${SHELL:-}" "${TERM:-}" "${COLORTERM:-}"
if [ -t 0 ]; then echo "stdin: tty"; else echo "stdin: not a tty"; fi

section "toolchain"
for tool in node corepack pnpm git cc g++ make python3; do
  if command -v "$tool" >/dev/null 2>&1; then
    printf '%-10s %s\n' "$tool" "$("$tool" --version 2>&1 | head -1)"
  else
    printf '%-10s ABSENT\n' "$tool"
  fi
done

section "sandbox capability"
for tool in bwrap unshare setpriv prlimit docker podman tmux; do
  if command -v "$tool" >/dev/null 2>&1; then
    printf '%-10s %s\n' "$tool" "$(command -v "$tool")"
  else
    printf '%-10s ABSENT\n' "$tool"
  fi
done
printf 'max_user_namespaces        %s\n' "$(cat /proc/sys/user/max_user_namespaces 2>/dev/null || echo unreadable)"
printf 'unprivileged_userns_clone  %s\n' "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null || echo 'not present (permitted)')"

if command -v bwrap >/dev/null 2>&1; then
  section "bubblewrap live probes"
  probe() {
    local name="$1"; shift
    if out=$("$@" 2>&1); then printf '%-24s OK   %s\n' "$name" "$(printf '%s' "$out" | head -1)"
    else printf '%-24s FAIL %s\n' "$name" "$(printf '%s' "$out" | head -1)"; fi
  }
  probe "exec" bwrap --ro-bind /usr /usr --ro-bind /bin /bin --ro-bind /lib /lib \
    --ro-bind /lib64 /lib64 --proc /proc --dev /dev --unshare-all --die-with-parent \
    /bin/echo "sandbox exec ok"

  # Filesystem isolation: /root must NOT be visible when it is not bound.
  if bwrap --ro-bind /usr /usr --ro-bind /bin /bin --ro-bind /lib /lib --ro-bind /lib64 /lib64 \
      --proc /proc --dev /dev --unshare-all --die-with-parent /bin/ls /root >/dev/null 2>&1; then
    printf '%-24s FAIL host home was visible inside sandbox\n' "fs-isolation"
  else
    printf '%-24s OK   host home not visible\n' "fs-isolation"
  fi

  # Network isolation: egress must fail under --unshare-all.
  code=$(bwrap --ro-bind / / --proc /proc --dev /dev --unshare-all --die-with-parent \
    /usr/bin/curl -s -m 5 -o /dev/null -w '%{http_code}' https://example.com 2>/dev/null || true)
  if [ "$code" = "000" ] || [ -z "$code" ]; then
    printf '%-24s OK   egress denied (code=%s)\n' "net-isolation" "${code:-none}"
  else
    printf '%-24s FAIL egress reached network (code=%s)\n' "net-isolation" "$code"
  fi
fi

section "resources"
printf 'cpus  %s\n' "$(nproc)"
free -m | head -2
df -h / | tail -1
printf 'fstype(/) %s\n' "$(stat -f -c '%T' / 2>/dev/null || echo unknown)"

section "credential presence (never the value)"
if [ -n "${DASHSCOPE_API_KEY:-}" ]; then
  echo "DASHSCOPE_API_KEY: present (length ${#DASHSCOPE_API_KEY}); live lane AVAILABLE"
else
  echo "DASHSCOPE_API_KEY: absent; live lane BLOCKED"
fi
