# Agent guide

## Project

`sts` is a TypeScript CLI for Oracle Simphony STS Gen2, distributed as
`@muneris/sts-cli`. Node.js 22+; Windows, macOS and Linux. This is a REST client,
not a UI automation project. No legacy .NET code is part of this repository.

## Workflow

```sh
npm ci
npm test
npm run test:package
node bin/sts.js --help
```

- Keep changes focused. Update help, docs and tests together.
- Do not commit, push, create releases or publish without explicit authorization.
- Do not delegate work or create extra panes/tabs unless requested.
- Read CONTRIBUTING.md and docs/DEVELOPMENT.md for architecture and conventions.
- Ignore generated dist/, node_modules/ and local agent metadata.

## Core contracts

1. Auth: Oracle authorization-code + PKCE S256; explicit refresh; always persist
   rotated refresh tokens. Preserve significant client-ID characters.
2. Requests: explicit noun/verb commands, flags and structured JSON. Never guess
   location, RVC, employee, item or tender. Unknown request fields survive unless
   documented as CLI-owned overrides.
3. Responses: STS response bytes pass unchanged to stdout, including errors.
   No parsing, wrapping, redaction, pretty-printing or added newline. HTTP
   compression decoding is transport processing, not JSON interpretation.

Auth responses require internal parsing to persist tokens. Local commands use
src/output.ts; check example prints editable JSON directly. Diagnostics and local
errors go to stderr. Help/version flags are human-readable exceptions.

Exit codes: 0 success, 1 unexpected local failure, 6 usage, 7 not configured,
8 no tokens, 9 auth failure, 10 network failure, 11 API non-success, 12 state errors.

## Safety

- Offline tests use synthetic local mocks, never live tenant fixtures.
- Real credentials, tokens, customer data and API dumps must never enter source
  control, tests, docs, npm packages or public issue reports.
- Passwords are never saved. Tokens use private per-user state or STS_HOME.
- Respect the exact locations and operations authorized for live testing.
  Organization-wide discovery is not a location-scoped test.
- New/add/delete are destructive live operations. Calculator is non-persisting.
  Do not run a live write without approval and a clear target/body.
- Never automatically retry writes, refresh tokens or follow redirects.
- Idempotency requires both a stable header.idempotencyId and
  Simphony-Features: detect-duplicate-request; --idempotency-id is the opt-in.
- Charged tips set chargedTipTotal without changing tender.total. The caller
  verifies business outcomes; HTTP 200 alone is not proof a tip was applied.
- Every STS call needs Bearer authorization and Accept: application/json.
- Preserve path, query and Simphony-header addressing conventions.
- --local-sts-ip is per-call only; TLS bypass never applies to cloud/IDM.
- Corrupt state must be reported, not silently reset. Lock auth mutations and
  persist rotated tokens atomically. Other clients may not honor the lock.

## Documentation and packaging

README.md is the npm/GitHub entry point; docs/ contains detailed guides. Keep
blast-radius labels and worked examples in --help. Use placeholders rather than
real tenant identities. Write UTF-8 with LF endings.

Inspect the package allowlist and installed shim before reporting packaging
changes complete. Do not claim native-platform or live-operation validation
based solely on mocks or cross-platform CI configuration.

Oracle reference:
https://docs.oracle.com/en/industries/food-beverage/simphony/omsstsg2api/
