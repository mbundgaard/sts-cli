<div align="center">

# sts

**Oracle Simphony Transaction Service, from your terminal.**

Authentication. Explicit requests. Unchanged responses.

[![Node.js](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[Getting started](#getting-started) · [Command reference](docs/CLI.md) · [Authentication](docs/AUTHENTICATION.md) · [Oracle API reference](https://docs.oracle.com/en/industries/food-beverage/simphony/omsstsg2api/) · [Contributing](CONTRIBUTING.md)

</div>

`sts` is a small, cross-platform TypeScript CLI for **Oracle Simphony Transaction Services Gen2**. Designed for people, scripts, and AI agents, it handles authentication and builds explicit API requests - without hiding what Simphony returns.

- **One command, every platform.** Windows, macOS, and Linux. Node.js 22+, no .NET runtime.
- **Persistent authentication.** Oracle PKCE login, explicit refresh, and saved token rotation.
- **Discoverable requests.** Noun–verb commands, structured JSON, editable examples, and network-free previews.
- **Raw API output.** Response bodies go to stdout unchanged. Diagnostics go to stderr.
- **No surprise retries.** Writes are explicit; duplicate detection requires a stable idempotency ID.

## Getting started

### Install

From npm:

```sh
npm install --global @muneris/sts-cli
sts --help
```

For the current source checkout:

```sh
npm ci
npm test
npm pack
npm install --global ./muneris-sts-cli-0.3.0.tgz
sts --help
```

Alternatively, run `node bin/sts.js --help` after `npm run build`, without a global installation.

### Configure and authenticate

Use your own Oracle API account. **Replace every `<placeholder>`** before running a command.

```sh
sts auth env
sts auth config --env <env> --org <org> --username <user> --client-id <client-id>
```

Supply your password through the `STS_PASSWORD` environment variable, then:

```sh
sts auth login
sts auth status
```

Nothing ships preconfigured. Passwords are never saved. Tokens are persisted in a per-user directory, outside the npm installation, so upgrades do not remove them. `STS_HOME` overrides that directory.

```sh
sts auth refresh   # explicitly refresh and save rotated tokens
```

See [authentication and state](docs/AUTHENTICATION.md) for secure shell examples, custom environments, state locations, and importing an existing installation.

### Read a property

```sh
sts rvc list --location <loc>
sts menu get --location <loc> --rvc <rvc>
sts tender list --location <loc> --rvc <rvc>
sts check list --location <loc> --rvc <rvc>
sts check get <checkRef> --location <loc> --rvc <rvc>
```

Use `sts endpoints` for the supported read catalog, or `sts <group> <command> --help` for options and worked examples. The CLI implements a selected STS command surface, not every Oracle endpoint.

## Build an order deliberately

### 1. Generate an example

```sh
sts check example service-total > order.json
```

```json
{
  "menuItems": [{ "menuItemId": 0, "quantity": 1 }],
  "tenders": [{ "tenderId": 0, "total": 0 }]
}
```

**Replace the zero IDs before submission.** Use the target property's menu and tender lookup results. A tender whose lookup `type` is `serviceTotal` sends the round without settling; a `payment` tender settles the check. The request's tender ID determines its behavior - there is no `type` field to add to this body.

Also available: `payment`, `tender-only`, `calculate`, `tip`, and `condiment` examples. These are minimal templates, not a complete Oracle schema.

### 2. Preview the request

```sh
sts check new --location <loc> --rvc <rvc> --employee <emp> --order-type <type> --body order.json --dry-run
```

Dry-run builds the request **without contacting Oracle**. It requires a configured organization and either a saved base URL or `--sts-url`, but no token. Authorization is omitted from the preview.

The CLI owns organization, location, RVC, employee, order type, idempotency ID, and - in an added round - the check reference. Other JSON fields are preserved. `--body` accepts a file, inline JSON, or `-` for stdin.

### 3. Submit only after reviewing the target and body

> **Live POS writes:** `check new`, `check add`, and `check delete` change real checks. `check calculate` prices a request without saving it.

```sh
sts check new --location <loc> --rvc <rvc> --employee <emp> --order-type <type> --body order.json --idempotency-id <uuid>
sts check add <checkRef> --location <loc> --rvc <rvc> --employee <emp> --order-type <type> --body order.json --idempotency-id <another-uuid>
```

Use **one UUID per logical write**, reusing it only when retrying that same write. The flag supplies both the stable body ID and Oracle's duplicate-detection header. Without it, each invocation is a new request with no duplicate-detection opt-in.

A timeout does not prove a write failed. The CLI never retries writes or follows redirects automatically. Reconcile uncertain outcomes before trying again.

See the [command reference](docs/CLI.md) for filtering checks, charged tips, pickup/autofire time, and the first-user pilot checklist. Pickup requests use **property-local wall time**, while responses use UTC; the CLI does not convert timezones. Use the property's timezone and configured lead time.

## Choose the STS endpoint per call

By default, requests use the saved STS URL. Override it for one call with an explicit URL:

```sh
sts check list --location <loc> --rvc <rvc> --sts-url https://pos.example:5443
```

The scheme, supplied port, and base path are retained. An omitted port uses the protocol default (HTTPS **443**, HTTP **80**); there is no special `5443` default or local/cloud routing. The CLI appends its API endpoint path to the base path. URLs must not include credentials, a query string, or a fragment.

For a trusted HTTPS STS host with a self-signed certificate, explicitly opt in:

```sh
sts check list --location <loc> --rvc <rvc> --sts-url https://pos.example:5443 --insecure
```

`--insecure` disables certificate validation for that call only. **Agents must get explicit user confirmation for the endpoint before using it.** Fix certificate/CA configuration first; never automatically retry with `--insecure`. The CLI remains noninteractive and does not prompt itself. Certificate-validation failures include this guidance on stderr when bypass is permitted; DNS errors, refused connections, timeouts, and other failures do not suggest it. It is refused for known Oracle cloud domains and the configured IDM hostname, and is unavailable on auth login/refresh. Without it, TLS is verified. Only override to a trusted endpoint: your saved Bearer token is sent to the selected URL. Neither option changes state; `sts auth config --sts-url <url>` is the separate command for saving a new default.

**Breaking change in 0.3.0:** `--local-sts-ip` is removed, not an alias.

## Optional feedback and ratings

You can send product feedback directly from `sts`, without an Oracle login:

```sh
sts feedback submit --message "The help could explain this better" --category feature --dry-run
# After reviewing and approving the text, repeat without --dry-run to send.
sts feedback submit --rating 5
sts feedback status
```

The payload contains the product/version, approved message and/or 1-5 rating,
category (`general`, `bug`, `feature`), timestamp and submission UUID. No STS
configuration, credentials, requests, responses, user identity or usage counts are
automatically sent. Do not put secrets or customer data in your message.

**For agents:** `sts feedback status` returns consent/privacy guidance. If you see a
likely CLI bug or repeated confusion, offer a short sanitized report, explain what
is suspected versus verified, and ask permission before sending. Do not report on
your own or repeat declined suggestions. A scheduled reminder need not be due to
offer a relevant bug report.

Reminders are **off by default**. Opt in with `sts feedback config --reminders on`.
The first becomes due after 7 days or 25 recorded successful STS calls; subsequent
questions are at least 30 days apart. Interactive reminders go to stderr, never
into response bodies. Agents/piped invocations check `feedback status` and record
asking with `feedback asked`. Use `feedback snooze --days 30` or disable reminders
with `feedback config --reminders off`. Nothing is automatically submitted.

Failed submissions stay in private local feedback state. Inspect with
`feedback show <submissionId>` and explicitly retry with `feedback retry <submissionId>`
only after approval: the same ID/body/URL is reused, but **the server does not
deduplicate**, so a timeout followed by a retry may create another row. Identical
submissions are guarded locally; `--new` intentionally starts a separate submission,
not a retry. `feedback discard <submissionId>` removes local content/history only,
not a server row.

The default service is `https://feedback.muneris.cloud/`. Override with
`sts feedback config --url <base-url>`, `STS_FEEDBACK_URL`, or per-call `--url`
(in increasing precedence). HTTPS is required except HTTP loopback for development;
there is no TLS bypass or authentication. `sts feedback health` tests liveness,
not storage. See the [feedback reference](docs/CLI.md#feedback) for details.

## The output contract

**STS response bodies are returned unchanged:** no JSON parsing, wrapping, filtering, redaction, reformatting, or added newline. This includes error responses and non-JSON bodies.

```sh
sts check get <checkRef> --location <loc> --rvc <rvc> --quiet > response.json
```

| Outcome | stdout | stderr | Exit |
|---|---|---|---|
| STS HTTP 2xx | Original response body | HTTP status, unless quiet | `0` |
| STS HTTP 401 | Original error body | HTTP status, unless quiet | `9` |
| Other STS non-2xx | Original error body | HTTP status, unless quiet | `11` |
| Network/input/state failure | Empty | Error | Nonzero |
| Auth, configuration, status, version, endpoints, dry-run | Local JSON result | Diagnostics/errors | Outcome-dependent |
| Feedback commands | Local JSON status, preview or confirmation | Progress/errors | Outcome-dependent |
| `check example` | Editable JSON body | Errors only | `0` or `6` |
| Help/version flag | Human-readable text | Parse errors, if any | `0` or `6` |

Authentication responses necessarily undergo internal parsing to persist tokens; full tokens are not emitted by auth commands. HTTP compression is decoded, and framing is removed. STS bodies are buffered before output so a broken connection does not produce an apparently complete partial response.

**HTTP success is not business validation.** A dropped tip, cached result, or unexpected POS behavior is for the caller to inspect. The CLI does not interpret it. A tender may ignore a charged tip and return change instead: inspect returned tenders, tips, change and totals before claiming success.

Request-body numbers retain their precision, including large integers and precise decimals, in sent requests and dry-run previews. If rotated-token persistence fails after a complete synced replacement was written, a private recovery copy is retained with recovery instructions; do not blindly refresh again. See [authentication recovery](docs/AUTHENTICATION.md#recovering-a-failed-state-replacement).

Exit codes: `0` success · `1` unexpected failure · `6` usage · `7` not configured · `8` no tokens · `9` auth failure · `10` network failure · `11` API non-success · `12` state/lock failure.

## Documentation

| Guide | Contents |
|---|---|
| [Command reference](docs/CLI.md) | Filters, requests, examples, endpoint overrides, TLS, limitations |
| [Authentication and state](docs/AUTHENTICATION.md) | Login, refresh, configuration, storage, restore, troubleshooting |
| [Migration guide](docs/MIGRATION.md) | Differences from the original .NET CLI |
| [Development](docs/DEVELOPMENT.md) | Architecture, tests, package validation, release process |
| [Changelog](CHANGELOG.md) | Changes and release status |

Primary API reference: [Oracle STS Gen2 API Guide](https://docs.oracle.com/en/industries/food-beverage/simphony/omsstsg2api/) ([Swagger](https://docs.oracle.com/en/industries/food-beverage/simphony/omsstsg2api/swagger.json)).

## Contributing

Bug reports, documentation improvements, and focused pull requests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately using [SECURITY.md](SECURITY.md), not public issues. Participation follows our [Code of Conduct](CODE_OF_CONDUCT.md).

Please keep real credentials, customer records, and unreviewed API responses out of issues and pull requests.

## License

[MIT](LICENSE) © 2026 Muneris.

This project is independently maintained and is not an official Oracle product. Oracle and Simphony are trademarks of their respective owners.
