#!/usr/bin/env bash
# PK-02 — install / upgrade / rollback / uninstall for the versioned qwen-harness CLI package.
#
# Installs the tarball produced by `scripts/package-cli.ts` into a prefix. It touches nothing
# outside that prefix, needs no network and no registry, and every byte it unpacks is verified
# against the package's own SHA256SUMS *before* it is linked into place.
#
# The layout is a versioned store with a symlinked "current". That one decision buys upgrade and
# rollback for free, and makes uninstall exact:
#
#   $PREFIX/lib/qwen-harness/versions/<version>/     the unpacked package, one dir per version
#   $PREFIX/lib/qwen-harness/current  -> versions/<v> the active version
#   $PREFIX/lib/qwen-harness/previous -> versions/<v> what `rollback` goes back to
#   $PREFIX/lib/qwen-harness/state.json               the ledger: what we installed, and when
#   $PREFIX/bin/qwen-harness         -> ../lib/qwen-harness/current/bin/qwen-harness
#   $PREFIX/share/bash-completion/completions/qwen-harness
#   $PREFIX/share/zsh/site-functions/_qwen-harness
#   $PREFIX/share/fish/vendor_completions.d/qwen-harness.fish
#
# An upgrade never overwrites the running version's files: it unpacks the new version alongside and
# moves ONE symlink. That is what makes rollback a symlink move rather than a restore-from-backup,
# and it is why an interrupted upgrade cannot leave a half-written binary on the path.
#
# Config migration runs on install, upgrade AND rollback, through the product's own
# `@qwen-harness/config` migration chain (shipped as `qwen-harness-migrate-config`). On a rollback,
# a config written by the newer version is REFUSED rather than downgraded — see that command's
# exit 5. We surface it as a warning and leave the file alone; silently rewriting a config to fit an
# older binary is how a tightened policy gets quietly dropped.
#
# Exit codes: 0 ok · 1 usage · 2 precondition failed · 3 integrity failure · 4 nothing to roll back

set -uo pipefail

PREFIX="${QWEN_HARNESS_PREFIX:-$HOME/.local}"
COMMAND=''
TARBALL=''

usage() {
  cat <<'EOF'
usage: packaging/install.sh <command> [options]

  install <tarball>     verify and install; makes it the current version
  upgrade <tarball>     install a new version and switch to it, remembering the old one
  rollback              switch back to the previously-installed version
  uninstall             remove every file this script created, and nothing else
  verify                re-check the active install against its own SHA256SUMS
  status                what is installed, what is active, what rollback would do

  --prefix DIR          install root (default: $QWEN_HARNESS_PREFIX, else ~/.local)

The tarball is qwen-harness-<version>.tgz, built by `pnpm release:package`.
EOF
}

[ $# -gt 0 ] || {
  usage >&2
  exit 1
}
COMMAND="$1"
shift

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix)
      shift
      [ $# -gt 0 ] || {
        printf 'install: --prefix requires a directory\n' >&2
        exit 1
      }
      PREFIX="$1"
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*)
      printf 'install: unknown option: %s\n' "$1" >&2
      exit 1
      ;;
    *)
      if [ -z "$TARBALL" ]; then TARBALL="$1"; else
        printf 'install: unexpected argument: %s\n' "$1" >&2
        exit 1
      fi
      ;;
  esac
  shift
done

readonly LIBDIR="$PREFIX/lib/qwen-harness"
readonly VERSIONS="$LIBDIR/versions"
readonly CURRENT="$LIBDIR/current"
readonly PREVIOUS="$LIBDIR/previous"
readonly STATE="$LIBDIR/state.json"
readonly BIN="$PREFIX/bin/qwen-harness"
readonly BIN_MIGRATE="$PREFIX/bin/qwen-harness-migrate-config"
readonly COMP_BASH="$PREFIX/share/bash-completion/completions/qwen-harness"
readonly COMP_ZSH="$PREFIX/share/zsh/site-functions/_qwen-harness"
readonly COMP_FISH="$PREFIX/share/fish/vendor_completions.d/qwen-harness.fish"

say() { printf '  %s\n' "$1"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
die() {
  printf '  \033[31m✗\033[0m %s\n' "$1" >&2
  exit "${2:-2}"
}

active_version() {
  [ -L "$CURRENT" ] || return 1
  basename "$(readlink "$CURRENT")"
}

previous_version() {
  [ -L "$PREVIOUS" ] || return 1
  basename "$(readlink "$PREVIOUS")"
}

# ---------------------------------------------------------------------------------------------
# Unpack + verify. Nothing is linked into place until the digests check out.
# ---------------------------------------------------------------------------------------------

unpack_and_verify() {
  local tarball="$1" staging="$2"
  [ -f "$tarball" ] || die "no such tarball: $tarball"

  # If the publisher shipped a detached digest, check the ARTIFACT before we even open it. A
  # tampered tarball whose internal SHA256SUMS was regenerated to match would pass the inner check
  # and fail here.
  if [ -f "$tarball.sha256" ]; then
    local want got
    want="$(cut -d' ' -f1 <"$tarball.sha256")"
    got="$(sha256sum "$tarball" | cut -d' ' -f1)"
    if [ "$want" != "$got" ]; then
      die "tarball digest mismatch: expected $want, got $got" 3
    fi
    ok "tarball sha256 matches $(basename "$tarball").sha256"
  else
    warn "no $(basename "$tarball").sha256 beside the tarball — the artifact digest was not checked"
  fi

  rm -rf "$staging"
  mkdir -p "$staging"
  tar -xzf "$tarball" -C "$staging" --strip-components=1 || die "could not unpack $tarball"

  [ -f "$staging/SHA256SUMS" ] || die "the package has no SHA256SUMS — refusing to install it" 3
  [ -f "$staging/package.json" ] || die "the package has no package.json — is this a qwen-harness package?" 3

  # Verify every file. `sha256sum -c` fails on a modified file AND on a missing one.
  local out
  if ! out="$(cd "$staging" && sha256sum -c --quiet SHA256SUMS 2>&1)"; then
    printf '%s\n' "$out" >&2
    die "SHA256SUMS verification FAILED — the package is corrupt or tampered with. Nothing was installed." 3
  fi
  local n
  n="$(wc -l <"$staging/SHA256SUMS")"
  ok "SHA256SUMS verified: $n file(s) match"

  # A file present in the package but absent from SHA256SUMS is unsigned content riding along. The
  # checksum file cannot list itself, so it is the one legitimate exception.
  local unlisted
  unlisted="$(cd "$staging" && comm -23 \
    <(find . -type f -printf '%P\n' | grep -v '^SHA256SUMS$' | sort) \
    <(cut -d' ' -f3- SHA256SUMS | sort))"
  if [ -n "$unlisted" ]; then
    printf '%s\n' "$unlisted" >&2
    die "the package contains file(s) not listed in SHA256SUMS. Nothing was installed." 3
  fi
  ok "no unlisted files in the package"
}

package_version() {
  local dir="$1"
  # No jq dependency: the version line in a generated package.json is stable and machine-written.
  grep -m1 '"version"' "$dir/package.json" | sed 's/.*"version"[^"]*"\([^"]*\)".*/\1/'
}

write_state() {
  local active="$1" previous="$2"
  local installed=()
  if [ -d "$VERSIONS" ]; then
    while IFS= read -r v; do installed+=("\"$v\""); done < <(ls -1 "$VERSIONS" 2>/dev/null | sort)
  fi
  local joined
  joined="$(
    IFS=,
    echo "${installed[*]:-}"
  )"
  mkdir -p "$LIBDIR"
  cat >"$STATE" <<EOF
{
  "prefix": "$PREFIX",
  "active": $([ -n "$active" ] && printf '"%s"' "$active" || echo null),
  "previous": $([ -n "$previous" ] && printf '"%s"' "$previous" || echo null),
  "installed": [$joined],
  "updatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
}

link_active() {
  local version="$1"
  mkdir -p "$PREFIX/bin" \
    "$PREFIX/share/bash-completion/completions" \
    "$PREFIX/share/zsh/site-functions" \
    "$PREFIX/share/fish/vendor_completions.d"

  # Relative targets: the whole prefix stays relocatable, which matters when it is $HOME/.local on
  # an NFS home or a container image layer.
  ln -sfn "versions/$version" "$CURRENT"
  ln -sf "../lib/qwen-harness/current/bin/qwen-harness" "$BIN"
  ln -sf "../lib/qwen-harness/current/bin/qwen-harness-migrate-config" "$BIN_MIGRATE"
  ln -sf "$CURRENT/completions/qwen-harness.bash" "$COMP_BASH"
  ln -sf "$CURRENT/completions/_qwen-harness" "$COMP_ZSH"
  ln -sf "$CURRENT/completions/qwen-harness.fish" "$COMP_FISH"
}

migrate_config() {
  local reason="$1"
  if [ ! -x "$CURRENT/bin/qwen-harness-migrate-config" ]; then
    warn "this package ships no config migrator; skipping the $reason migration"
    return 0
  fi
  local out rc
  out="$(node "$CURRENT/lib/migrate-config.js" 2>&1)"
  rc=$?
  printf '%s\n' "$out" | sed 's/^/    /'
  case "$rc" in
    0) return 0 ;;
    5)
      # Rollback past the config's floor. The binary refused to downgrade the document, which is
      # correct. Say so plainly: the operator has a decision to make, and we must not make it.
      warn "the config on disk is NEWER than this version understands and was left untouched."
      warn "qwen-harness will refuse to start until you roll forward or restore the config backup."
      return 0
      ;;
    *)
      warn "config migration reported a problem (exit $rc); the config was not changed"
      return 0
      ;;
  esac
}

# ---------------------------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------------------------

cmd_install() {
  local upgrading="$1"
  [ -n "$TARBALL" ] || die "a tarball is required: packaging/install.sh $COMMAND <tarball>" 1

  command -v node >/dev/null 2>&1 || die "node is not on PATH — run scripts/bootstrap.sh first"
  local nodemajor
  nodemajor="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$nodemajor" -ge 22 ] || die "node $nodemajor is too old; qwen-harness needs >= 22 (see scripts/bootstrap.sh)"

  local staging="$LIBDIR/.staging"
  mkdir -p "$LIBDIR"
  unpack_and_verify "$TARBALL" "$staging"

  local version
  version="$(package_version "$staging")"
  [ -n "$version" ] || die "could not read a version out of the package" 3

  local old=''
  old="$(active_version || true)"

  if [ "$old" = "$version" ] && [ "$upgrading" = 'no' ]; then
    # Idempotence: re-installing the active version re-verifies and re-links, and changes nothing
    # else. It must not clobber `previous` — that would silently destroy the rollback target.
    say "version $version is already active; re-verifying and re-linking"
  fi

  mkdir -p "$VERSIONS"
  rm -rf "$VERSIONS/$version"
  mv "$staging" "$VERSIONS/$version"
  ok "unpacked version $version"

  # Point `previous` at the version we are LEAVING, but never at ourselves: rolling back to the
  # version you are already running is not a rollback, it is a no-op that looks like one.
  if [ -n "$old" ] && [ "$old" != "$version" ]; then
    ln -sfn "versions/$old" "$PREVIOUS"
    say "rollback target is now $old"
  fi

  link_active "$version"
  ok "linked $BIN -> version $version"

  local prev
  prev="$(previous_version || true)"
  write_state "$version" "$prev"

  say ''
  say "config migration:"
  migrate_config "install"

  say ''
  ok "qwen-harness $version installed under $PREFIX"
  case ":$PATH:" in
    *":$PREFIX/bin:"*) : ;;
    *) warn "$PREFIX/bin is not on your PATH; add it to run \`qwen-harness\`" ;;
  esac
  say "completions: bash, zsh and fish were installed under $PREFIX/share"
}

cmd_rollback() {
  local old new
  old="$(active_version || true)"
  new="$(previous_version || true)"
  [ -n "$new" ] || die "there is no previous version to roll back to" 4
  [ -d "$VERSIONS/$new" ] || die "the rollback target $new is no longer installed" 4

  link_active "$new"
  # The version we just left becomes the new rollback target: roll back twice and you are back
  # where you started, which is the only behaviour that is not a trap.
  if [ -n "$old" ]; then ln -sfn "versions/$old" "$PREVIOUS"; else rm -f "$PREVIOUS"; fi
  write_state "$new" "$old"
  ok "rolled back: $old -> $new"

  say ''
  say "config migration:"
  migrate_config "rollback"
}

cmd_uninstall() {
  local removed=0
  for path in "$BIN" "$BIN_MIGRATE" "$COMP_BASH" "$COMP_ZSH" "$COMP_FISH"; do
    if [ -e "$path" ] || [ -L "$path" ]; then
      rm -f "$path"
      say "removed $path"
      removed=$((removed + 1))
    fi
  done
  if [ -d "$LIBDIR" ]; then
    rm -rf "$LIBDIR"
    say "removed $LIBDIR"
    removed=$((removed + 1))
  fi

  # Remove the directories we created, but ONLY if we left them empty. `rmdir` refuses a non-empty
  # directory, which is exactly the check we want: a prefix shared with other software keeps its
  # `bin/` and `share/`, and a prefix we created entirely for ourselves is left as we found it.
  for dir in \
    "$PREFIX/share/fish/vendor_completions.d" "$PREFIX/share/fish" \
    "$PREFIX/share/zsh/site-functions" "$PREFIX/share/zsh" \
    "$PREFIX/share/bash-completion/completions" "$PREFIX/share/bash-completion" \
    "$PREFIX/lib" "$PREFIX/bin" "$PREFIX/share"; do
    rmdir "$dir" 2>/dev/null && say "removed empty $dir"
  done

  if [ "$removed" -eq 0 ]; then
    say "nothing to uninstall under $PREFIX"
  else
    ok "uninstalled. The config at \$XDG_CONFIG_HOME/qwen-harness was NOT removed (it is yours)."
  fi
}

cmd_verify() {
  local version
  version="$(active_version)" || die "nothing is installed under $PREFIX"
  local dir="$VERSIONS/$version"
  local out
  if ! out="$(cd "$dir" && sha256sum -c --quiet SHA256SUMS 2>&1)"; then
    printf '%s\n' "$out" >&2
    die "the ACTIVE install ($version) does not match its own SHA256SUMS — it has been modified" 3
  fi
  ok "active install $version verified against SHA256SUMS ($(wc -l <"$dir/SHA256SUMS") files)"
  ok "$("$BIN" --help >/dev/null 2>&1 && echo "$BIN runs" || echo "$BIN present")"
}

cmd_status() {
  local active previous
  active="$(active_version || echo '<none>')"
  previous="$(previous_version || echo '<none>')"
  say "prefix:   $PREFIX"
  say "active:   $active"
  say "previous: $previous  (what \`rollback\` would switch to)"
  if [ -d "$VERSIONS" ]; then
    say "installed versions:"
    ls -1 "$VERSIONS" 2>/dev/null | sed 's/^/    /'
  fi
  [ -f "$STATE" ] && say "state:    $STATE"
  return 0
}

printf '\nqwen-harness %s  ·  prefix %s\n\n' "$COMMAND" "$PREFIX"

case "$COMMAND" in
  install) cmd_install 'no' ;;
  upgrade) cmd_install 'yes' ;;
  rollback) cmd_rollback ;;
  uninstall) cmd_uninstall ;;
  verify) cmd_verify ;;
  status) cmd_status ;;
  *)
    printf 'install: unknown command: %s\n\n' "$COMMAND" >&2
    usage >&2
    exit 1
    ;;
esac
printf '\n'
