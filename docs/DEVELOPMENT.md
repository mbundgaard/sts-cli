# Development

## Requirements and commands

Node.js 22+ and npm:

```sh
npm ci
npm test
npm run test:package
node bin/sts.js --help
npm pack --dry-run
```

`npm test` compiles TypeScript and runs isolated Node test-runner tests. They use synthetic local HTTP servers, not Oracle, and require no credentials. `npm run test:package` packs the project, checks its file allowlist, installs it in a temporary directory, and invokes npm's actual `sts` shim. Dependency installation can require registry access.

## Project layout

```text
.github/         GitHub CI and contribution templates
bin/sts.js       npm command entry point
catalog/         Public catalog frame and explicitly reviewed screenshots
docs/            User and developer guides
scripts/         Package validation and public catalog export utilities
src/             TypeScript implementation
tests/           Offline tests and mock servers
```

Generated `dist/`, `node_modules/`, and package archives are ignored. `StsCli.json` belongs in the platform user application-data directory, never in the project.
Tests inject isolated stores through an unpackaged test runner; production has no
directory flag. Package checks exercise the real shim for help/version/parser exits
and the installed modules with an isolated store for stateful checks.

## Implementation map

| Module | Responsibility |
|---|---|
| `cli.ts` | Command tree, help, handlers |
| `auth.ts` | PKCE, cookies, login, refresh |
| `state.ts` | State paths, validation, compatibility, locked atomic saves |
| `identity.ts` | Derive organization from the Base64 client ID without modifying the original ID |
| `endpoints.ts` | Declarative read endpoint catalog |
| `requests.ts` | Input validation and request construction |
| `json.ts` | Node 22+ source-aware request JSON parsing; preserve numeric precision, never parse STS responses |
| `transport.ts` | HTTP(S), compression decoding, raw body transport |
| `examples.ts` | Minimal structured request templates |
| `output.ts` | Local JSON results, errors and exit codes |
| `diagnostics.ts` | Certificate-failure guidance, explicit user-confirmation requirement, write-uncertainty hints |
| `feedback.ts` | Separate unauthenticated feedback service, private outbox/history, local configurable reminders and agent guidance |
| `updates.ts` | Explicit advisory npm lookup and SemVer comparison; no installation or STS side effects |

Keep STS response JSON parsing out of the transport/execution path. Test Buffer equality,
not just parsed JSON equivalence: whitespace, numeric representations and trailing
newlines must survive unchanged. An interrupted body must not look complete.

## Testing boundaries

Tests cover auth against mocks, token persistence/rotation, raw response bytes, endpoint
addressing, request construction, and actual package installation. GitHub Actions is
configured for Windows, macOS and Linux on Node 22 and 24. A configured matrix is not
proof of a successful remote CI run; inspect the workflow results after pushing.

Mock tests are the default. Live testing needs explicit approval for its location and
operation. Check writes are real transactions; calculator calls are non-persisting but
still use the service. Never use organization-wide discovery under location-limited
authorization. Keep live state outside the repository and avoid concurrent refreshes in
other clients.

## API references

- [Oracle STS Gen2 guide](https://docs.oracle.com/en/industries/food-beverage/simphony/omsstsg2api/)
- [Oracle Swagger](https://docs.oracle.com/en/industries/food-beverage/simphony/omsstsg2api/swagger.json)

Endpoint paths, methods and addressing were checked against Oracle's
published specification. IDM authentication endpoints are not part of that STS Swagger;
the PKCE implementation follows the previously tested client flow. Fresh mocked login
and real token refresh are separate forms of validation.

## Feedback testing

Feedback uses its own locked state beneath the profile's `feedback/` directory;
reminder counts must never rewrite auth state or change raw STS output/exit codes.
Use local HTTP mocks with synthetic content only. Tests cover 204 without parsing,
400/413/503/unexpected statuses, redirects, timeout uncertainty, identical-content
and concurrent-submit guards, exact body/ID/destination reuse, private recovery,
UTF-8/code-unit limits, reminders and agent consent guidance. The installed-package
smoke test exercises feedback status and preview without a network request.

Do not run the production feedback smoke POST without explicit approval: every
accepted POST creates a real row. Health is liveness only, not storage validation.
Free-form messages are user-approved input, not automatically collected diagnostics.

## Packaging

The npm package contains the launcher, compiled modules, license, README, changelog and
selected documentation. It does not include source fixtures, development scripts,
credentials, response dumps, private references, or build history. Keep `package.json`
`files` and the allowlist in `scripts/package-smoke.mjs` synchronized.

The README should stand alone on npmjs.com. Command help, examples, exit codes and docs
must describe the implementation, not future plans. Read CLI version from package metadata.

## Releases

Ordinary CI (`ci.yml`) does not publish. The separate `publish.yml` workflow runs
only when a **stable GitHub release is published**, which is the explicit release action.
Pushing commits/tags alone and saving a draft release do not publish to npm.

### Trusted publishing (recommended)

Configure the npm package's trusted publisher as:

- Provider: GitHub Actions
- Organization/user: `mbundgaard`
- Repository: `sts-cli`
- Workflow filename: `publish.yml`
- Environment: leave blank (the workflow does not declare one)

No `NPM_TOKEN` or `NODE_AUTH_TOKEN` secret is required. The Ubuntu publishing job has
`id-token: write` and uses npm 11 with GitHub OIDC. npm requires version 11.5.1+ for
trusted publishing. Provenance is requested on publication. Only GitHub-hosted runners
are used. See [npm's trusted-publisher guide](https://docs.npmjs.com/trusted-publishers/).

Release steps:

1. Bump `package.json` and `package-lock.json` to a new stable version, update the
   changelog, test, and push the reviewed changes. Version `0.3.0` is already published.
2. Create a tag `v<version>` on that reviewed commit and publish its GitHub release.
3. The workflow validates the tagged source on Windows/macOS/Linux with Node 22/24,
   checks that the tag matches both package version fields in the lockfile, and refuses
   a version already present on npm. Registry errors fail closed.
4. It builds and package-tests the publishing checkout, packs it, and publishes the
   archive with provenance using short-lived OIDC authentication.
5. Verify registry metadata and a clean registry install. If a publish outcome is
   uncertain, inspect the registry before re-running anything. Never blindly retry.

Prereleases are deliberately skipped. Published versions are immutable. To release
another build, bump the version; do not rerun publication for an existing version.
Protect release tags and restrict who can publish GitHub releases. A matching workflow
file must exist in the tagged commit. Trusted publishing was verified for `0.3.0`;
local tests alone do not establish that a subsequent remote publication succeeded.

### MunerisTools catalog synchronization

STS owns its public content. `catalog/tool.json` supplies catalog-only metadata;
`scripts/export-catalog.mjs` exports a fixed allowlist of README, changelog and guides
with tab frontmatter, plus generated npm release metadata. Relative documentation
links are anchored to the matching release commit. No duplicate documentation tree is
maintained, and none of these development scripts/catalog inputs enter the npm package.

MunerisTools' `sync-sts.yml` runs hourly or manually. It reads npm's stable `latest`,
requires the matching published GitHub release, checks out that exact tag and runs
its exporter into a fresh staging directory. It verifies npm `gitHead` when provided,
records the resolved commit, rejects version downgrades/moved recorded tags, and
opens or updates a PR replacing **only** `site/tools/sts-cli/`. Human review/merge
triggers the existing Pages deployment. STS main is never used as published docs.

The `0.3.0` tag predates the exporter and is deliberately skipped. The first new
release containing this wiring will supply the new npm catalog entry; its changelog
must have a matching version heading and no unpublished notes under `Unreleased`.
The npm version remains authoritative while the site PR awaits review.

For optional images, add reviewed public PNG/JPEG/GIF/WebP/AVIF files under
`catalog/screenshots/` and list their filenames in `catalog/tool.json`'s `screenshots`
array. Only listed files are copied. Review pixels and metadata for credentials,
tenant/customer data and private paths. No screenshots are currently listed.
Private references, token state, logs, arbitrary repo files and old website screenshots
are not copied. Symlinks and traversing image paths are rejected.

MunerisTools needs GitHub Actions permission to create pull requests (repository
Settings > Actions > General > Workflow permissions). Its own `GITHUB_TOKEN` is used;
no cross-repository PAT or new secret is needed. Scheduled workflows can be delayed
or disabled after inactivity; use **Sync published STS catalog > Run workflow** to
check explicitly. This is reviewed publication, not automatic installation or release.

### Manual fallback

With explicit approval and local npm authentication, a reviewed archive can still be
published using `npm publish <archive.tgz> --access public`. Keep tokens out of source
control and chat. Remove/revoke unneeded long-lived write tokens after trusted publishing
has been verified.

See [CONTRIBUTING.md](../CONTRIBUTING.md) and [SECURITY.md](../SECURITY.md).
