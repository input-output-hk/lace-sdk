#!/usr/bin/env bash
# Builds @laceio/cardano-ledger into dist/ and checks the result the way a consumer
# meets it: installed on its own with its declared dependencies, loaded through
# import and require(), and type-checked under each module resolution.
set -euo pipefail
cd "$(dirname "$0")/.."

npx tsdown
node test/check-package.mjs
