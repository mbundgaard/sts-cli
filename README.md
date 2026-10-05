<div align="center">

# sts

**Oracle Simphony, from your terminal.**

Authentication. Explicit requests. Unchanged responses.

[![Node.js](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[Getting started](#getting-started) · [Command reference](docs/CLI.md) · [Authentication](docs/AUTHENTICATION.md) · [Contributing](CONTRIBUTING.md)

</div>

`sts` is a small, cross-platform TypeScript CLI for **Oracle Simphony Transaction Services Gen2**. Designed for people, scripts, and AI agents, it handles authentication and builds explicit API requests—without hiding what Oracle returns.

- **One command, every platform.** Windows, macOS, and Linux. Node.js 22+, no .NET runtime.
- **Persistent authentication.** Oracle PKCE login, explicit refresh, and saved token rotation.
- **Discoverable requests.** Noun–verb commands, structured JSON, editable examples, and network-free previews.
- **Raw API output.** Response bodies go to stdout unchanged. Diagnostics go to stderr.
- **No surprise retries.** Writes are explicit; duplicate detection requires a stable idempotency ID.

> **Early release:** automated tests and installed-package checks pass on Windows, macOS, and Linux with Node 22 and 24. Live token refresh, reads, and calculation have been verified. Live posting, duplicate replay, and autofire still need validation; review and test your integration before production use.

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
npm install --global ./muneris-sts-cli-0.2.0.tgz
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

**Replace the zero IDs before submission.** Use the target property's menu and tender lookup results. A tender whose lookup `type` is `serviceTotal` sends the round without settling; a `payment` tender settles the check. The request's tender ID determines its behavior—there is no `type` field to add to this body.

Also available: `payment`, `tender-only`, `calculate`, `tip`, and `condiment` examples. These are minimal templates, not a complete Oracle schema.

### 2. Preview the request

```sh
sts check new --location <loc> --rvc <rvc> --employee <emp> --order-type <type> --body order.json --dry-run
```

Dry-run builds the request **without contacting Oracle**. It requires configured organization/base URL, but no token. Authorization is omitted from the preview.

The CLI owns organization, location, RVC, employee, order type, idempotency ID, and—in an added round—the check reference. Other JSON fields are preserved. `--body` accepts a file, inline JSON, or `-` for stdin.

### 3. Submit only after reviewing the target and body

> **Live POS writes:** `check new`, `check add`, and `check delete` change real checks. `check calculate` prices a request without saving it.

```sh
sts check new --location <loc> --rvc <rvc> --employee <emp> --order-type <type> --body order.json --idempotency-id <uuid>
sts check add <checkRef> --location <loc> --rvc <rvc> --employee <emp> --order-type <type> --body order.json --idempotency-id <another-uuid>
```

Use **one UUID per logical write**, reusing it only when retrying that same write. The flag supplies both the stable body ID and Oracle's duplicate-detection header. Without it, each invocation is a new request with no duplicate-detection opt-in.

A timeout does not prove a write failed. The CLI never retries writes or follows redirects automatically. Reconcile uncertain outcomes before trying again.

See the [command reference](docs/CLI.md) for filtering checks, charged tips, pickup/autofire time, and local STS targeting.

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
| `check example` | Editable JSON body | Errors only | `0` or `6` |
| Help/version flag | Human-readable text | Parse errors, if any | `0` or `6` |

Authentication responses necessarily undergo internal parsing to persist tokens; full tokens are not emitted by auth commands. HTTP compression is decoded, and framing is removed. STS bodies are buffered before output so a broken connection does not produce an apparently complete partial response.

**HTTP success is not business validation.** A dropped tip, cached result, or unexpected POS behavior is for the caller to inspect. The CLI does not interpret it.

Exit codes: `0` success · `1` unexpected failure · `6` usage · `7` not configured · `8` no tokens · `9` auth failure · `10` network failure · `11` API non-success · `12` state/lock failure.

## Documentation

| Guide | Contents |
|---|---|
| [Command reference](docs/CLI.md) | Filters, requests, examples, options, local STS, limitations |
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
