// esbuild alias target for Node built-ins referenced only on never-taken
// Node-only code paths of bundled dependencies (libsodium's `require('crypto')`
// randomness fallback; the browser path uses WebCrypto). Resolving them here
// keeps the bundle browser-only without shipping a fake implementation.
module.exports = {};
