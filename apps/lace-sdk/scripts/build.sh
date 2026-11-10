#!/usr/bin/env bash
# Builds the SDK's channels (ADR 66) with their checks. With SDK_CHANNEL set,
# only that channel is built, into dist/, as a publish needs. Otherwise both
# are: canary into dist-canary/, for in-repo consumers of canary features, then
# stable into dist/. Each build writes dist/ while its checks run, because the
# checks install the package from it.
set -euo pipefail
cd "$(dirname "$0")/.."

measure_declarations() {
  local phase="$1"
  shift
  if [[ "$OSTYPE" == linux* && -x /usr/bin/time ]]; then
    local format="[sdk-declarations:$SDK_CHANNEL:$phase] peak RSS: %M KiB; elapsed: %e s"
    if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
      # Nx can truncate a large buffered build log before these measurements.
      /usr/bin/time -f "$format" -o >(tee -a "$GITHUB_STEP_SUMMARY" >&2) "$@"
    else
      /usr/bin/time -f "$format" "$@"
    fi
  else
    "$@"
  fi
}

build() {
  export SDK_CHANNEL="$1"
  node test/check-doc-comments.mjs
  npx tsdown
  (
    trap 'rm -rf dist/.dts-work tsconfig.dts-gen.generated.json' EXIT
    node scripts/dts-gen-config.mjs
    # The workspace's TypeScript, whatever tsc PATH holds: run directly,
    # outside Nx and npm, PATH has no node_modules/.bin, and a runner's
    # global tsc can be another major.
    measure_declarations tsc npx tsc -p tsconfig.dts-gen.generated.json
    measure_declarations rollup npx rollup -c rollup.dts.config.mjs
  )
  node test/check-declaration-dependencies.mjs
  node test/check-bundled-licences.mjs
  node test/check-export-surface.mjs
  node test/check-cardano-bundle.mjs
  node test/check-node-load.mjs
  node test/check-cardano-identity.mjs
  node test/check-consumer-types.mjs
}

if [[ -n "${SDK_CHANNEL:-}" ]]; then
  build "$SDK_CHANNEL"
  exit 0
fi

build canary
rm -rf dist-canary
mv dist dist-canary
build stable
