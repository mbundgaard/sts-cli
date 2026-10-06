# Changelog

Notable changes are documented here. Versions follow [Semantic Versioning](https://semver.org/).

## 0.3.0 - 2026-10-06

- Add `feedback` commands for approved messages/1-5 ratings, local previews,
  delivery history/retry/discard, configurable service URL (default
  `https://feedback.muneris.cloud/`) and liveness checks.
  No STS credentials/data collection, automatic sends, redirects or retries.
- Add opt-in local reminders after 7 days or 25 recorded successful STS calls,
  with a 30-day post-question cooldown, snooze/disable, and agent guidance for
  optional sanitized reports of suspected bugs or recurring confusion.
- Persist feedback before POST, block accidental identical/concurrent submissions,
  and retain failed content/IDs; explicit retries warn about server-side duplicates.

- Retain complete synced state recovery files after a failed replacement, with
  explicit recovery instructions so rotated refresh tokens are not discarded.
- Preserve request-body numeric precision in outgoing requests and dry-run previews.
- Skip decompression for bodyless HEAD, 204 and 304 responses without weakening
  validation of encoded GET bodies.
- Clarify property-local pickup timestamps, business-level tip verification and
  a scoped first-user pilot checklist.

- **Breaking:** replace `--local-sts-ip` with an explicit per-call `--sts-url`.
  Remove local/cloud routing and implicit port 5443; retain caller-supplied ports
  and base paths. Use the saved URL when no override is supplied.
- Add a separate `--insecure` opt-in for trusted HTTPS STS endpoints, refused for
  known Oracle cloud domains and the configured IDM host. No automatic TLS bypass.
- Document endpoint selection and TLS behavior in every API command's help.
- Certificate-validation failures explain certificate/CA repair first and mention
  `--insecure` only for eligible endpoints, requiring explicit user confirmation.
  Other connection failures do not suggest bypass; no automatic retry or downgrade.

- Add a GitHub release-triggered npm trusted-publishing workflow with OIDC/provenance.
- Validate all supported OS/Node combinations before release, require matching version
  tags and lockfile versions, and reject already-published versions.

## 0.2.0 - 2026-10-05

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
