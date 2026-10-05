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
docs/            User and developer guides
scripts/         Package validation utilities
src/             TypeScript implementation
tests/           Offline tests and mock servers
```

Generated `dist/`, `node_modules/`, and package archives are ignored. `StsCli.json` belongs in the platform user directory or a private `STS_HOME`, never in the project.

## Implementation map

| Module | Responsibility |
|---|---|
| `cli.ts` | Command tree, help, handlers |
| `auth.ts` | PKCE, cookies, login, refresh |
| `state.ts` | State paths, validation, compatibility, locked atomic saves |
| `endpoints.ts` | Declarative read endpoint catalog |
| `requests.ts` | Input validation and request construction |
| `transport.ts` | HTTP(S), compression decoding, raw body transport |
| `examples.ts` | Minimal structured request templates |
| `output.ts` | Local JSON results, errors and exit codes |

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

The initial port checked endpoint paths, methods and addressing against Oracle's
published specification. IDM authentication endpoints are not part of that STS Swagger;
the PKCE implementation follows the previously tested client flow. Fresh mocked login
and real token refresh are separate forms of validation.

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
   changelog, test, and push the reviewed changes. Version `0.2.0` is already published.
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
file must exist in the tagged commit. The workflow itself must still be exercised on a
future approved release; local tests do not establish that npm's OIDC exchange works.

### Manual fallback

With explicit approval and local npm authentication, a reviewed archive can still be
published using `npm publish <archive.tgz> --access public`. Keep tokens out of source
control and chat. Remove/revoke unneeded long-lived write tokens after trusted publishing
has been verified.

See [CONTRIBUTING.md](../CONTRIBUTING.md) and [SECURITY.md](../SECURITY.md).
