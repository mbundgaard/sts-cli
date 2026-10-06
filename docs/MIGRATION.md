# Migration from the .NET CLI

## What's preserved

- Command name `sts` and core noun/verb commands.
- Oracle authorization-code + PKCE S256, cookie-based sign-in and refresh verifier handling.
- Significant client-ID characters including trailing `=`.
- All 15 legacy read registry entries, check list/get/calculate/new/add/delete, connection HEAD.
- Path/query/Simphony-header addressing and required Bearer + Accept headers.
- Body file, stdin and inline JSON support; explicit employee/order type flags.
- Opt-in idempotency, charged-tip request field and pickup time overrides.
- CamelCase `StsCli.json` state shape, plus explicit legacy-state import.

## Breaking changes

1. **STS stdout is raw response bytes.** Remove `.data` from scripts that consumed the old wrapper. HTTP error bodies are also unchanged, on stdout. Local errors use stderr and exit codes.
2. **No semantic response checks.** An HTTP 200 is exit 0 even if the POS ignored a charged tip or returned a cached check. Inspect the response externally.
3. **User-level state by default.** TypeScript does not discover credentials beside an executable. Set `STS_HOME` or run `auth restore`.
4. **No .NET/native binaries.** Node 22+ runs the same implementation on Windows/macOS/Linux.
5. **Version is npm SemVer.** `sts version` is local JSON. `version --check` and the Windows-only download feed are not part of this implementation.
6. **No invocation log/debug-log configuration.** Existing legacy `debugLog` values are retained when loading state but ignored by TypeScript.
7. **Stricter validation.** Malformed state is an error, not an empty configuration. Invalid numeric flags, dates, conflicting location aliases and invalid body/header types fail before network I/O.
8. **Configuration changes clear tokens.** Explicitly log in after changing identity/endpoints. Restoring existing complete state does not do this.
9. **HEAD output is empty.** Connection headers are diagnostic stderr, not a fabricated response body. HTTP non-2xx uses API exit status.
10. **State errors use exit 12.** Auth mutations are serialized by a lock file and saved with a temporary-file rename. A legacy process does not participate in this lock.

## Endpoint options after 0.2.0

`--local-sts-ip` has been removed. Replace it with an explicit per-call `--sts-url`:

```sh
sts check list --location <loc> --rvc <rvc> --sts-url https://pos.example:5443
```

No local routing, automatic port 5443, or automatic TLS bypass remains. An explicit
port is retained; omitted ports use the standard HTTPS 443 / HTTP 80. Base paths are
preserved and API paths appended. For a trusted self-signed HTTPS STS host, add the
separate `--insecure` flag. It is refused for known Oracle cloud domains and the
configured IDM host; login/refresh are never affected.

Neither flag is saved. Without `--sts-url`, the saved STS URL is used. The separate
`auth config --sts-url` command still saves a default. Dry-run `target` now reads
`saved` or `override` instead of `cloud` or `local`.

## Safe state transition

Stop other processes that might refresh the old token. Choose one method:

```sh
# Import into the new user-state directory; no Oracle network call.
sts auth restore --file /path/to/legacy/StsCli.json
sts auth status
```

If already configured, inspect the destination first; `--force` explicitly replaces it.

Or set `STS_HOME` to the legacy state directory and use the same file. Do not have independently copied states refreshing the same token: an Oracle rotation can invalidate the other copy.

Test a read-only endpoint at an explicitly approved location first. Only then perform an approved check write using a reviewed body and an explicit stable idempotency ID. Never treat a transport timeout as evidence that a write did not happen.

## TypeScript-only distribution

The public project contains only the TypeScript implementation. It does not include,
load, or shell out to the original .NET CLI or its native-binary npm experiment.
There is no .NET runtime prerequisite.

Keep any old installation or private archive separate from this checkout. Import its
state explicitly, as described above, rather than copying its build folders into this
project. GitHub CI validates the new implementation; publication is a separate action.
