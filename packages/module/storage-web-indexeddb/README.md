# @lace-module/storage-web-indexeddb

Data storage system for web, backed by raw IndexedDB (one database, one
key-value object store). Used by `lace-extension-carbon` and `lace-extension-guest`.

Provides the storage contract's dependencies from `@lace-lib/storage/indexeddb`, which holds the IndexedDB adapter
and the store factories over the `@lace-contract/storage` store classes. `loadCreateDocumentStorage` loads the
library's document store factory for the apps' bootstrap, which reads the persisted feature flags before any module
loads.
