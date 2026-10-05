# Changelog

Notable changes are documented here. Versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

- Add a GitHub release-triggered npm trusted-publishing workflow with OIDC/provenance.
- Validate all supported OS/Node combinations before release, require matching version
  tags and lockfile versions, and reject already-published versions.

## 0.2.0 — 2026-10-05

### Added

- Cross-platform TypeScript implementation, exposed as `sts` through npm.
- Oracle authorization-code + PKCE login and explicit token refresh.
- Per-user state, atomic saves, auth mutation locks, and compatible state import.
- Fifteen read endpoint definitions, plus check and connection commands.
- Explicit request construction from flags and file/inline/stdin JSON.
- Minimal request examples and network-free `--dry-run` previews.
- Stable idempotency opt-in, charged-tip fields and pickup/autofire time overrides.
- Mock-server, request-construction, and installed-package tests.
- MIT license, contribution/security guidance, and GitHub validation workflow.

### Changed

- STS response bodies are now emitted unchanged rather than inside a JSON envelope.
- API HTTP errors preserve the original body on stdout; diagnostics use stderr.
- The caller is responsible for business-result verification, including charged tips.
- Node.js 22+ replaces the .NET/native executable distribution.

### Removed

- Legacy .NET sources and native-wrapper experiment from the public project tree.
- Azure release scripts, duplicated tool-site content, and historical internal plans.
- Tenant-specific artifacts and private references from the public project tree.

### Validation status

All 44 tests and installed-package checks pass in GitHub CI on Windows, macOS and
Linux with Node 22 and 24. Live token refresh, location-scoped reads and calculator
requests have been exercised. Fresh Oracle login was tested against mocks; live posting,
duplicate replay and autofire still need validation.
