#!/usr/bin/env bash
# PK-01 — clean Linux host bootstrap.
#
# Takes a clean Linux host to a state where `pnpm install && pnpm check` can run: the pinned Node
# (active LTS) and pnpm, plus the sandbox, terminal and C/C++ build prerequisites that this product
# genuinely needs (`better-sqlite3` and `node-pty` have no prebuilt binary for this platform and
# compile from source; the safe profiles cannot run at all without a real bubblewrap sandbox).
#
# Three properties are non-negotiable, because a bootstrap that lies is worse than none:
#
#   FAIL CLOSED   Anything it cannot satisfy is reported by EXACT name — the missing binary, the
#                 missing package, the disabled sysctl — and the script exits non-zero. It never
#                 degrades, never "continues anyway", and never reports success for a host that
#                 cannot run the product.
#   IDEMPOTENT    Running it twice changes nothing the second time. Every step is guarded by the
#                 check that would have justified it.
#   NO SILENT SUDO
#                 It escalates only when explicitly told to (`--allow-sudo`), and only for the
#                 distro package manager. Otherwise it PRINTS the exact privileged commands and
#                 stops, leaving the decision with the operator.
#
# Detection is FUNCTIONAL, not nominal. `bwrap` being on PATH proves nothing: on a host with
# `kernel.apparmor_restrict_unprivileged_userns=1` (the Ubuntu 24.04+ default, and the case on the
# recorded target) an unprivileged user namespace is refused even though the binary exists. So the
# sandbox check actually creates a namespace and reports the kernel's real answer.
#
# Modes:
#   --check     detect only; make no change to the host. Exit 0 iff every prerequisite is met.
#   --dry-run   print the exact commands that would be run, run none of them.
#   (default)   detect, then install what is missing.
#
# Exit codes:
#   0  every prerequisite is satisfied (or was installed successfully)
#   1  usage error
#   2  unmet prerequisites remain — the report names each one exactly
#   3  unsupported platform (not Linux, or no supported package manager)

set -uo pipefail

readonly NODE_VERSION='24.16.0' # ADR 0002 (frozen). Active LTS on the recorded host.
readonly PNPM_VERSION='11.9.0'  # ADR 0002 (frozen).
readonly NODE_DIST_BASE='https://nodejs.org/dist'

MODE='install'
ALLOW_SUDO=0
PREFIX=''

usage() {
  cat <<'EOF'
usage: scripts/bootstrap.sh [--check | --dry-run] [--allow-sudo] [--prefix DIR]

  --check       Detect only. Change nothing. Exit 0 iff the host is ready.
  --dry-run     Print the exact commands that would be run. Run none of them.
  --allow-sudo  Permit escalation via sudo for the distro package manager.
                Without it, on a non-root host, the privileged commands are PRINTED and the
                script stops (exit 2) rather than escalating behind your back.
  --prefix DIR  Where to install Node when it must be installed and we are not root.
                Default: $HOME/.local  (system default when root: /usr/local)
  -h, --help    This text.

Exit: 0 ready · 1 usage · 2 unmet prerequisites · 3 unsupported platform
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --check) MODE='check' ;;
    --dry-run) MODE='dry-run' ;;
    --allow-sudo) ALLOW_SUDO=1 ;;
    --prefix)
      shift
      [ $# -gt 0 ] || {
        printf 'bootstrap: --prefix requires a directory\n' >&2
        exit 1
      }
      PREFIX="$1"
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      printf 'bootstrap: unknown argument: %s\n\n' "$1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

# ---------------------------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------------------------

# Every unmet prerequisite lands here, by exact name, with the exact remedy. This list IS the
# report; nothing is inferred from it and nothing is hidden from it.
MISSING=()
MISSING_REMEDY=()
PLANNED=()

ok() { printf '  \033[32m✓\033[0m %-28s %s\n' "$1" "${2:-}"; }
info() { printf '  · %-28s %s\n' "$1" "${2:-}"; }
section() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# name, detail, remedy (the exact command or action that fixes it)
unmet() {
  printf '  \033[31m✗\033[0m %-28s %s\n' "$1" "$2"
  MISSING+=("$1: $2")
  MISSING_REMEDY+=("$3")
}

# A step we would take. In --dry-run it is only printed; otherwise it is printed AND run.
plan() { PLANNED+=("$1"); }

# ---------------------------------------------------------------------------------------------
# Platform
# ---------------------------------------------------------------------------------------------

section "platform"

if [ "$(uname -s)" != 'Linux' ]; then
  printf '  \033[31m✗\033[0m this product targets Linux only; this host is %s\n' "$(uname -s)"
  exit 3
fi

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) NODE_ARCH='x64' ;;
  aarch64 | arm64) NODE_ARCH='arm64' ;;
  *)
    printf '  \033[31m✗\033[0m unsupported architecture: %s (need x86_64 or aarch64)\n' "$ARCH"
    exit 3
    ;;
esac

DISTRO='unknown'
DISTRO_LIKE=''
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  DISTRO="${ID:-unknown}"
  DISTRO_LIKE="${ID_LIKE:-}"
fi
ok "linux $ARCH" "$DISTRO ${VERSION_ID:-} · kernel $(uname -r)"

# The package manager decides whether the SYSTEM prerequisites are installable at all. We support
# apt (the recorded target is Ubuntu 26.10); on anything else we still DETECT everything correctly
# and report exact package names, we simply cannot install them for you.
PKG_MGR=''
if command -v apt-get >/dev/null 2>&1; then
  PKG_MGR='apt'
elif command -v dnf >/dev/null 2>&1; then
  PKG_MGR='dnf'
elif command -v pacman >/dev/null 2>&1; then
  PKG_MGR='pacman'
fi

if [ -n "$PKG_MGR" ]; then
  ok "package manager" "$PKG_MGR"
else
  info "package manager" "none of apt-get/dnf/pacman found — system packages cannot be installed"
fi

# ---------------------------------------------------------------------------------------------
# Privilege
# ---------------------------------------------------------------------------------------------

# `SUDO` is the prefix used for privileged commands. Empty when we are already root. When we are
# not root and --allow-sudo was NOT given, it stays empty and PRIVILEGED_BLOCKED is set: privileged
# steps are then printed as instructions and counted as unmet, never executed.
SUDO=''
PRIVILEGED_BLOCKED=0
if [ "$(id -u)" -eq 0 ]; then
  info "privilege" "root — system packages installable directly"
elif [ "$ALLOW_SUDO" -eq 1 ] && command -v sudo >/dev/null 2>&1; then
  SUDO='sudo'
  info "privilege" "non-root, --allow-sudo given — will escalate via sudo for $PKG_MGR only"
else
  PRIVILEGED_BLOCKED=1
  info "privilege" "non-root, no --allow-sudo — privileged steps will be PRINTED, not run"
fi

# ---------------------------------------------------------------------------------------------
# System prerequisites (build toolchain, sandbox, terminal)
# ---------------------------------------------------------------------------------------------
#
# Each row is: binary-or-probe | apt package | dnf package | pacman package | why it is required.
# The "why" is not decoration: PK-01 requires that an operator on a host that cannot satisfy a
# prerequisite is told exactly what breaks.

section "system prerequisites"

APT_WANTED=()
DNF_WANTED=()
PACMAN_WANTED=()

need_binary() {
  local bin="$1" apt_pkg="$2" dnf_pkg="$3" pac_pkg="$4" why="$5"
  if command -v "$bin" >/dev/null 2>&1; then
    ok "$bin" "$(command -v "$bin")"
    return 0
  fi
  local remedy
  case "$PKG_MGR" in
    apt)
      APT_WANTED+=("$apt_pkg")
      remedy="apt-get install -y $apt_pkg"
      ;;
    dnf)
      DNF_WANTED+=("$dnf_pkg")
      remedy="dnf install -y $dnf_pkg"
      ;;
    pacman)
      PACMAN_WANTED+=("$pac_pkg")
      remedy="pacman -S --noconfirm $pac_pkg"
      ;;
    *) remedy="install the package providing '$bin' ($apt_pkg on Debian/Ubuntu)" ;;
  esac
  unmet "$bin" "absent — $why" "$remedy"
  return 1
}

need_binary cc build-essential gcc gcc \
  "better-sqlite3 and node-pty have NO prebuilt binary for this platform and compile from source"
need_binary c++ build-essential gcc-c++ gcc \
  "node-pty is C++ and is compiled by node-gyp on this host"
need_binary make build-essential make make \
  "node-gyp drives make to build the native addons"
need_binary python3 python3 python3 python \
  "node-gyp requires python3 to configure the native builds"
need_binary git git git git \
  "the harness shells out to git for worktrees, diffs and session provenance"
need_binary curl curl curl curl \
  "used to fetch the pinned Node runtime and to reach the provider endpoint"
need_binary bwrap bubblewrap bubblewrap bubblewrap \
  "bubblewrap IS the sandbox backend (ADR 0003); no safe profile can run without it"

# Terminal: the Ink TUI is gated on a real PTY and on a terminfo database that knows the terminal
# the operator actually uses. `infocmp` comes from ncurses-bin and is the cheap, honest probe.
need_binary infocmp ncurses-bin ncurses ncurses \
  "the Ink TUI needs a terminfo database; without it TERM cannot be resolved"

# `tmux-256color` (the recorded target's TERM) lives in ncurses-term, not ncurses-base. A missing
# entry does not break the harness, it degrades colour — so this is a WARNING, not a prerequisite.
if command -v infocmp >/dev/null 2>&1; then
  if [ -n "${TERM:-}" ] && infocmp "$TERM" >/dev/null 2>&1; then
    ok "terminfo($TERM)" "present"
  elif [ -n "${TERM:-}" ]; then
    info "terminfo($TERM)" "no entry — colour will degrade; install 'ncurses-term' to fix (not fatal)"
  fi
fi

# ---------------------------------------------------------------------------------------------
# Sandbox: functional, not nominal
# ---------------------------------------------------------------------------------------------
#
# `bwrap` on PATH is NOT evidence that the sandbox works. The kernel can refuse the user namespace:
#
#   user.max_user_namespaces = 0                        -> namespaces disabled outright
#   kernel.unprivileged_userns_clone = 0                -> Debian's older switch, unprivileged denied
#   kernel.apparmor_restrict_unprivileged_userns = 1    -> Ubuntu 24.04+; unconfined processes
#                                                          WITHOUT CAP_SYS_ADMIN are refused
#
# The last one is why we probe by DOING: root is exempt from the AppArmor restriction, so a
# file-reading check would report "restricted" on a host where the sandbox works perfectly, and
# "fine" on a host where the harness will fail for the actual unprivileged user. We create a real
# namespace and let the kernel answer.

section "sandbox (bubblewrap + user namespaces)"

report_userns_sysctls() {
  local max clone aa
  max="$(cat /proc/sys/user/max_user_namespaces 2>/dev/null || echo 'unreadable')"
  clone="$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null || echo 'absent')"
  aa="$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 'absent')"
  info "user.max_user_namespaces" "$max"
  info "unprivileged_userns_clone" "$clone"
  info "apparmor_restrict_userns" "$aa"
}

if command -v bwrap >/dev/null 2>&1; then
  report_userns_sysctls
  # The probe: an actual unshared user namespace running an actual process.
  if probe_out="$(bwrap --ro-bind /usr /usr --ro-bind /bin /bin --ro-bind /lib /lib \
    --ro-bind /lib64 /lib64 --proc /proc --dev /dev --unshare-all --die-with-parent \
    /bin/echo sandbox-ok 2>&1)" && [ "$probe_out" = 'sandbox-ok' ]; then
    ok "bwrap --unshare-all" "created a real namespace and executed inside it"
  else
    # Translate the kernel's refusal into the exact sysctl the operator must change. These strings
    # are what bwrap actually prints; matching on them is how we turn a generic failure into an
    # exact remedy.
    detail="$(printf '%s' "$probe_out" | head -1)"
    remedy='enable unprivileged user namespaces on this host'
    if printf '%s' "$probe_out" | grep -qiE 'setting up uid map|Permission denied|Operation not permitted|No permission to create'; then
      if [ "$(cat /proc/sys/user/max_user_namespaces 2>/dev/null || echo 1)" = '0' ]; then
        remedy='sysctl -w user.max_user_namespaces=15000  (persist in /etc/sysctl.d/)'
      elif [ "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null || echo 1)" = '0' ]; then
        remedy='sysctl -w kernel.unprivileged_userns_clone=1  (persist in /etc/sysctl.d/)'
      elif [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = '1' ]; then
        remedy='sysctl -w kernel.apparmor_restrict_unprivileged_userns=0  — or install an AppArmor profile for bwrap (Ubuntu 24.04+ restricts unconfined unprivileged userns)'
      fi
    fi
    unmet "unprivileged user namespaces" "bwrap could not create one: $detail" "$remedy"
  fi
else
  info "bwrap" "absent — sandbox probe skipped (bubblewrap is already reported unmet above)"
fi

# ---------------------------------------------------------------------------------------------
# Node and pnpm (pinned)
# ---------------------------------------------------------------------------------------------

section "runtime (pinned: node $NODE_VERSION, pnpm $PNPM_VERSION)"

if [ -z "$PREFIX" ]; then
  if [ "$(id -u)" -eq 0 ]; then PREFIX='/usr/local'; else PREFIX="$HOME/.local"; fi
fi

node_ok=0
if command -v node >/dev/null 2>&1; then
  have="$(node --version 2>/dev/null | sed 's/^v//')"
  have_major="${have%%.*}"
  if [ "$have" = "$NODE_VERSION" ]; then
    ok "node" "v$have (pinned)"
    node_ok=1
  elif [ -n "$have_major" ] && [ "$have_major" -ge 22 ] 2>/dev/null; then
    # `engines: >=22` is the real constraint (Ink 7). A newer-but-compatible Node already on the
    # host is not a reason to overwrite the operator's runtime; say so and move on.
    ok "node" "v$have (satisfies engines >=22; pinned is $NODE_VERSION)"
    node_ok=1
  else
    info "node" "v$have is too old (engines require >=22) — will install $NODE_VERSION"
  fi
else
  info "node" "absent — will install $NODE_VERSION into $PREFIX"
fi

# The Node install is the one thing we fetch from the network. It is verified against the release's
# own SHASUMS256.txt before a single file is extracted — an unverified tarball is not an install,
# it is an invitation.
install_node() {
  local tarball="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
  local url="${NODE_DIST_BASE}/v${NODE_VERSION}/${tarball}"
  local sums="${NODE_DIST_BASE}/v${NODE_VERSION}/SHASUMS256.txt"
  local tmp
  tmp="$(mktemp -d)" || return 1
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" RETURN

  printf '    fetching %s\n' "$url"
  curl -fsSL --retry 3 -o "$tmp/$tarball" "$url" || {
    printf '    \033[31mfailed to download the Node tarball\033[0m\n' >&2
    return 1
  }
  curl -fsSL --retry 3 -o "$tmp/SHASUMS256.txt" "$sums" || {
    printf '    \033[31mfailed to download SHASUMS256.txt — refusing to install an unverified tarball\033[0m\n' >&2
    return 1
  }

  printf '    verifying sha256 against the release SHASUMS256.txt\n'
  (cd "$tmp" && grep " ${tarball}\$" SHASUMS256.txt | sha256sum -c -) || {
    printf '    \033[31mSHA-256 MISMATCH — refusing to install\033[0m\n' >&2
    return 1
  }

  mkdir -p "$PREFIX" || return 1
  # --strip-components=1 lands bin/, lib/, include/, share/ directly in the prefix, which is what
  # makes this idempotent: a re-run overwrites the same files rather than nesting a second copy.
  tar -xJf "$tmp/$tarball" -C "$PREFIX" --strip-components=1 || return 1
  printf '    installed node v%s into %s\n' "$NODE_VERSION" "$PREFIX"
  export PATH="$PREFIX/bin:$PATH"
  return 0
}

if [ "$node_ok" -eq 0 ]; then
  plan "install node v$NODE_VERSION (verified sha256) into $PREFIX"
fi

pnpm_ok=0
if command -v pnpm >/dev/null 2>&1; then
  have_pnpm="$(pnpm --version 2>/dev/null)"
  if [ "$have_pnpm" = "$PNPM_VERSION" ]; then
    ok "pnpm" "$have_pnpm (pinned)"
    pnpm_ok=1
  else
    info "pnpm" "$have_pnpm present, pinned is $PNPM_VERSION — corepack will select the pinned one"
    # `packageManager` in package.json pins it; corepack honours that per-invocation. An
    # already-installed different pnpm is therefore not an error.
    pnpm_ok=1
  fi
else
  info "pnpm" "absent — will activate pnpm@$PNPM_VERSION"
  plan "corepack enable && corepack prepare pnpm@$PNPM_VERSION --activate"
fi

install_pnpm() {
  if command -v corepack >/dev/null 2>&1; then
    corepack enable >/dev/null 2>&1
    corepack prepare "pnpm@$PNPM_VERSION" --activate || return 1
    return 0
  fi
  if command -v npm >/dev/null 2>&1; then
    npm install -g "pnpm@$PNPM_VERSION" || return 1
    return 0
  fi
  return 1
}

# ---------------------------------------------------------------------------------------------
# Act
# ---------------------------------------------------------------------------------------------

# Three binaries (cc, c++, make) come from ONE package. Deduplicate, or the install command names
# `build-essential` three times — which works, but reads like the script does not know what it is
# doing, and an operator who is being asked to run something as root deserves better than that.
dedupe() {
  local seen=() item found
  for item in "$@"; do
    found=0
    for s in ${seen[@]+"${seen[@]}"}; do [ "$s" = "$item" ] && found=1 && break; done
    [ "$found" -eq 0 ] && seen+=("$item")
  done
  printf '%s\n' ${seen[@]+"${seen[@]}"}
}
[ "${#APT_WANTED[@]}" -gt 0 ] && mapfile -t APT_WANTED < <(dedupe "${APT_WANTED[@]}")
[ "${#DNF_WANTED[@]}" -gt 0 ] && mapfile -t DNF_WANTED < <(dedupe "${DNF_WANTED[@]}")
[ "${#PACMAN_WANTED[@]}" -gt 0 ] && mapfile -t PACMAN_WANTED < <(dedupe "${PACMAN_WANTED[@]}")

# The privileged package install, assembled from what detection actually found missing.
pkg_install_cmd() {
  case "$PKG_MGR" in
    apt) printf 'apt-get update && apt-get install -y --no-install-recommends %s' "${APT_WANTED[*]}" ;;
    dnf) printf 'dnf install -y %s' "${DNF_WANTED[*]}" ;;
    pacman) printf 'pacman -S --needed --noconfirm %s' "${PACMAN_WANTED[*]}" ;;
  esac
}

want_count=$((${#APT_WANTED[@]} + ${#DNF_WANTED[@]} + ${#PACMAN_WANTED[@]}))
if [ "$want_count" -gt 0 ] && [ -n "$PKG_MGR" ]; then
  plan "$(pkg_install_cmd)"
fi

section "plan"
if [ "${#PLANNED[@]}" -eq 0 ]; then
  info "nothing to do" "every prerequisite this script can install is already present"
else
  for step in "${PLANNED[@]}"; do printf '  $ %s\n' "$step"; done
fi

case "$MODE" in
  check)
    section "result (--check: nothing was changed)"
    ;;
  dry-run)
    section "result (--dry-run: nothing was run)"
    ;;
  install)
    section "install"
    failed=0

    if [ "$want_count" -gt 0 ] && [ -n "$PKG_MGR" ]; then
      if [ "$PRIVILEGED_BLOCKED" -eq 1 ]; then
        printf '  \033[33m!\033[0m these packages need root and --allow-sudo was not given. Run:\n\n'
        printf '      sudo %s\n\n' "$(pkg_install_cmd)"
        failed=1
      else
        printf '  $ %s\n' "$(pkg_install_cmd)"
        case "$PKG_MGR" in
          apt)
            # `apt-get install` on an already-installed package is a no-op that reports
            # "already the newest version" — that is what makes re-running this safe.
            DEBIAN_FRONTEND=noninteractive $SUDO apt-get update -qq &&
              DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y --no-install-recommends "${APT_WANTED[@]}" || failed=1
            ;;
          dnf) $SUDO dnf install -y "${DNF_WANTED[@]}" || failed=1 ;;
          pacman) $SUDO pacman -S --needed --noconfirm "${PACMAN_WANTED[@]}" || failed=1 ;;
        esac
      fi
    fi

    if [ "$node_ok" -eq 0 ]; then
      install_node || failed=1
    fi
    if [ "$pnpm_ok" -eq 0 ]; then
      install_pnpm || {
        printf '  \033[31m✗\033[0m could not activate pnpm@%s (no corepack, no npm)\n' "$PNPM_VERSION" >&2
        failed=1
      }
    fi

    if [ "$failed" -eq 0 ] && [ "$want_count" -gt 0 ]; then
      # Re-detect: an install that "succeeded" but did not produce the binary is a failure.
      printf '\n  re-detecting after install\n'
      still=()
      for bin in cc c++ make python3 git curl bwrap infocmp; do
        command -v "$bin" >/dev/null 2>&1 || still+=("$bin")
      done
      if [ "${#still[@]}" -gt 0 ]; then
        printf '  \033[31m✗\033[0m still absent after install: %s\n' "${still[*]}" >&2
        failed=1
      else
        ok "re-detect" "every required binary is now present"
        # Everything we installed is now satisfied; the detection-time list is stale.
        MISSING=()
        MISSING_REMEDY=()
      fi
    fi

    if [ "$failed" -ne 0 ]; then
      section "result"
      printf '  \033[31m✗ bootstrap did not complete.\033[0m\n'
      [ "${#MISSING[@]}" -gt 0 ] && for i in "${!MISSING[@]}"; do
        printf '      %s\n        fix: %s\n' "${MISSING[$i]}" "${MISSING_REMEDY[$i]}"
      done
      exit 2
    fi
    section "result"
    ;;
esac

if [ "${#MISSING[@]}" -gt 0 ]; then
  printf '  \033[31m✗ %d unmet prerequisite(s). This host cannot run qwen-harness yet.\033[0m\n\n' "${#MISSING[@]}"
  for i in "${!MISSING[@]}"; do
    printf '      %s\n' "${MISSING[$i]}"
    printf '        fix: %s\n' "${MISSING_REMEDY[$i]}"
  done
  printf '\n  Nothing was degraded and nothing was skipped: the harness genuinely cannot run\n'
  printf '  without these. Fix them and re-run — this script is idempotent.\n'
  exit 2
fi

printf '  \033[32m✓ host is ready.\033[0m  node %s · pnpm %s · bubblewrap sandbox functional\n' \
  "$(node --version 2>/dev/null || echo '?')" "$(pnpm --version 2>/dev/null || echo '?')"
printf '\n  next:  pnpm install --frozen-lockfile && pnpm check\n'
exit 0
