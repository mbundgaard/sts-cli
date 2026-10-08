# Changelog

Notable changes are documented here. Versions follow [Semantic Versioning](https://semver.org/).

## 0.5.0 - 2026-10-08

- Automatically check npm after successful non-quiet STS API calls, at most once
  per 24 hours with a 1-second network timeout. Notify on stderr only when newer;
  preserve API stdout and exit codes. Failures stay silent, no updates install
  automatically, and help/local/auth/dry-run commands never trigger the check.
  Keep the schedule separate from credentials; explicit `version --check` bypasses it.

- Add independent company profiles keyed by derived company code and lowercase IDM
  hostname, with exact-key list/status/select/delete commands and safe legacy migration.
  Login saves/selects on success; failed login preserves profiles. Duplicate same-user
  logins report stored token status without another authentication request.
- Prepare login configuration without clearing active tokens. Selection discards
  unfinished configuration; logout clears only active-company tokens. Deleting the
  active company clears selection rather than silently selecting another profile.
- Before STS API commands, renew all due unexpired profiles: successful login/refresh
  schedules +24 hours, failed renewal +1 hour while retaining valid tokens. Remove
  expired token sets without refresh. Manual refresh checks all profiles now; help,
  local commands and dry-runs stay offline. No daemon or STS retry.
- Pin company identity per operation, recheck schedules under lock, and preserve
  atomic rotated-token recovery separately from Oracle backoff. Add offline coverage
  for migration, duplicate login, profile isolation, schedules, expiry and concurrency.

- Centralize automatic verbatim response delivery for all STS reads, calculator and
  check writes. Above 16 KiB or 500 decoded lines, stream the complete body to a
  protected retained file and return a compact JSON reference. Smaller bodies stay
  unchanged on stdout. No mode flags, agent detection or truncation.
- Preserve API error exit codes, TLS restrictions/diagnostics, connection-status
  headers and write-uncertainty warnings. Auth, feedback and updates remain separate.
- Update agent/script guidance: large stdout responses now become file receipts,
  including when redirected. Completed files remain until explicitly deleted.
- Add large plain/compressed response, hash, boundary, private-permission and failure
  regression tests. No retries or live POS writes are introduced.
- Preserve rotated credentials when Oracle omits usable expiry metadata; report
  unknown expiry instead of guessing a lifetime. Actual expiry uses Oracle's
  returned lifetime, not an assumed fixed number of days.

### Compatibility and validation

- Scripts must handle compact file-reference JSON when a response exceeds either
  inline limit, even with stdout redirected. The referenced body remains verbatim.
- `auth refresh` now checks all saved profiles and reports per-company outcomes.
  `auth config` prepares the next login rather than clearing active tokens.
  State mutations persist schema version 2; older CLI versions cannot read it.
  Keep protected backups before upgrading, but never refresh independent copies
  of the same token set.
- Offline regression coverage includes company migration/isolation, expiry,
  renewal backoff, token persistence and response-delivery failures.
- Authorized live read-only checks verified login for a second company, preservation
  of the first profile, scheduled renewal of an inactive company, sequential
  property listing after company selection, and large-response file delivery.
  No POS writes were performed for this validation.

## 0.4.1 - 2026-10-06

- Fix fresh login by preserving OAuth cookies returned by Oracle's authorize
  endpoint. Overwriting them with encoded values could cause sign-in HTTP 400,
  including when the client ID contains Base64 padding. Saved-token refresh was
  unaffected. Add regression coverage for server-supplied cookies and 303 responses.

## 0.4.0 - 2026-10-06

- Add provider-owned catalog export and synchronization: STS selects published
  releases, documentation tabs (Overview, Commands, Authentication, Changelog),
  installation actions and explicitly reviewed optional screenshots. MunerisTools
  only transports and renders the generic provider contract.

- Remove `--org`. Derive organization exclusively from the Base64 client ID's
  `<organization>.<UUID>` format, including saved/imported state; preserve the
  original client ID unchanged and reject unrecognized formats.

- Remove application configuration via shell variables. Use `--password` and
  feedback URL flags or saved configuration instead. State always uses the fixed
  per-user application-data directory, with no directory override.
- Describe password handling as "used for login only"; do not infer an expired,
  one-time, or mandatory-change password from a generic HTTP 401.

- Add explicit, advisory `sts version --check` against npm, with SemVer comparison,
  bounded timeout and a version-pinned update suggestion; never auto-install.
- Surface support@muneris.dk in README/help and agent guidance.
- Clarify normal `--password` login support and cross-session token reuse for agents;
  the password is used during login, not persisted or required for refresh.

- Enable local feedback reminders by default for new profiles, preserving existing
  saved preferences. Start the timer on the first successful STS call or explicit
  enabling; feedback submission still requires user approval.
- Remove the migration guide and related legacy migration messaging; retain saved-state import.

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
