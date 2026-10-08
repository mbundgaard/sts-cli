# Command reference

Run `sts <group> <command> --help` for exact options. Placeholder values below must be replaced. Commands labelled **DESTRUCTIVE** affect the POS; preview the request with `--dry-run` first.

Configuration, tokens and feedback state are shared automatically per OS user.
Windows uses `C:\Users\<user>\AppData\Roaming\StsCli`; see the
[authentication guide](AUTHENTICATION.md#state-storage) for other platforms.
There is no directory override.
The `auth env` command and `auth config --env` select Oracle deployment presets,
not shell configuration.

## Automatic response delivery

All STS calls return verbatim data. Up to **16 KiB and 500 lines** goes directly to
stdout; above either limit, the complete body is saved in a private per-user file
and stdout returns a compact JSON reference with path, URI, size, hash and HTTP status.
There are no output-mode flags or silent truncation. Auth/local/feedback/update
commands keep their separate output behavior. `--quiet` does not hide file references.

Scripts and agents must handle both forms. Redirecting stdout may save a receipt
rather than the API body. Completed files remain until deleted; use local tools to
read/filter selected portions. API errors keep their exit codes. Failed storage does
not undo a POS write and must never prompt an automatic retry. See
[Response delivery](RESPONSES.md) for the full contract and privacy/failure details.

## Local and authentication commands

| Command | Purpose |
|---|---|
| `sts --help` | Discover commands |
| `sts --version` | Plain version string |
| `sts version` | JSON containing npm version and Node/platform information |
| `sts version --check` | Explicit read-only npm update check; advisory, never installs |
| `sts endpoints` | JSON catalog of supported GET endpoints |
| `sts auth env` | Available environment presets |
| `sts auth config` | Show configuration, without changing it |
| `sts auth config --env <env> --username <user> --client-id <id>` | Prepare login configuration; saved companies/tokens remain unchanged |
| `sts auth config --env custom --auth-url <url> --sts-url <url> ...` | Custom deployment |
| `sts auth login` | PKCE login using `--password`; saves/selects the company; duplicates report stored tokens |
| `sts auth refresh` | Renew all unexpired profiles now, bypassing cooldown; persist each rotation |
| `sts auth status` | Local token presence and expiry (default for `sts auth`) |
| `sts auth show` | Effective configuration plus token summary |
| `sts auth restore --file <path> [--force]` | Import existing state without contacting Oracle |
| `sts auth logout` | Clear active-company tokens locally, not server-side revocation |
| `sts company list` | List locally saved companies and token summaries; no Oracle access check |
| `sts company status` | Active-company configuration and token summary |
| `sts company select <exact-key>` | Select saved company and discard unfinished login configuration |
| `sts company delete <exact-key>` | Remove one local profile; deleting active clears selection, not remote revocation |

The organization is always derived from the Base64 client ID (`<organization>.<UUID>`
when decoded), including when loading saved/imported state. There is no organization
override. The original client ID is passed unchanged to Oracle.

Keys are `<companyCode>@<lowercaseAuthHostname>`, excluding scheme, port and path. No bare-code/fuzzy selection: agents list and disambiguate first. Successful login always selects the saved company; failed login does not replace profiles or selection. Same company/hostname/username with stored unexpired tokens skips login. Explicitly select and log out before replacing a same-user configuration/login.

Before STS API calls, all profiles are checked for due renewal. Success sets `refreshAfter` to now +24 hours; failure sets +1 hour and retains still-valid tokens. Known-expired token sets are deleted without refresh, requiring a new login. This runs only on use, not in the background; help/local commands/dry-runs stay offline. Requests pin their company key across renewal; failures for other companies do not block a usable active token. Persistence errors stop before the STS request. No API call is retried. Details: [authentication and state](AUTHENTICATION.md).

Login accepts `--username` to override the saved user. Login/refresh accept `--quiet` and `--timeout <seconds>`. State-changing commands lock and save state; do not run another client against the same token simultaneously.

## Update checks and support

`sts version --check` adds `data.update` to the local version JSON. It contains
`installedVersion`, `latestVersion` when verified, `checkStatus` (`up-to-date`,
`update-available`, `ahead`, or `unavailable`), `updateAvailable`, registry URL and
an explanatory message. When newer, `updateCommand` suggests a version-pinned
`npm install --global @muneris/sts-cli@<version>` command. No command is executed.
Version precedence follows SemVer, including prereleases; build metadata does not
change precedence. Ahead-of-registry installations are not told to downgrade.

The explicit lookup contacts only npm's public `latest` metadata endpoint over
verified HTTPS with a 5-second timeout, no retries, redirects or authentication.
It does not read/save token state or cache results. Network/registry/metadata errors
produce `checkStatus: "unavailable"`, `updateAvailable: null` and exit 0, not a false
up-to-date result. `sts --version` and plain `sts version` remain completely local.

After successful non-quiet STS API calls, an automatic check runs at most once per
24 hours, with a 1-second network timeout. Only a newer version produces a stderr
notice; stdout and the STS exit code stay unchanged. Network/storage failures are
silent and wait until the next daily attempt. No automatic checks run on failed
STS calls, `--quiet`, help, local commands, auth commands or dry-runs. Checks run
after response delivery, not in a daemon, and never install updates.

A separate `update-notice.json` in the per-user state directory stores only the next
attempt timestamp and schema version. A short exclusive lock prevents concurrent
checks; the daily reservation is saved before networking, even if the check fails.
Corrupt cache or lock contention skips the optional check without overwriting state.
A hard termination during reservation can leave `update-notice.json.lock`; inspect
and remove that stale lock only when no CLI command is running. Explicit
`sts version --check` always bypasses this automatic-check schedule.

Agents: check once per session, notify if newer and get approval before updating.
Do not repeatedly check, interrupt active writes, or use a global install command
for an installation managed another way. An unavailable result should not block
other work. Users can also compare versions with `npm view @muneris/sts-cli version`.

Direct support: [support@muneris.dk](mailto:support@muneris.dk). Include a version
and sanitized description, never passwords, tokens or unreviewed customer data.
Sensitive security reports belong in the private channel described in
[SECURITY.md](../SECURITY.md), not ordinary product feedback.

## Read endpoints

All calls require a configured client ID, from which organization addressing is derived.
A usable token is also required unless `--dry-run` is used.

| Command | Required options | Addressing |
|---|---|---|
| `org list` | None | Path |
| `org get` | None | Path |
| `location list` | None | Path |
| `location get` | `--location` | Path |
| `rvc list` | `--location` | Path |
| `rvc get` | `--location --rvc` | Path |
| `tender list` | `--location --rvc` | Query |
| `tax list` | `--location --rvc` | Query |
| `service-charge list` | `--location --rvc` | Query |
| `discount list` | `--location --rvc` | Query |
| `barcode list` | `--location --rvc` | Query |
| `menu list` | `--location --rvc` | Query |
| `menu get` | `--location --rvc` | Headers and menu ID path |
| `menu unavailable` | `--location --rvc` | Query |
| `employee get` | `--location --employee-id` | Query |

Prefix these commands with `sts`. Organization service paths, `OrgShortName`/`LocRef`/`RvcRef` query parameters and `Simphony-*` headers are built automatically. `employee get` uses the documented `EmployeeId` query field, not the check write `--employee` flag.

`location list` and `rvc list` support `--offset` and `--limit`. No automatic pagination or result merging is performed: each invocation returns one response unchanged.

`menu get` defaults its menu ID to `<org>:<loc>:<rvc>`. `--menu-id <id>` overrides it. Ensure an explicit menu ID belongs to the intended target.

## Check reads

```sh
sts check list --location <loc> --rvc <rvc>
sts check get <checkRef> --location <loc> --rvc <rvc>
sts check get <checkRef> --location <loc> --rvc <rvc> --printed
```

List filters: `--include-closed`, `--since-time <date-or-timestamp>`, `--check-number <csv>`, `--employee <ref>`, `--order-type <ref>`, `--table <name>`. A bare date means midnight UTC. Without `--include-closed`, Oracle returns open checks. For historical reads use a narrow time window; a bad historical check can cause the entire endpoint to fail.

## Request examples

```sh
sts check example service-total
sts check example payment
sts check example tender-only
sts check example calculate
sts check example tip
sts check example condiment
```

Output is directly usable as a JSON file **after replacing placeholder IDs**. The default kind is `service-total`. There is no envelope around example JSON. A payment/service-total body's structural shape is the same; the tender lookup determines which type it is. The `tip` example's total already includes its tip.

## Check writes

| Command | Effect |
|---|---|
| `check calculate` | **writes-nothing**: POST calculator |
| `check new` | **DESTRUCTIVE**: POST new check |
| `check add <checkRef>` | **DESTRUCTIVE**: POST new round |
| `check delete <checkRef>` | **DESTRUCTIVE**: DELETE check |

All require `--location <loc> --rvc <rvc>`. All except delete additionally require `--employee <emp> --order-type <type> --body <file|-|inline-json>`.

New/add also accept:

- `--idempotency-id <uuid>`: stable ID (UUID or 32 hex) plus duplicate-detection header. Reuse for retries of one logical write only.
- `--charged-tip <amount>`: requires one tender; writes `chargedTipTotal`, not tender `total`. HTTP 200 does not prove the tip applied. Inspect returned tenders, tips, change and totals; an unsupported tender/configuration may ignore the tip and return change instead.
- `--pickup-time <timestamp>`: writes `header.pickupTime` using **property-local wall time**, for example `2026-11-01T14:30:00`. Oracle responses use UTC. Obtain the property's timezone from `location get`; the CLI does not convert timezones. Do not use a UTC timestamp or rely on a `Z`/offset suffix to convert it. Choose a future local time satisfying the configured service/lead time. Scheduling/autofire requires suitable POS/order-type configuration.

No responses are inspected for cached status, dropped tips, or business-rule success. Those checks belong to the caller.

Request-body numeric literals (including large integers and precise decimals) retain their precision through parsing, CLI-owned overrides, serialization and `--dry-run`. They are not converted to quoted strings. This does not change the raw STS response contract.

### First-user pilot checklist

1. Agree on the exact test location, RVC, employee, items, tenders and permitted writes. Record `sts version`; begin with `auth status` and authorized read commands. Do not use organization-wide discovery under location-only authorization.
2. Obtain identifiers and the property timezone from authorized lookups. Edit an example body, inspect `--dry-run`, then use `check calculate` before posting anything.
3. Create a clearly labelled test check only after approval. Record its reference and stable idempotency ID. Inspect returned status, quantities and totals; never blindly retry a write after an uncertain outcome.
4. If approved, test adding a round and duplicate detection using identical payloads and IDs for each operation. Never reuse a create ID for an add operation or a changed body.
5. Test scheduled pickup using property-local time and valid lead time. Distinguish an accepted schedule, actual server firing and physical kitchen/printer delivery.
6. Test settlement/tips only with an explicitly agreed tender/body. Verify business results, not just HTTP status. Closed sales may remain in POS audit records; `check delete` may reject closed checks.
7. Delete only your own open test checks and verify cleanup with read-only calls. A transient POS read failure is not permission to repeat a write or edit the database. Share sanitized diagnostics only - never tokens or unreviewed response dumps.

## Shared API options

- `--location` / `--loc`: location reference. Required for location-scoped commands.
- `--rvc`: revenue-center reference where needed.
- `--dry-run`: preview request as local JSON, no network/token required. Organization configuration plus a saved or per-call base URL is still required. Authorization is omitted. `target` is `saved` or `override`; `tlsVerification` shows the effective certificate-verification setting.
- `--sts-url <url>`: override the saved STS URL for this call only. An explicit `http://` or `https://` URL is required; scheme, port and base path are retained. No query string, fragment or embedded credentials. Endpoint paths are appended to the base path.
- `--insecure`: explicitly skip HTTPS certificate verification for this call only, whether using a saved or overridden STS URL. Agents must obtain explicit user confirmation for that endpoint before adding this flag. Refused for known Oracle cloud domains and the configured IDM host. Requires HTTPS; never changes auth login/refresh or saved configuration.
- `--timeout <seconds>`: positive integer, default 30. Writes are never retried.
- `--quiet` / `-q`: suppress status/header diagnostics, not errors.

Unknown options fail, rather than being silently ignored. Empty bodies, HTTP errors and non-JSON response bodies are forwarded unchanged. Redirects are not followed.

### URL and TLS examples

```sh
# Use saved endpoint, verify TLS by default.
sts check list --location <loc> --rvc <rvc>

# One-call override. HTTPS 443 stays 443, not 5443.
sts check list --location <loc> --rvc <rvc> --sts-url https://pos.example:443/gateway

# Explicit port 5443 and deliberate certificate-verification bypass.
sts check list --location <loc> --rvc <rvc> --sts-url https://pos.example:5443 --insecure
```

An omitted port uses the standard HTTPS 443 / HTTP 80. There is no local/cloud mode,
port guessing, or automatic certificate bypass. Only use a trusted URL, since the saved
Bearer token is sent to it. `--local-sts-ip` has been removed and is rejected.

These are per-call API options, distinct from `sts auth config --sts-url <url>`, which
saves a default and clears existing tokens when configuration changes.

### Certificate failures and agent confirmation

A recognized certificate-validation failure returns exit `10` and a stderr hint to
check the hostname and repair the certificate/trusted CA first. For an eligible STS
endpoint, it also explains `--insecure`, its credential-exposure risk, and the requirement
to **ask the user for explicit confirmation before adding it or retrying**. It never
changes TLS settings or retries on its own. The CLI is noninteractive: confirmation is
handled by the calling agent/user, not an internal prompt.

Timeouts, connection refusals, DNS errors and generic TLS protocol errors do not get a
bypass suggestion. Known Oracle cloud/IDM endpoints and calls already using `--insecure`
do not get that suggestion either. Write-uncertainty/idempotency warnings remain intact.

## Connection status

```sh
sts connection status --location <loc> --rvc <rvc>
```

Uses HEAD. Response body on stdout is normally empty. HTTP status and `Simphony-POS-Connected` when available go to stderr. Quiet suppresses these diagnostics. A missing header does not establish whether the POS is connected.

## Feedback

Feedback is a separate, unauthenticated product service, not an STS endpoint. It
requires no Oracle configuration/tokens. Its commands use the local JSON output
contract; loading/success diagnostics go to stderr (`--quiet` suppresses progress).
No input prompts block automation, and invoking submit/retry is explicit consent
from the caller. Agents must obtain that consent from the user first.

```sh
sts feedback status
sts feedback submit --message "Please clarify the example" --category feature --dry-run
# Show the proposed content to the user, then send only after approval:
sts feedback submit --message "Please clarify the example" --category feature
sts feedback submit --rating 5
sts feedback submit --rating 4 --message "Useful, with room to improve"
sts feedback config --reminders on
sts feedback asked
sts feedback snooze --days 30
sts feedback config --reminders off
sts feedback health
```

### Agent-assisted reports

`feedback status` includes `feedbackDue`, reminder policy, recent saved IDs, and
`agentGuidance`. If due, offer feedback/rating and skip/snooze/disable choices.
Record asking using `feedback asked` to start a 30-day cooldown. Honor a decline.
An agent may also offer a report about a suspected CLI bug or recurring confusion
before the timer is due. Do not interrupt urgent work or repeatedly suggest a
report after refusal. Distinguish verified defects, suspicions, configuration
problems and agent mistakes. Propose a brief, sanitized description of expected
versus actual behavior and a minimal reproduction; obtain approval for that text
before submitting. Never automatically attach diagnostics or source/response dumps.

### Payload and delivery

- JSON fields: `schemaVersion: 1`, `product: "@muneris/sts-cli"`, `productVersion`,
  `category` (`general` default, `bug`, `feature`), optional `message`, optional
  integer `rating` (1-5), `submittedAtUtc`, and generated UUID `submissionId`.
- Supply a nonblank message and/or a rating. Text can be multilingual; wire encoding
  is UTF-8 with `Content-Type: application/json; charset=utf-8`.
- Full payload must fit 24,000 UTF-16 code units and 65,536 UTF-8 bytes. These client
  limits leave headroom beneath the service's 32,768-code-unit / 98,304-byte limits.
- POST goes to the base URL itself, with no added `/api` prefix. Only **204** confirms
  storage; no JSON response body is expected or parsed. Errors 400/413/503 produce
  local diagnostics and preserve content. Unexpected statuses/redirects are not
  treated as success; response dumps are not echoed.
- Timeout is 15 seconds by default; `--timeout` permits 1-120 seconds. There are no
  automatic retries, redirects, credentials, cookies or TLS bypass.
- `--dry-run` previews the fields without saving or sending. The real submission
  generates its own UUID/timestamp. Review the intended message/rating/category.

### Persistence and duplicate safety

A private `feedback/Feedback.json` beneath the fixed per-user application-data
directory holds preferences, counters and saved messages. It is separate from
authentication state. The complete intent is saved **before** POST. Network failure
or timeout leaves the content and ID available locally; failure to save prevents a
new POST. A failed receipt save after a POST may leave `sending` state with an
uncertain outcome. Complete recovery copies are retained if replacement fails.

```sh
sts feedback show <submissionId>   # Review private content and original destination.
sts feedback retry <submissionId>  # Only after approval and duplicate-risk warning.
sts feedback discard <submissionId> # Local removal only; no server deletion.
```

Retry keeps the exact original body/ID/destination, even if configuration or the CLI
version changed. The ID is traceability, **not server deduplication**. A timeout can
occur after storage succeeds. Already-confirmed submissions are not POSTed again.
Identical content/category/rating/version sent to the same URL reuses local history;
failed/uncertain entries require `retry`. `submit --new` explicitly permits another
identical logical submission, never use it as a retry workaround. Discarding local
history also removes this local duplicate guard.

A separate feedback lock blocks concurrent submissions. Interrupted processes can
leave `Feedback.json.lock`; inspect its PID and verify no operation is running before
removing a stale lock. No lock is stolen automatically. Never paste the feedback
state/recovery file into a report. There is no attachment upload, remote retrieval,
remote deletion or management UI. Saved history remains local until discarded.

### URL, health and reminders

Default URL: `https://feedback.muneris.cloud/`. Resolution precedence is
per-call `--url` (submit/health), saved `feedback config --url`, then the default. Custom base paths are retained. HTTPS is required except HTTP to
`localhost`, `127.0.0.1` or `[::1]` for testing. Credentials, queries and fragments in
URLs are rejected. Retry deliberately has no URL override.

GET `<base-url>/health` must return HTTP 200 with `{"status":"ok"}`. It proves
**liveness only**, not that storage works. A real POST smoke test creates a row;
local development tests use synthetic mocks instead.

Reminders are on by default for new profiles; existing saved settings, including
`off`, are respected. While enabled, successful STS calls (including quiet calls)
increment a local counter; dry-runs, failures, auth and feedback commands do not.
The timer starts with the first recorded successful STS call or explicit enabling.
First eligibility is 7 days later or 25 recorded successful calls. Read-only status
and previews do not create state or start the timer.
After asking/submitting, at least 30 days must pass. Snooze supports 1-365 days;
the 30-day post-question cooldown still applies. Turning reminders off stops local
usage updates. Counters/timestamps never leave the machine.

Automatic reminder text appears only after a successful STS call with stdin,
stdout and stderr all attached to terminals, and never with `--quiet`. It is a
nonblocking stderr invitation, not a submission. Agents, pipes and redirected
commands receive no unsolicited reminder text; agents explicitly check status.
Bookkeeping is best-effort (a busy lock can skip a count) and never changes STS
response bytes/exit status. A reminder-state failure may produce a stderr warning,
not overwrite corrupt state or change the STS operation's result.

## Deliberate exclusions in this first TypeScript release

No generic arbitrary-URL command; no notification registration/subscription commands; no post-failure STS retry or automatic pagination; no response shaping or charged-tip verification; no invocation-body logging; no automatic self-updater or native executable download feed. SQL database access is not part of this CLI.
