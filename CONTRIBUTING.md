# Contributing to sts

Thank you for helping make Simphony automation clearer and safer. Small, focused changes and documentation improvements are welcome.

## Local setup

Use Node.js 22 or newer:

```sh
npm ci
npm test
npm run test:package
node bin/sts.js --help
```

Tests use local mock servers and synthetic data. **No Oracle account or live POS is needed.** Package tests install an archive in a temporary directory and invoke its actual `sts` shim; they may download dependencies from npm.

## Before opening a pull request

1. Explain the problem and expected behavior. For a new API operation, link the Oracle reference.
2. Keep the change focused; discuss large command-surface changes in an issue first.
3. Add tests, especially for request addressing, exit codes, and exact response bytes.
4. Update command help and user documentation together.
5. Run `npm test` and `npm run test:package`.
6. Review the diff and package contents for local paths, tenant data, tokens, and generated artifacts.

Use TypeScript for implementation and Node's built-in test runner for tests. Follow existing formatting; avoid unrelated formatting churn. Use UTF-8, LF line endings, and two-space indentation.

## Contracts to preserve

- Explicit commands and identifiers; never guess a target, employee, item, or tender.
- STS response bodies stay verbatim, even for non-JSON/errors: inline up to 16 KiB
  and 500 lines; above either limit, save unchanged and return a file reference.
  Use the shared response handler, without mode flags or silent truncation.
- Diagnostics/errors go to stderr. Local command results use the local JSON contract.
- No automatic POS writes, STS retries or redirects. Pre-API maintenance renews
  all due company profiles (+24h success, +1h failure); expired token sets are
  removed without renewal. Keep help/local/dry-run commands network-free.
- Duplicate detection requires both a stable ID and the feature header.
- Refresh must persist rotated tokens. Passwords must never be saved.
- State lives outside package installation directories and is never bundled.
- Help includes blast-radius labels and realistic placeholder examples.

## Live testing

Do not run live check writes merely to validate a contribution. Use mock servers by default. Any live test requires explicit authorization for its location and operation; new/add/delete affect the real POS. A calculator request is non-persisting but still contacts the service.

Never put real tenant details, account credentials, customer data, or unreviewed response bodies into tests, issues, screenshots, or pull requests. See [SECURITY.md](SECURITY.md) for private vulnerability reports.

## Commit and release practices

Use short, descriptive commit subjects. Maintainers handle versions, tags, and npm publishing separately. A pull request should not change the package version unless specifically requested. Ordinary CI is validation-only. The separate release workflow publishes through npm trusted publishing when a stable GitHub release is published; it does not store a long-lived npm token.

By contributing, you agree that your contributions are licensed under this project's [MIT license](LICENSE). Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).
