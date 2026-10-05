# Changelog

Notable changes are documented here. Versions follow [Semantic Versioning](https://semver.org/).

## Unreleased — 0.2.0 candidate

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

Offline tests and local Windows package installation are verified. Live token refresh,
location-scoped reads and calculator requests have been exercised. Fresh Oracle login
was tested against mocks; live posting, duplicate replay, autofire, and native macOS/Linux
execution still need validation. This candidate has not been published by this cleanup.
