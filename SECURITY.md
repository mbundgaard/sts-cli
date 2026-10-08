# Security policy

## Reporting a vulnerability

Please report security issues privately to **support@muneris.dk**, with the subject `sts security report`. Do not open a public issue containing exploit details, credentials, or customer data.

Include the affected version, platform/Node version, a minimal synthetic reproduction, and the potential impact. Do not send live passwords or tokens. We will coordinate investigation and disclosure; no fixed response-time guarantee is offered.

## Supported versions

Security fixes target the latest release. There is no commitment to backport fixes to older versions.

## Security boundaries

- Credentials and token state belong in the user's private state directory, not source control or npm packages.
- Passwords are used only for authentication; saved tokens remain plaintext on disk. OS permissions and disk protection remain the user's responsibility.
- STS responses remain unchanged, inline or in private retained files above 16 KiB or 500 lines. Receipts contain references, not record summaries. Exports may contain sensitive information; do not publish/log them and delete them when no longer needed. Files have no automatic expiry. Handled failures clean partial files, but hard termination may leave private .part files. See [Response delivery](docs/RESPONSES.md).
- Before STS calls, scheduled renewal can contact the IDM endpoints of all saved companies, including inactive profiles. Each result is locked/persisted independently; no request retry is performed. Known-expired token sets are deleted without attempting refresh, even if the refresh token might still work. No daemon, automatic renewal on help/local commands, or network on dry-run.
- The selected company key is pinned for an API invocation. Exact-key selection/deletion is local; deleting a profile does not revoke remote tokens. Full-registry recovery files contain credentials for multiple companies: keep them private and resolve persistence errors before any further API/auth call.
- `--dry-run` omits authorization but can reveal request-body content.
- `--sts-url` overrides the STS endpoint for one call; the saved Bearer token is sent to that endpoint, so use only trusted URLs. HTTPS verifies certificates by default. `--insecure` explicitly disables verification for one STS call and is refused for known Oracle cloud domains or the configured IDM host. Agents must obtain explicit user confirmation for the target before using the flag; the CLI is noninteractive and does not enforce a human confirmation prompt. Certificate failures may explain this option, but no retry or TLS downgrade happens automatically. Auth login/refresh never accept this flag. The former `--local-sts-ip` behavior has been removed.
- Check writes can affect a live POS. There are no automatic retries or safeguards that replace reviewing the target/body.
- Optional product feedback sends only caller-approved message/rating and product metadata to a separate service, without STS authorization, cookies or account configuration. Reminders default on for new profiles and can be disabled; existing saved preferences are respected. No usage counters are transmitted. The CLI cannot reliably detect secrets typed into free text: agents/users must review it before submission. Do not use ordinary feedback for sensitive vulnerability details; use the private channel above.
- Feedback messages and delivery history remain plaintext in private local feedback state until explicitly discarded. `feedback show` and feedback dry-run reveal that content. Protect the directory and never share state/recovery files. Local discard cannot delete a stored server row. The service stores request headers as well as the submitted body; do not add unnecessary personal data.
- Feedback URL overrides must be trusted. Production requires HTTPS; HTTP is permitted only to loopback for development, with no insecure TLS option. Failed/uncertain submissions must not be blindly retried: the server stores each accepted POST separately even when submission IDs match.
- Automatic npm update checks run only after successful non-quiet STS calls, at most once per 24 hours. They send no Oracle credentials, headers or customer data, never install anything, and cannot change the STS result. The separate schedule contains no credentials. Explicit `version --check` bypasses that schedule.
- Dependency, package, or release compromise should be reported through the private channel above.

If a secret is accidentally published, revoke/rotate it immediately. Deleting a file or rewriting history is not a substitute for rotation.
