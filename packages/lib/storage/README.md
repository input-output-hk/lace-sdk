# @lace-lib/storage

The storage backends the storage modules and the SDK's Midnight worker build on, one subpath each, so that an app
which loads one never bundles the other:

- `@lace-lib/storage/in-memory`: `inMemoryStorageDependencies`, the document, key-value and collection store
  factories over process memory. `@lace-module/storage-in-memory` provides them to its side effects, and the SDK's
  Midnight worker keeps checkpoints in the collection store when a client asks for `storage: 'memory'`.
- `@lace-lib/storage/indexeddb`: `createIndexedDbStorageDependencies({ logger })`, the same factories over the
  `@lace-contract/storage` stores and one IndexedDB adapter, and `createDocumentStorage`, which the apps' bootstrap
  reaches through `@lace-module/storage-web-indexeddb`'s `loadCreateDocumentStorage` before any module loads. The
  SDK's Midnight worker keeps checkpoints in the collection store when a client asks for `storage: 'indexeddb'`.

Why a library: a module's store initializer is a module internal, not a library (ADR 14), and the worker used to run
the two storage modules' initializers with a fabricated runtime to reach their factories (#3056). ADR 22 is the
precedent for a library where the module system is not the vehicle.

One adapter: the IndexedDB adapter opens the one database (`lace-storage`, object store `key-value`) that page
mode's `m.storageWebIndexeddb` and Worker mode's `storage: 'indexeddb'` share, so an engine started in either mode
resumes from the same checkpoint (ADR 72). Do not copy it.

Not here, by design: `@lace-module/storage-extension` and `@lace-module/storage-react-native-async` keep their own
adapters over their platforms' storage APIs and their own bootstrap loaders; #3056 leaves them as they are.

The in-memory collection store is a second implementation of `CollectionStorage` with no conformance test against
`CollectionStore`; rebuilding it over the contract's store is LW-15268.
