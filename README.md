# Lace SDK

A TypeScript SDK for dApps: self-custodial accounts,
signing, chain access and wallet modules on a headless wallet engine.

- **Packages** on npm:
  - [`@laceio/sdk`](https://www.npmjs.com/package/@laceio/sdk): accounts,
    signing, chain access and wallet modules on the wallet engine
  - [`@laceio/cardano`](https://www.npmjs.com/package/@laceio/cardano): the
    Cardano domain layer `@laceio/sdk` builds on, which installs on its own
  - [`@laceio/cardano-ledger`](https://www.npmjs.com/package/@laceio/cardano-ledger)
    and [`@laceio/cardano-trezor`](https://www.npmjs.com/package/@laceio/cardano-trezor):
    Cardano signing on Ledger and Trezor devices
- **Documentation**: [the developer site](https://sdk.lace.io/)
- **Releases and their notes**: [GitHub releases](https://github.com/input-output-hk/lace-sdk/releases)

```bash
npm install @laceio/sdk
```

This repository is the **published source** of these packages. It is
generated from Lace's development repository on each release, and holds the
packages and the Lace packages they build from.

## Reporting security issues

For suspected vulnerabilities, follow the process in
[SECURITY.md](./SECURITY.md). Do not open a public issue for a security
matter.

## Releases you can verify

Each release is built and published by this repository's own workflow, from
the commit its release tag points at:

- **npm provenance** links each version to that commit and workflow:
  `npm audit signatures` verifies an installed version.
- **A GitHub attestation** covers every tarball a release builds, before any
  publishes: `@laceio/sdk` for npm and `@input-output-hk/lace-sdk` for GitHub
  Packages, and likewise for each Cardano package a release publishes
  (`@input-output-hk/lace-cardano` and so on).
- **Builds are reproducible**: the same source produces the same bytes, so a
  release can be rebuilt from this repository and compared.
- **Every release is checked before it publishes**: a release that breaks an
  export without the required version bump and prior deprecation stops.
  [Releases and compatibility](https://sdk.lace.io/docs/releases/) describes
  the guarantees in full.

## Building from source

The repository installs from public registries only.

```bash
git checkout lace-sdk@0.1.0     # the release to build
npm ci
npm run build           # @laceio/sdk
npm run build:cardano   # the Cardano packages
npm test
```

Each release publishes every package on its channel, each at its own
version: a stable release on `latest`, a canary on `canary`.

## Repository layout

- [`apps/lace-sdk`](./apps/lace-sdk) — `@laceio/sdk`; its
  [README](./apps/lace-sdk/README.md) documents the API.
- [`apps/lace-cardano`](./apps/lace-cardano),
  [`apps/lace-cardano-ledger`](./apps/lace-cardano-ledger) and
  [`apps/lace-cardano-trezor`](./apps/lace-cardano-trezor) — the Cardano
  packages.
- [`packages/`](./packages) — the Lace contracts, libraries and
  modules the packages build from, as Lace develops them.

## Filing issues and contributing

Bug reports and feature requests are welcome: use the
[issue templates](https://github.com/input-output-hk/lace-sdk/issues/new/choose).
Questions and ideas go to
[Discussions](https://github.com/input-output-hk/lace-sdk/discussions).
Because this repository is generated, pull requests opened from forks are
closed automatically with a pointer to [CONTRIBUTING.md](./CONTRIBUTING.md),
which describes how a change reaches a release.

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](./LICENSE).
