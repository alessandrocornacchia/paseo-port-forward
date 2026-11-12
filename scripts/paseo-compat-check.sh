#!/usr/bin/env bash
# Static compatibility check of this plugin against a Paseo SDK version.
#
#   scripts/paseo-compat-check.sh [pinned|latest|<x.y.z>]
#
# "pinned" checks the versions in package-lock.json as-is. Anything else
# temporarily overrides every @getpaseo/* dependency (no lockfile change) and
# then runs the same typecheck / lint / test as normal CI. Locally, node_modules
# stays on the overridden SDK afterwards; `npm ci` restores the pinned one.
set -euo pipefail

target="${1:-pinned}"
cd "$(dirname "$0")/.."

npm ci --no-audit --no-fund

if [[ "$target" != "pinned" ]]; then
  version="$target"
  if [[ "$target" == "latest" ]]; then
    version="$(npm view "@getpaseo/plugin@$target" version | tail -n1)"
  fi
  # Every installed @getpaseo/* package, not just the declared ones: plugin
  # pulls in protocol as a peer, and mixing SDK versions gives false results.
  pkgs=$(ls node_modules/@getpaseo | sed 's|^|@getpaseo/|' | tr '\n' ' ')
  echo "::notice::Checking against Paseo SDK $version ($pkgs)"
  # shellcheck disable=SC2046
  npm install --no-save --no-audit --no-fund $(for p in $pkgs; do echo "$p@$version"; done)
  echo "PASEO_RESOLVED_VERSION=$version" >> "${GITHUB_ENV:-/dev/null}"
fi

has_script() { node -e "process.exit(require('./package.json').scripts?.['$1'] ? 0 : 1)"; }

has_script typecheck && npm run typecheck
has_script lint && npm run lint
npm test
