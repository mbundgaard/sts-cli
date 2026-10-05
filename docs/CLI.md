# Command reference

Run `sts <group> <command> --help` for exact options. Placeholder values below must be replaced. Commands labelled **DESTRUCTIVE** affect the POS; preview the request with `--dry-run` first.

## Local and authentication commands

| Command | Purpose |
|---|---|
| `sts --help` | Discover commands |
| `sts --version` | Plain version string |
| `sts version` | JSON containing npm version and Node/platform information |
| `sts endpoints` | JSON catalog of supported GET endpoints |
| `sts auth env` | Available environment presets |
| `sts auth config` | Show configuration, without changing it |
| `sts auth config --env <env> --org <org> --username <user> --client-id <id>` | Configure and clear stale tokens if identity/endpoints change |
| `sts auth config --env custom --auth-url <url> --sts-url <url> ...` | Custom deployment |
| `sts auth login` | PKCE login using `STS_PASSWORD` or `--password`; saves tokens |
| `sts auth refresh` | Explicit refresh and persistent token rotation |
| `sts auth status` | Local token presence and expiry (default for `sts auth`) |
| `sts auth show` | Effective configuration plus token summary |
| `sts auth restore --file <path> [--force]` | Import existing state without contacting Oracle |
| `sts auth logout` | Clear tokens locally, not server-side revocation |

Login accepts `--username` to override the saved user. Login/refresh accept `--quiet` and `--timeout <seconds>`. State-changing commands lock and save state; do not run another client against the same token simultaneously.

## Read endpoints

All calls require configured organization and a usable token unless `--dry-run` is used.

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
- `--charged-tip <amount>`: requires one tender; writes `chargedTipTotal`, not tender `total`.
- `--pickup-time <timestamp>`: writes `header.pickupTime` and requires suitable POS/order-type configuration.

No responses are inspected for cached status, dropped tips, or business-rule success. Those checks belong to the caller.

## Shared API options

- `--location` / `--loc`: location reference. Required for location-scoped commands.
- `--rvc`: revenue-center reference where needed.
- `--dry-run`: preview request as local JSON, no network/token required. Organization/base URL configuration is still required. Authorization is omitted.
- `--local-sts-ip <host|url>`: ephemeral local target; bare host uses HTTPS 5443; certificate verification is skipped only for this call.
- `--timeout <seconds>`: positive integer, default 30. Writes are never retried.
- `--quiet` / `-q`: suppress status/header diagnostics, not errors.

Unknown options fail, rather than being silently ignored. Empty bodies, HTTP errors and non-JSON response bodies are forwarded unchanged. Redirects are not followed.

## Connection status

```sh
sts connection status --location <loc> --rvc <rvc>
```

Uses HEAD. Response body on stdout is normally empty. HTTP status and `Simphony-POS-Connected` when available go to stderr. Quiet suppresses these diagnostics. A missing header does not establish whether the POS is connected.

## Deliberate exclusions in this first TypeScript release

No generic arbitrary-URL command; no notification registration/subscription commands; no automatic refresh/retry/pagination; no response shaping or charged-tip verification; no invocation-body logging; no `version --check` Windows download feed. SQL database access is not part of this CLI.
