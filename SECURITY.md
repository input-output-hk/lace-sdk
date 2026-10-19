# Security policy

## Reporting a vulnerability

**Please do not open a public GitHub issue for a security vulnerability.**

Report suspected vulnerabilities privately via one of:

- **GitHub private vulnerability reporting**:
  [Report a vulnerability](https://github.com/input-output-hk/lace-sdk/security/advisories/new)
- **Email**: `security@iohk.io`

Please include:

- A description of the vulnerability and its potential impact
- Steps to reproduce, or a proof-of-concept
- The affected version(s) (release tag(s) if known)
- Any mitigations you're aware of

We aim to acknowledge reports within **three business days**, and we keep
you informed of the triage and remediation timeline.

## Scope

In-scope targets:

- The Lace SDK packages: `@laceio/sdk`, `@laceio/cardano`, `@laceio/cardano-ledger` and `@laceio/cardano-trezor` on
  npm, and their `@input-output-hk/lace-sdk` and `@input-output-hk/lace-cardano*` copies on GitHub Packages
- The source code published in this repository
- The SDK's developer site, at <https://sdk.lace.io/>

Out of scope:

- Third-party services the SDK connects to (report to the service directly)
- Denial-of-service attacks against Input Output infrastructure
- Social engineering of Input Output staff

## Audits

- **Cardano key derivation, November 2023.** A review of the BIP32-Ed25519 key
  derivation in `@laceio/cardano/crypto`, with its findings addressed:
  [what it covered](packages/lib/cardano-crypto/AUDIT.md) and
  [the report](packages/lib/cardano-crypto/audit_202311.pdf).

## Disclosure

We prefer coordinated disclosure. When a fix is released, we publish an
advisory through GitHub Security Advisories and credit the reporter (unless
anonymity is requested).
