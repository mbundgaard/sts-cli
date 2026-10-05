# Authentication and state

## Oracle setup

You need an Oracle API account, organization short name, OAuth client ID, and correct deployment environment. No tenant identity is bundled.

```sh
sts auth env
sts auth config --env <env> --org <org> --username <user> --client-id <client-id>
```

Replace placeholders. Quote shell-special characters in client IDs; trailing `=` padding is significant and preserved. Presets: `mte2`, `mte3`, `mte4`, `mte5`, `mtu1`. For a dedicated deployment:

```sh
sts auth config --env custom --auth-url <idm-base-url> --sts-url <sts-base-url> --org <org> --username <user> --client-id <client-id>
```

Changing configuration clears existing tokens to prevent accidentally reusing an account's token against a different target.

## Login

Login uses Oracle authorization-code + PKCE S256. Supply the password via `STS_PASSWORD` from a secret manager or temporary shell input. The password is never saved.

Bash:

```bash
read -r -s -p 'Oracle password: ' STS_PASSWORD; printf '\n'
export STS_PASSWORD
sts auth login
unset STS_PASSWORD
```

PowerShell 7:

```powershell
$credential = Get-Credential -Message 'Oracle API login (password only is used here)'
$env:STS_PASSWORD = $credential.GetNetworkCredential().Password
try { sts auth login } finally { Remove-Item Env:STS_PASSWORD }
```

`--password` is also supported but may expose the value in shell history and process arguments. `--username` overrides the saved user for a login. `--quiet` suppresses HTTP diagnostics; `--timeout <seconds>` changes the default 30-second timeout.

## Status and refresh

```sh
sts auth status
sts auth show
sts auth refresh
```

Status is a local presence/expiry check, not server-side token validation. Show returns configuration and token presence, not full token values. Refresh saves rotated tokens atomically; if Oracle omits a replacement refresh token, the saved one is retained.

Refresh is explicit. API commands never automatically refresh or retry. Expired tokens produce exit `9`; missing tokens produce exit `8`. A rejected refresh normally requires a fresh login. An expired Oracle password must be changed through Oracle before login can finish.

`sts auth logout` removes local tokens. It does not revoke them at Oracle.

## State storage

| Platform | Default directory |
|---|---|
| Windows | `%APPDATA%/StsCli` |
| macOS | `~/Library/Application Support/StsCli` |
| Linux | `$XDG_CONFIG_HOME/StsCli`, otherwise `~/.config/StsCli` |

The file is `StsCli.json`. It survives npm upgrades and uninstalls. `STS_HOME` overrides the directory:

```sh
# POSIX shell
export STS_HOME="$HOME/.my-sts-state"
sts auth status
```

```powershell
$env:STS_HOME = Join-Path $HOME '.my-sts-state'
sts auth status
```

Tokens are plaintext on disk; protect the directory with OS account permissions and disk encryption. Unix state files are created owner-only. State must not enter source control, public issue reports, or npm packages.

Writes use a temporary file and rename. Auth mutations are serialized using `StsCli.json.lock`. If a process is killed, inspect its PID and whether another command is active before manually removing a stale lock. Do not run simultaneous refreshes in other applications that do not honor this lock.

Corrupt/unreadable state is reported with exit `12`, not silently replaced. Repair it from a trusted backup or select a clean state directory.

## Import and backup

The camelCase state format is compatible with the original .NET CLI:

```sh
sts auth restore --file /path/to/saved/StsCli.json
sts auth status
```

Restore is local-only and refuses to overwrite configured state unless `--force` is specified. Alternatively, use `STS_HOME` to point at an existing state directory. Keep old clients idle: two independent copies refreshing the same token may invalidate one another.

Back up state using protected filesystem or secret-storage tools. There is no command that prints complete saved credentials to stdout.

## Troubleshooting

- **Not configured after installation:** import saved state or check `STS_HOME`; the CLI never searches your repository for credentials.
- **401 / expired token:** run `auth refresh`; if rejected, log in again.
- **403:** check resource permissions, IDs, and selected environment. STS's raw error body is on stdout.
- **503:** the property may not be connected to the selected STS hub.
- **TLS errors:** cloud and IDM validate certificates. For a trusted on-prem deployment only, `--local-sts-ip` explicitly allows a self-signed certificate for that STS request.
- **Proxy requirements:** HTTP(S) proxy environment variables are not supported in this initial release.
- **State errors:** verify directory permissions, file validity and stale locks; see exit `12` diagnostics.

See [the command reference](CLI.md) for location-specific operations and [migration](MIGRATION.md) for the new raw-response output contract.
