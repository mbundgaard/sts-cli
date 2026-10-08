# Authentication and state

## Oracle setup

You need an Oracle API account, OAuth client ID, and correct deployment environment. No tenant identity is bundled.

```sh
sts auth env
sts auth config --env <env> --username <user> --client-id <client-id>
```

Replace placeholders. The organization/company code is derived automatically from
the Base64 client ID's decoded `<organization>.<UUID>` value. There is no separate
organization input or override. Saved/imported organization metadata is re-derived
from the client ID, never used to override it; without a client ID it cannot supply
organization addressing. Unrecognized IDs are rejected rather than guessed.
Quote shell-special characters in client IDs; trailing `=` padding is significant
and the original client ID is preserved unchanged for Oracle. Presets: `mte2`, `mte3`, `mte4`, `mte5`, `mtu1`. For a dedicated deployment:

```sh
sts auth config --env custom --auth-url <idm-base-url> --sts-url <sts-base-url> --username <user> --client-id <client-id>
```

Configuration prepares the next login without replacing saved companies, changing the active company or clearing its tokens. Successful login saves that configuration and selects its company. Failed login leaves saved profiles and selection unchanged. `auth show` shows the prepared login configuration when present; `auth status` describes the active company's tokens.

## Login

Login uses Oracle authorization-code + PKCE S256. Pass the password as a normal
command argument:

```sh
sts auth login --password "<password>"
```

The password is used for login only and is not saved by the CLI. Later sessions
reuse saved tokens. Do not assume the password is expired, one-time, or requires
changing unless Oracle explicitly reports that. HTTP 401 alone does not establish
any of those conditions. Refresh uses the saved refresh token, not the password.
You can rotate the password afterward in Oracle.

**For agents:** first run `sts auth status`. Saved configuration/tokens are shared
across sessions running as the same OS user with the same state directory. Reuse valid
tokens or explicitly refresh them; do not repeat configuration/login unnecessarily.
If the user supplies credentials and authorizes login, use `--password` when requested
rather than refusing solely because a password was provided. Do not echo it,
persist it, or include it in feedback.

Command-line password arguments may be visible in shell history and process listings. `--username` overrides the prepared/saved user for a login. `--quiet` suppresses HTTP diagnostics; `--timeout <seconds>` changes the default 30-second timeout.

A matching saved company, auth hostname and exact username with an access token that is not known to be expired skips authentication and reports the saved expiry information. It does not change active selection. No password is needed to report this duplicate. Unknown expiry is reported without claiming the token is valid. Known-expired tokens do not block a fresh login.

To deliberately replace a same-user login or its configuration, select the exact saved company, run `sts auth logout`, then configure and log in again. No replacement flag is required. This also applies when changing its saved STS URL: prepared settings are not applied to the active profile until successful login.

## Companies

```sh
sts company list
sts company status
sts company select "<companyCode>@<authHostname>"
sts company delete "<companyCode>@<authHostname>"
```

Keys use the company code derived from the client ID plus the lowercase auth hostname, excluding scheme, port, path, query and fragment. The full auth URL stays in the profile. Two auth hostnames can hold the same company code. Same-host accounts, ports and paths are not separate profile identities: successful login for another username replaces that key and selects it.

Selection and deletion require an exact key from the local list. Bare codes and fuzzy matches are rejected. Agents should list/disambiguate a shorthand such as `AUS`, not guess. Listing means locally configured, not verified Oracle access; token values are never listed.

Selection also discards unfinished login configuration so future auth commands target the selected profile. Deletion removes only the specified local profile and any matching prepared configuration, without Oracle revocation. Deleting the active company clears selection; no other company is chosen automatically. Deletion should be confirmed by the agent before issuing the command.

## Status and refresh

```sh
sts auth status
sts auth show
sts auth refresh
```

Status is a local presence/expiry check, not server-side token validation. Show returns configuration and token presence, not full token values. Refresh saves rotated tokens atomically; if Oracle omits a replacement refresh token, the saved one is retained.

Before a non-preview STS API command, the CLI checks **all saved companies**, including inactive ones:

1. If `obtainedAt + expiresIn <= now`, remove the entire token set, including the refresh token, without trying renewal. Keep configuration and active selection. A new login is required. This intentionally discards a refresh token that Oracle might still accept.
2. Renew each remaining profile whose persisted `refreshAfter` is due. Successful login or renewal sets it to **now + 24 hours**.
3. An unsuccessful renewal sets `refreshAfter` to **now + 1 hour** and retains still-valid tokens. No escalating delay, failure counter or daemon. Expiry remains independent and overrides the cooldown.
4. Persist each result under the state lock, rechecking its schedule after locking. A usable active token can serve the original request even if renewal fails for it or another company. No STS request is retried, including after HTTP 401.

`sts auth refresh` explicitly checks all profiles now and bypasses cooldown, but still removes expired tokens instead of renewing them. Its local JSON lists each company's outcome; a failed or tokenless profile gives a nonzero exit. It never changes active selection. A missing expiry is retained and reported as unknown, not guessed or renewed.

Help, list/status/config commands and dry-runs never renew tokens or perform expiry cleanup. There is no background process: if the CLI is unused until expiry, the next API invocation removes those tokens and requires login. The active key is captured once per invocation; concurrent selection cannot mix one company's endpoint with another's token. An invalid request is rejected before renewal.

Timeout applies separately to each renewal and the API request, not to the combined sweep. Persistence/lock errors stop the operation before the STS call; they are not Oracle backoff events. Resolve rotated-token recovery before issuing another API command.

### Newly granted location access

When additional location access is granted to the API user, obtain a newly issued
token after the permission change has propagated. Allow approximately **20 minutes**
from adding the location before issuing the new token and verifying access; this is
an operational expectation, not a guaranteed deadline. Do not expect the existing token
to gain the new access immediately, or assume that a token issued before propagation
has completed will include it. Verify access with an authorized read limited to the
newly granted location. A propagation-related denial is not by itself evidence of
an incorrect password; do not repeatedly retry login or probe other locations.

### Recovering a failed state replacement

If a fully written/synced state file cannot replace the saved file, the CLI exits `12`
and retains the private `.tmp` recovery copy. The error gives its exact path and a
`sts auth restore --file "<reported-recovery-path>" --force` command. The previous
state remains in place, but its refresh token may already be invalid.

Do **not** retry login/refresh with that old state. Resolve the filesystem/permission
problem first, then restore the exact copy reported by the failed operation. Do not
blindly select an older recovery file. Verify with `auth status` and an authorized
read, then delete the recovery copy. It contains credentials: never paste it into chat,
attach it to issues, or commit it. Incomplete/unsynced temporary files are removed;
failed writes before a complete synced copy exists cannot guarantee token recovery.

After expiry cleanup, a request without active-company tokens exits `8`. A token that expires after maintenance but before request construction can produce exit `9`; STS HTTP 401 also remains exit `9`. If Oracle explicitly reports an expired password or mandatory password change, follow that requirement; do not infer it from a generic authentication failure.

`sts auth logout` removes the active company's local tokens and schedule only. It keeps all company configuration and other profiles, and does not revoke tokens at Oracle.

## State storage

| Platform | Default directory |
|---|---|
| Windows | `~/AppData/Roaming/StsCli` |
| macOS | `~/Library/Application Support/StsCli` |
| Linux | `~/.config/StsCli` |

`~` denotes the OS user's home directory. The file is `StsCli.json` and survives
npm upgrades and uninstalls. Windows uses the user's AppData folder, for example
`C:\Users\<user>\AppData\Roaming\StsCli`.

All sessions running as the same OS user automatically share configuration, tokens
and local feedback state. There is no directory option. If you have a saved state
file elsewhere, use `auth restore --file <path>` to import it into this fixed
per-user directory rather than logging in again.

State schema version 2 stores `activeCompany`, a `companies` map and optional prepared login configuration. Each company has its own auth settings, tokens and `refreshAfter`. Existing single-company state is read as one active company without losing tokens; the migrated registry is persisted on the next mutation. Its first schedule is `obtainedAt + 24 hours`, or immediately due if that timestamp is absent. Incomplete legacy configuration is preserved for the next config/login operation.

Tokens are plaintext on disk; protect the directory with OS account permissions and disk encryption. Unix state files are created owner-only. State must not enter source control, public issue reports, or npm packages.

Writes use a temporary file and rename. Auth mutations are serialized using `StsCli.json.lock`. If a process is killed, inspect its PID and whether another command is active before manually removing a stale lock. Do not run simultaneous refreshes in other applications that do not honor this lock.

Corrupt/unreadable state is reported with exit `12`, not silently replaced. Repair it from a trusted backup; the CLI will not silently reset it.

## Import and backup

Import a saved configuration and token file:

```sh
sts auth restore --file /path/to/saved/StsCli.json
sts auth status
```

Restore accepts legacy single-company files or the complete version-2 registry. It is local-only and refuses to overwrite configured state unless `--force` is specified. Force replaces the entire registry, including active selection; it is not a single-company merge. Avoid refreshing from independent copies of the same token state: token rotation may invalidate the other copy.

Back up state using protected filesystem or secret-storage tools. There is no command that prints complete saved credentials to stdout.

## Troubleshooting

- **Not configured after installation:** check `auth status` and the current OS user's state directory, or import saved state; the CLI never searches your repository for credentials.
- **STS 401:** verify the selected company and authorization. An explicit refresh may help an unexpired token; there is no automatic retry after 401. **Expired tokens:** log in again; they are intentionally removed rather than refreshed.
- **Login 401:** Oracle rejected authentication. Verify the exact supplied credentials, organization, client ID, account permissions and IDM deployment. Do not guess username casing, conclude the password must be changed, or repeatedly retry without new evidence.
- **403:** check resource permissions, IDs, and selected environment. STS's raw error body is on stdout.
- **503:** the property may not be connected to the selected STS hub.
- **TLS errors:** certificate verification is enabled by default. Repair the certificate/trusted CA first. For a trusted HTTPS STS endpoint, the explicit per-call `--insecure` option is available only after the agent obtains the user's confirmation for that endpoint; optionally combine it with `--sts-url <url>`. Do not automatically add it after a connection failure. Known Oracle cloud domains and the configured IDM host cannot use this bypass. Auth login/refresh always verify HTTPS certificates.
- **State errors:** verify directory permissions, file validity and stale locks; see exit `12` diagnostics.

See [the command reference](CLI.md) for location-specific operations and the raw-response output contract.
