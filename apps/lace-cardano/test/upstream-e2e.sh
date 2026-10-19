#!/usr/bin/env bash
# Runs the Cardano JS SDK's own end-to-end wallet suite against the ported
# sources: a checkout of cardano-js-sdk at the commit the port was taken from,
# with the seven published packages' sources replaced by the workspace's, built
# with upstream's toolchain and run on upstream's local test network.
#
# This is a proof, not a gate: it needs Docker, several gigabytes of disk and
# about an hour, so it has its own Nx target (`lace-cardano:upstream-e2e`) and
# nothing runs it on its own. Run it when the ported packages change in a way
# the unit suites cannot judge, and read the result as "the wallet upstream
# built on these packages still behaves on a chain".
#
#   npx nx run lace-cardano:upstream-e2e
#   UPSTREAM_PROOF_DIR=/path npx nx run lace-cardano:upstream-e2e   # reuse a checkout
#
# A checkout that already exists is reused: download and install are skipped
# and only the drop-in, the build and the suites run again.
set -euo pipefail

# The commit the port was taken from; the tags of the ported packages resolve to it.
UPSTREAM_COMMIT=48019e49
UPSTREAM_REPO=input-output-hk/cardano-js-sdk
PUBLISHED_PACKAGES=(core crypto util key-management input-selection tx-construction dapp-connector)
ALL_PACKAGES=("${PUBLISHED_PACKAGES[@]}" util-rxjs util-dev hardware-ledger hardware-trezor)

workspace=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
proof=${UPSTREAM_PROOF_DIR:-${TMPDIR:-/tmp}/lace-cardano-upstream-proof}
upstream=$proof/upstream
log() { printf '\n== %s\n' "$*"; }

for tool in gh yarn docker node; do
  command -v "$tool" > /dev/null || { echo "$tool is required" >&2; exit 1; }
done
docker info > /dev/null 2>&1 || { echo "Docker is not running" >&2; exit 1; }

if [ ! -f "$upstream/package.json" ]; then
  log "Downloading $UPSTREAM_REPO at $UPSTREAM_COMMIT into $upstream"
  mkdir -p "$upstream"
  gh api "repos/$UPSTREAM_REPO/tarball/$UPSTREAM_COMMIT" > "$proof/upstream.tar.gz"
  tar -xzf "$proof/upstream.tar.gz" -C "$upstream" --strip-components=1
  rm "$proof/upstream.tar.gz"
  log "Installing upstream dependencies"
  # As upstream's own CI installs: the optional native modules (node-hid,
  # chacha-native, tiny-secp256k1) are never built, and nothing here needs them.
  (cd "$upstream" && yarn install --immutable --inline-builds --mode=skip-build)
else
  log "Reusing the checkout at $upstream"
fi

# Where the workspace keeps each upstream package's sources: upstream's util is
# @lace-lib/util's common subpath, every other package @lace-lib/cardano-<name>.
workspace_sources() {
  if [ "$1" = util ]; then
    echo "$workspace/packages/lib/util/src/common"
  else
    echo "$workspace/packages/lib/cardano-$1/src"
  fi
}

log "Replacing the published packages' sources with the workspace's"
for name in "${PUBLISHED_PACKAGES[@]}"; do
  src=$upstream/packages/$name/src
  cp "$src/tsconfig.json" "$proof/tsconfig-$name.json"
  rm -rf "$src"
  mkdir -p "$src"
  cp -R "$(workspace_sources "$name")/." "$src/"
  cp "$proof/tsconfig-$name.json" "$src/tsconfig.json"
  # Upstream compiles with TypeScript 4.8, which has no `export type *`.
  grep -rl 'export type \* from' "$src" | while read -r file; do
    sed -i.bak 's/^export type \* from/export * from/' "$file" && rm "$file.bak"
  done
  echo "  $name: $(find "$src" -name '*.ts' | wc -l | tr -d ' ') files"
done
# The ported imports resolve to upstream's own packages.
mkdir -p "$upstream/node_modules/@lace-lib/util"
for name in "${ALL_PACKAGES[@]}"; do
  [ "$name" = util ] && continue
  ln -sfn "../../packages/$name" "$upstream/node_modules/@lace-lib/cardano-$name"
done
ln -sfn "../../../packages/util" "$upstream/node_modules/@lace-lib/util/common"
# The CML key strategy is not ported; the suite runs on the sodium one.
factories=$upstream/packages/e2e/src/factories.ts
sed -i.bak "/^import \* as CML from '@dcspark\/cardano-multiplatform-lib-nodejs';$/d; /bip32Ed25519Factory.register('CML'/d" "$factories"
rm "$factories.bak"
# The CIP-30 suite decodes signatures with the message-signing library it still
# depends on, and named one COSE label through key-management's removed WASM
# wrapper; it names it through the library instead. Its assertions are unchanged.
cip30=$upstream/packages/e2e/test/wallet_epoch_0/PersonalWallet/cip30WalletApi.test.ts
sed -i.bak \
  -e "s/^import { Bip32Account, KeyRole, cip8 } from '@cardano-sdk\/key-management';/import { Bip32Account, KeyRole } from '@cardano-sdk\/key-management';/" \
  -e "s/^import { COSEKey, COSESign1 } from '@emurgo\/cardano-message-signing-nodejs';/import { BigNum, COSEKey, COSESign1, Int, Label } from '@emurgo\/cardano-message-signing-nodejs';/" \
  -e "s/cip8\.CoseLabel\.x/Label.new_int(Int.new_negative(BigNum.from_str('2')))/" \
  "$cip30"
rm "$cip30.bak"

# Upstream's compose overrides for Apple silicon name images that are no longer
# published; the official amd64 images run under Docker Desktop's emulation.
for override in arm64 aarch64; do
  printf '# The arm64 images upstream pointed at are gone; the amd64 ones run emulated.\n{}\n' > "$upstream/compose/$override.yml"
done

# The suite reads its configuration from the environment; upstream's workflow
# sets these for its local network, and the suite's dotenv setup reads them
# from this file.
if [ ! -f "$upstream/packages/e2e/.env" ]; then
  cat > "$upstream/packages/e2e/.env" << 'EOF'
DB_SYNC_CONNECTION_STRING='postgresql://postgres:doNoUseThisSecret!@localhost:5435/cexplorer'
KEY_MANAGEMENT_PROVIDER='inMemory'
KEY_MANAGEMENT_PARAMS='{"bip32Ed25519": "Sodium", "accountIndex": 0, "chainId":{"networkId": 0, "networkMagic": 888}, "passphrase":"some_passphrase","mnemonic":"vacant violin soft weird deliver render brief always monitor general maid smart jelly core drastic erode echo there clump dizzy card filter option defense"}'
OGMIOS_URL='ws://localhost:1340/'
STAKE_POOL_CONNECTION_STRING='postgresql://postgres:doNoUseThisSecret!@localhost:5435/stake_pool'
STAKE_POOL_TEST_CONNECTION_STRING='postgresql://postgres:doNoUseThisSecret!@localhost:5435/stake_pool_test'
TEST_CLIENT_ASSET_PROVIDER='http'
TEST_CLIENT_ASSET_PROVIDER_PARAMS='{"baseUrl":"http://localhost:4014/"}'
TEST_CLIENT_CHAIN_HISTORY_PROVIDER='ws'
TEST_CLIENT_CHAIN_HISTORY_PROVIDER_PARAMS='{"baseUrl":"http://localhost:4000/"}'
TEST_CLIENT_DREP_PROVIDER='blockfrost'
TEST_CLIENT_DREP_PROVIDER_PARAMS='{"baseUrl":"http://localhost:3015"}'
TEST_CLIENT_HANDLE_PROVIDER='http'
TEST_CLIENT_HANDLE_PROVIDER_PARAMS='{"baseUrl":"http://localhost:4011/"}'
TEST_CLIENT_NETWORK_INFO_PROVIDER='ws'
TEST_CLIENT_NETWORK_INFO_PROVIDER_PARAMS='{"baseUrl":"http://localhost:4000/"}'
TEST_CLIENT_REWARDS_PROVIDER='http'
TEST_CLIENT_REWARDS_PROVIDER_PARAMS='{"baseUrl":"http://localhost:4000/"}'
TEST_CLIENT_TX_SUBMIT_PROVIDER='http'
TEST_CLIENT_TX_SUBMIT_PROVIDER_PARAMS='{"baseUrl":"http://localhost:4000/"}'
TEST_CLIENT_UTXO_PROVIDER='ws'
TEST_CLIENT_UTXO_PROVIDER_PARAMS='{"baseUrl":"http://localhost:4000/"}'
TEST_CLIENT_STAKE_POOL_PROVIDER='http'
TEST_CLIENT_STAKE_POOL_PROVIDER_PARAMS='{"baseUrl":"http://localhost:4000/"}'
TEST_CLIENT_REWARD_ACCOUNT_INFO_PROVIDER='blockfrost'
TEST_CLIENT_REWARD_ACCOUNT_INFO_PROVIDER_PARAMS='{"baseUrl":"http://localhost:3015"}'
WS_PROVIDER_URL='http://localhost:4100/ws'
EOF
fi

log "Building upstream with the ported sources"
(cd "$upstream" && yarn build)

cleanup() {
  log "Stopping the local network"
  (cd "$upstream" && yarn workspace @cardano-sdk/e2e local-network:down) || true
}
trap cleanup EXIT

log "Starting the local test network"
(cd "$upstream" && yarn workspace @cardano-sdk/e2e local-network:up > "$proof/local-network.log" 2>&1) &
network=$!
# The network reports readiness through a file in its bootstrap container;
# until then, a dead compose process means it will never come. A network that
# stays up without becoming ready (funding that never lands, for one) fails at
# the deadline, upstream's own 20 minutes, rather than at the job's timeout.
network_deadline=$((SECONDS + 1200))
until docker exec -i local-network-e2e-local-testnet-1 test -e /root/network-files/run/done 2> /dev/null; do
  if ! kill -0 "$network" 2> /dev/null; then
    echo "The local network stopped before it was ready; see $proof/local-network.log:" >&2
    tail -n 20 "$proof/local-network.log" >&2
    exit 1
  fi
  if [ "$SECONDS" -ge "$network_deadline" ]; then
    echo "The local network was not ready within 20 minutes; see $proof/local-network.log:" >&2
    tail -n 20 "$proof/local-network.log" >&2
    exit 1
  fi
  sleep 10
done
echo "Local network init completed"

# The suite submits through the relay (the cardano-node service), which starts
# only after the marker above. The block producers take no transactions from a
# peer for 60 s after it connects (ouroboros-network's tx-submission init
# delay), and the suite's first transaction has 36 s to confirm. In CI the
# producers received the first transaction exactly 60 s after the relay
# started, so the suite waits until the relay has been up for that long plus
# a margin, timed from the container's start so a relay restart is covered.
relay=local-network-e2e-cardano-node-1
relay_warm_up=70
# The relay starts within seconds of the marker, so a wait this long means it
# never came up; fail with its state rather than hold the job to its timeout.
relay_deadline=$((SECONDS + 600))
relay_uptime() {
  local started
  started=$(docker inspect -f '{{if .State.Running}}{{.State.StartedAt}}{{end}}' "$relay" 2> /dev/null) || return 1
  [ -n "$started" ] || return 1
  # stdout.write, not console.log: CI forces colour, and console.log would wrap
  # the number in escape codes that the integer test below rejects.
  node -e 'process.stdout.write(String(Math.floor((Date.now() - Date.parse(process.argv[1])) / 1000)))' "$started"
}
until relay_up=$(relay_uptime) && [ "$relay_up" -ge "$relay_warm_up" ]; do
  if ! kill -0 "$network" 2> /dev/null; then
    echo "The local network stopped before its relay forwarded transactions; see $proof/local-network.log:" >&2
    tail -n 20 "$proof/local-network.log" >&2
    exit 1
  fi
  if [ "$SECONDS" -ge "$relay_deadline" ]; then
    echo "The relay ($relay) did not stay up for ${relay_warm_up}s within 10 minutes; its state:" >&2
    docker inspect -f '{{.State.Status}} since {{.State.StartedAt}}, restarts {{.RestartCount}}' "$relay" >&2 || echo "no container named $relay" >&2
    docker ps -a --format '{{.Names}}\t{{.Status}}' >&2
    exit 1
  fi
  sleep 5
done
echo "Relay up for ${relay_up}s; transactions reach the block producers"

log "Wallet suite at epoch 0"
(cd "$upstream" && yarn workspace @cardano-sdk/e2e test:wallet:epoch0)

log "Waiting for epoch 3"
# Upstream's wait-for-network-epoch-3 exits 0 when it times out, and when its
# query fails before db-sync has created its tables, so it cannot hold the
# suite back. The epoch is read here instead, with upstream's 20-minute wait
# and the client upstream's e2e package already installs.
db_sync_epoch() {
  (cd "$upstream/packages/e2e" && node -e '
    const { Client } = require("pg");
    const client = new Client({ connectionString: process.argv[1] });
    client.connect()
      .then(() => client.query("SELECT max(no) AS no FROM epoch"))
      .then(({ rows }) => { process.stdout.write(String(rows[0].no ?? -1)); return client.end(); })
      .catch(() => process.exit(1));
  ' "postgresql://postgres:doNoUseThisSecret!@localhost:5435/cexplorer") 2> /dev/null
}
epoch_deadline=$((SECONDS + 1200))
until epoch=$(db_sync_epoch) && [ "$epoch" -ge 3 ]; do
  if [ "$SECONDS" -ge "$epoch_deadline" ]; then
    echo "db-sync had not reached epoch 3 within 20 minutes (epoch: ${epoch:-unreadable})" >&2
    exit 1
  fi
  sleep 10
done
echo "db-sync is at epoch $epoch"

log "Wallet suite at epoch 3"
(cd "$upstream" && yarn workspace @cardano-sdk/e2e test:wallet:epoch3)

log "Upstream's wallet suite passes on the ported sources at $UPSTREAM_COMMIT"
