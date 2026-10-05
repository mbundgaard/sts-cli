# Security policy

## Reporting a vulnerability

Please report security issues privately to **support@muneris.dk**, with the subject `sts security report`. Do not open a public issue containing exploit details, credentials, or customer data.

Include the affected version, platform/Node version, a minimal synthetic reproduction, and the potential impact. Do not send live passwords or tokens. We will coordinate investigation and disclosure; no fixed response-time guarantee is offered.

## Supported versions

The project is preparing its first public release. Security fixes will target the latest release; there is no commitment to backport fixes to older versions or the retired .NET implementation.

## Security boundaries

- Credentials and token state belong in the user's private state directory, not source control or npm packages.
- Passwords are used only for authentication; saved tokens remain plaintext on disk. OS permissions and disk protection remain the user's responsibility.
- STS responses are deliberately passed through unchanged. They may contain sensitive information; do not blindly publish or log them.
- `--dry-run` omits authorization but can reveal request-body content.
- `--local-sts-ip` skips TLS certificate validation for the selected local STS request. Use only on trusted networks; cloud and IDM validation remains enabled.
- Check writes can affect a live POS. There are no automatic retries or safeguards that replace reviewing the target/body.
- Dependency, package, or release compromise should be reported through the private channel above.

If a secret is accidentally published, revoke/rotate it immediately. Deleting a file or rewriting history is not a substitute for rotation.
