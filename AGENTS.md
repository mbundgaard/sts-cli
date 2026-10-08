# Agent guide

## Project

`sts` is a TypeScript CLI for Oracle Simphony STS Gen2, distributed as
`@muneris/sts-cli`. Node.js 22+; Windows, macOS and Linux. This is a REST client,
not a UI automation project.

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

1. Auth: Oracle authorization-code + PKCE S256; company-scoped scheduled renewal
   before API calls; always persist rotated refresh tokens. Preserve significant client-ID characters.
2. Requests: explicit noun/verb commands, flags and structured JSON. Never guess
   location, RVC, employee, item or tender. Unknown request fields survive unless
   documented as CLI-owned overrides.
3. Responses: STS data remains verbatim, including errors. Up to 16,384 decoded
   bytes AND 500 lines goes unchanged to stdout; above either limit, save the complete
   body privately and emit a compact JSON file reference. All STS calls use
   src/responses.ts. No mode flags, agent detection, body parsing, redaction,
   pretty-printing, truncation or added body newline. HTTP compression decoding is
   transport processing. Auth/feedback/update responses stay separate. Storage or
   delivery failures never justify retrying a POS write; retain uncertainty guidance.

Auth responses require internal parsing to persist tokens. Local commands use
src/output.ts; check example prints editable JSON directly. Diagnostics and local
errors go to stderr. Help/version flags are human-readable exceptions.

Exit codes: 0 success, 1 unexpected local failure, 6 usage, 7 not configured,
8 no tokens, 9 auth failure, 10 network failure, 11 API non-success, 12 state errors.

## Safety

- Offline tests use synthetic local mocks, never live tenant fixtures.
- Real credentials, tokens, customer data and API dumps must never enter source
  control, tests, docs, npm packages or public issue reports.
- Passwords are never saved. Tokens use the fixed private per-user application-data directory.
- Respect the exact locations and operations authorized for live testing.
  Organization-wide discovery is not a location-scoped test.
- New/add/delete are destructive live operations. Calculator is non-persisting.
  Do not run a live write without approval and a clear target/body.
- Never retry STS requests or follow redirects. Before API calls, renew all due
  company profiles: success +24h, failure +1h. Remove expired token sets without
  refreshing; preserve configuration. No network for help/local/dry-run commands.
- Pin the active company key per operation; never mix endpoint and token profiles.
  Company select/delete require exact keys. Failed login preserves saved profiles;
  successful login stores and selects its key. Confirm deletion intent.
- Idempotency requires both a stable header.idempotencyId and
  Simphony-Features: detect-duplicate-request; --idempotency-id is the opt-in.
- Charged tips set chargedTipTotal without changing tender.total. The caller
  verifies business outcomes; HTTP 200 alone is not proof a tip was applied.
- Every STS call needs Bearer authorization and Accept: application/json.
- Preserve path, query and Simphony-header addressing conventions.
- --sts-url overrides the saved URL for one call; never infer scheme or port.
  --insecure is a separate, explicit per-call flag. Obtain explicit user confirmation
  for the endpoint before adding it; never downgrade TLS or retry automatically.
  Reject it for known Oracle cloud/IDM hosts; auth login/refresh always verify HTTPS certificates.
  --local-sts-ip is removed, with no compatibility alias.
- Corrupt state must be reported, not silently reset. Lock auth mutations and
  persist rotated tokens atomically. Other clients may not honor the lock.

## Authentication, updates and support

- Derive organization/company code from the Base64 client ID's `<organization>.<UUID>`
  format. Never ask for a separate company code or override it. Send the original
  client ID unchanged, including padding; reject malformed IDs instead of guessing.

- Start each session with `sts auth status`; saved state is per OS user, not per
  agent session. Windows uses AppData/Roaming/StsCli beneath the user's home;
  macOS uses ~/Library/Application Support/StsCli; Linux uses ~/.config/StsCli.
  There is no directory override. Reuse valid tokens or explicitly refresh them.
  Different OS users or machines do not automatically share this state.
  Do not rerun config/login unnecessarily: configuration prepares the next login
  without changing saved profiles. Duplicate same-user logins report saved tokens.
- If the user supplies credentials and authorizes login, use
  `sts auth login --password "<password>"` as requested. Do not refuse solely
  because a password was supplied. Argument values may be visible to the shell/OS.
  The password is used for login only and is not saved by the CLI. Later sessions
  reuse saved tokens. Do not assume it is expired, one-time, or requires changing
  unless Oracle explicitly reports that; HTTP 401 alone is insufficient evidence.
  Refresh uses saved tokens, not the password. The user can rotate the password
  afterward in Oracle.
  Never echo, log, store or report it.
- Newly granted location access requires a newly issued token after permissions
  have propagated (typically about 20 minutes after adding the location, not a
  guaranteed deadline). An existing token or one issued too early may not reflect the
  grant. Verify only the authorized location; do not diagnose a password problem
  or repeatedly retry login solely from a propagation-related access denial.
- Successful non-quiet STS calls check npm automatically at most once per 24h
  (1-second network timeout), notifying on stderr only when newer. No installs,
  retries, or changes to STS output/exit codes. Local/help/dry-run stay offline.
- Check `sts version --check` once at session start, not on every request. Notify
  the user if newer and get approval before updating. Respect their installation
  method and active work. An unavailable check does not mean up to date and must
  not block other tasks. No updates are installed automatically.
- Direct/private support: support@muneris.dk. Share a version and sanitized
  description, never credentials or unreviewed customer data.

## Optional feedback

- `sts feedback status` is a local JSON command with reminder eligibility and
  agent guidance. Feedback is a separate service, never an STS request: do not
  attach Bearer authorization, cookies, Simphony headers, or STS state.
- Ask before submitting any message/rating. Show a sanitized proposed summary
  and use `feedback submit --dry-run` if useful. Explicit submission is consent
  from the caller; the CLI does not prompt for human confirmation itself.
- Offer suspected CLI bugs or recurring agent mistakes/confusion as optional
  reports even when no scheduled reminder is due. Distinguish verified defects
  from suspicions, POS configuration issues and agent misunderstandings. Do not
  interrupt urgent work, automatically report failures or repeat declined offers.
- Once you ask, use `feedback asked`; respect skip, `feedback snooze`, and
  `feedback config --reminders off`. Reminders default on for new profiles,
  respect existing saved settings, and use only local counts and timestamps. Noninteractive clients check status instead of receiving nags.
- Send only approved text/rating and product metadata. Never include credentials,
  customer data, private tenant identifiers or raw request/response/console dumps.
- POST success is 204 with no JSON body. Health proves liveness, not storage.
  Never retry automatically. `feedback retry <id>` preserves the original body,
  ID and destination, but the server does not deduplicate and may create a new row.
- Test with local synthetic mocks. A production feedback smoke POST creates a
  real row and needs separate approval.

## Documentation and packaging

README.md is the npm/GitHub entry point; docs/ contains detailed guides. Keep
blast-radius labels and worked examples in --help. Use placeholders rather than
real tenant identities. Write UTF-8 with LF endings.

Inspect the package allowlist and installed shim before reporting packaging
changes complete. Do not claim native-platform or live-operation validation
based solely on mocks or cross-platform CI configuration.

Oracle reference:
https://docs.oracle.com/en/industries/food-beverage/simphony/omsstsg2api/
