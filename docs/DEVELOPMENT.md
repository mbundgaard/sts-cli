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

Publishing is a separate, explicitly authorized action. GitHub CI does not publish and
requires no npm credentials.

1. Update `package.json` and `package-lock.json` version, and finalize the changelog.
2. Run `npm ci`, `npm test` and `npm run test:package` on supported platforms.
3. Run `npm pack`; review the exact archive and install-test it.
4. Authenticate through local `npm login` or securely configured trusted publishing.
   Never commit registry tokens or pass them in an issue/chat transcript.
5. Verify scope ownership, version availability and release approval.
6. Publish the reviewed archive with `npm publish <archive.tgz> --access public`.
7. Verify registry metadata and a clean registry install. Never blindly retry an uncertain publish.

See [CONTRIBUTING.md](../CONTRIBUTING.md) and [SECURITY.md](../SECURITY.md).
