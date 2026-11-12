#!/usr/bin/env bash
# paseo-runtime-smoke.sh <plugin-dir> [paseo-version]
#
# Starts a throwaway, headless Paseo daemon in a temp home, installs the plugin
# from <plugin-dir>, waits until the daemon reports it "running" (or "failed"),
# and exits non-zero (printing plugin logs + daemon errors) on failure.
#
# Only the plugin's *server* half is executed. The daemon also esbuild-bundles
# the client half (index.client.tsx) at load time, so bundling/resolution errors
# there are caught, but client code is never rendered (that needs the app).
#
# Env knobs:
#   PASEO_SMOKE_TIMEOUT   seconds to wait for running/failed (default 120)
#   PASEO_SMOKE_SETTLE    seconds the plugin must stay "running" (default 3)
#   PASEO_SMOKE_PORT      daemon listen port (default: random 20000-29999)
#   PASEO_SMOKE_KEEP=1    keep the temp home for inspection
#   PASEO_BIN             use this paseo binary instead of npm-installing one
set -euo pipefail

PLUGIN_DIR="${1:?usage: $0 <plugin-dir> [paseo-version]}"
PASEO_VERSION="${2:-latest}"
TIMEOUT="${PASEO_SMOKE_TIMEOUT:-120}"
SETTLE="${PASEO_SMOKE_SETTLE:-3}"
PORT="${PASEO_SMOKE_PORT:-$((20000 + RANDOM % 10000))}"

PLUGIN_DIR="$(cd "$PLUGIN_DIR" && pwd)"
[[ -f "$PLUGIN_DIR/paseo-plugin.json" ]] || { echo "::error::no paseo-plugin.json in $PLUGIN_DIR" >&2; exit 2; }
PLUGIN_ID="$(node -p 'require(process.argv[1]).id' "$PLUGIN_DIR/paseo-plugin.json")"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/paseo-smoke.XXXXXX")"
HOME_DIR="$WORK/home"
mkdir -p "$HOME_DIR"
t0=$(date +%s)
log() { printf '[smoke +%3ss] %s\n' "$(( $(date +%s) - t0 ))" "$*"; }

# --- paseo CLI ---------------------------------------------------------------
if [[ -n "${PASEO_BIN:-}" ]]; then
  PASEO="$PASEO_BIN"
else
  log "installing @getpaseo/cli@$PASEO_VERSION into $WORK/cli"
  npm install --prefix "$WORK/cli" --no-audit --no-fund --loglevel=error \
    "@getpaseo/cli@$PASEO_VERSION" >/dev/null
  PASEO="$WORK/cli/node_modules/.bin/paseo"
fi
p() { "$PASEO" "$@" --home "$HOME_DIR"; }
log "paseo $("$PASEO" --version)"

# --- headless daemon config --------------------------------------------------
# pluginsEnabled is the global plugin switch (off by default -> status "disabled").
# Relay, dictation and voice are off so nothing reaches the network or downloads
# speech models (~300 MB) in CI.
cat >"$HOME_DIR/config.json" <<EOF
{
  "version": 1,
  "pluginsEnabled": true,
  "daemon": { "listen": "127.0.0.1:$PORT", "relay": { "enabled": false } },
  "features": { "dictation": { "enabled": false }, "voiceMode": { "enabled": false } }
}
EOF
export PASEO_RELAY_ENABLED=false PASEO_DICTATION_ENABLED=false PASEO_VOICE_MODE_ENABLED=false

cleanup() {
  local rc=$?
  # --force: in containers without an init (docker, act) exited children linger
  # as zombies and a graceful stop waits its full timeout for them.
  "$PASEO" daemon stop --home "$HOME_DIR" --timeout 5 --force >/dev/null 2>&1 || true
  if [[ -f "$HOME_DIR/paseo.pid" ]]; then
    pid=$(node -p 'try{JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).pid}catch{""}' "$HOME_DIR/paseo.pid" 2>/dev/null || true)
    [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
  fi
  if [[ "${PASEO_SMOKE_KEEP:-0}" == 1 ]]; then echo "kept $WORK"; else rm -rf "$WORK"; fi
  exit $rc
}
trap cleanup EXIT

dump_failure() {
  echo "----- paseo plugin ls --json -----"; p plugin ls --json || true
  echo "----- paseo plugin logs $PLUGIN_ID -----"; p plugin logs "$PLUGIN_ID" || true
  echo "----- daemon.log (warn/error) -----"
  grep -E '"level":(40|50|60)' "$HOME_DIR/daemon.log" 2>/dev/null | tail -n 40 || true
}

log "starting daemon on 127.0.0.1:$PORT"
p start --timeout 60 </dev/null
log "daemon up"

# Install from a copy so the daemon never writes into the caller's checkout.
cp -R "$PLUGIN_DIR" "$WORK/plugin"
rm -rf "$WORK/plugin/.git"
log "installing plugin '$PLUGIN_ID'"
if ! p plugin install "$WORK/plugin" --json </dev/null >"$WORK/install.json" 2>"$WORK/install.err"; then
  cat "$WORK/install.err" "$WORK/install.json" >&2
  echo "::error::paseo plugin install failed"; dump_failure; exit 1
fi

status_of() {
  p plugin ls "$PLUGIN_ID" --json 2>/dev/null | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      try{let d=JSON.parse(s);d=Array.isArray(d)?d[0]:d;
        console.log((d&&d.status)||"unknown", JSON.stringify((d&&d.error)||""))}
      catch{console.log("unknown \"\"")}})'
}

deadline=$(( $(date +%s) + TIMEOUT ))
status=unknown; err=""
while (( $(date +%s) < deadline )); do
  read -r status err < <(status_of)
  case "$status" in running|failed) break ;; esac
  sleep 1
done

if [[ "$status" == running ]]; then
  # Make sure it doesn't crash right after the "ready" handshake.
  sleep "$SETTLE"
  read -r status err < <(status_of)
fi

log "plugin status: $status ${err:+error=$err}"
if [[ "$status" != running ]]; then
  echo "::error::plugin '$PLUGIN_ID' did not reach status=running (got: $status) $err"
  dump_failure
  exit 1
fi
p plugin logs "$PLUGIN_ID" || true
log "OK: plugin '$PLUGIN_ID' is running on paseo $("$PASEO" --version)"
