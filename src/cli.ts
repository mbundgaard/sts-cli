import { Command, CommanderError } from 'commander';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { AuthClient } from './auth.js';
import { StateStore, tokenSummary, validateState } from './state.js';
import { environments } from './environments.js';
import { endpoints } from './endpoints.js';
import { examples, example } from './examples.js';
import { buildRead, buildCheckRead, buildCheckWrite, baseRequest, simHeaders, integer, decimal, readBody, type Options, type BuiltRequest } from './requests.js';
import { httpExit, request, validateUrl } from './transport.js';
import { CliError, Exit, localResult, reportError } from './output.js';

const version: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export async function execute(req: BuiltRequest, options: Options): Promise<number> {
  if (options.dryRun) {
    localResult('request preview', { method: req.method, url: req.url, headers: req.headers,
      body: req.body ? JSON.parse(req.body) : undefined, target: req.target, tlsVerification: !req.insecure });
    return Exit.ok;
  }
  try {
    const response = await request(req);
    if (!options.quiet) {
      process.stderr.write(`[${req.method}] HTTP ${response.status}\n`);
      const connected = response.headers['simphony-pos-connected'];
      if (connected !== undefined) process.stderr.write(`Simphony-POS-Connected: ${connected}\n`);
    }
    // The sole STS response output path: bytes unchanged, including non-JSON and errors.
    process.stdout.write(response.body);
    return httpExit(response.status);
  } catch (e) {
    throw new CliError(Exit.network, `STS request failed: ${(e as Error).message}`,
      req.method === 'POST' || req.method === 'DELETE' ? 'Outcome may be uncertain. Do not blindly retry a write; reconcile or reuse its explicit idempotency ID.' : undefined);
  }
}
function network(cmd: Command): Command {
  return cmd.option('-q, --quiet', 'Suppress HTTP diagnostics (errors still go to stderr)')
    .option('--timeout <seconds>', 'HTTP timeout in seconds; no automatic retries', value => {
      const n = integer(value); if (n < 1) throw new CliError(Exit.usage, 'Timeout must be positive'); return n;
    }, 30);
}
function api(cmd: Command): Command {
  return network(cmd).option('--local-sts-ip <ip|url>', 'This request only: local STS; bare host uses HTTPS port 5443; skips TLS certificate validation')
    .option('--dry-run', 'Build request without network; Authorization omitted; no tokens required');
}
function location(cmd: Command, rvc = true): Command {
  cmd.option('--location <loc>', 'Location reference (required; alias: --loc)').option('--loc <loc>', 'Alias for --location');
  cmd.hook('preAction', () => {
    const opts = cmd.opts();
    if (opts.location && opts.loc && opts.location !== opts.loc) throw new CliError(Exit.usage, 'Conflicting --location and --loc values');
    if (opts.loc) cmd.setOptionValue('location', opts.loc);
  });
  if (rvc) cmd.requiredOption('--rvc <rvc>', 'Revenue center reference', integer);
  return cmd;
}
function usageExample(cmd: Command, text: string) {
  cmd.addHelpText('after', `\nExample:\n  ${text}\n\nSTS response bodies go unchanged to stdout. HTTP diagnostics go to stderr.\n`);
}
export function createProgram(store = new StateStore(), setExit: (code: number) => void = code => { process.exitCode = code; }): Command {
  const root = new Command('sts').description('Oracle Simphony STS Gen2 CLI. Auth/state + explicit request building + unchanged API response bodies.\nAPI calls: raw stdout, diagnostics on stderr. Local commands: JSON. No automatic write retries.')
    .version(version).showHelpAfterError().exitOverride();
  root.addHelpText('after', '\nStart: sts auth env → sts auth config --help → sts auth login → sts auth status\nDiscover: sts endpoints; sts check example --help\nState: STS_HOME or the platform user configuration directory.\nDocs: https://docs.oracle.com/en/industries/food-beverage/simphony/omsstsg2api/\n');
  root.action(() => { root.outputHelp(); });
  root.command('version').description('[read-only][local] Show npm CLI and runtime versions').action(() => localResult('version', { version, runtime: process.version, platform: process.platform, architecture: process.arch }));
  root.command('endpoints').description('[read-only][local] List supported GET endpoint definitions and addressing conventions').action(() => localResult('endpoints', endpoints));
  const auth = root.command('auth').description('Configure Oracle IDM, login, refresh and restore saved state');
  const status = async () => {
    const state = await store.load();
    const tokens = tokenSummary(state.tokens);
    localResult('auth status', { state: !tokens.hasAccessToken ? 'no-tokens' : tokens.expired ? 'expired' : tokens.secondsRemaining !== undefined && tokens.secondsRemaining < 300 ? 'expiring-soon' : 'valid',
      configured: !!(state.auth.authUrl && state.auth.clientId && state.auth.orgName && state.auth.username),
      configPath: store.file, tokens });
  };
  auth.action(status);
  auth.command('status').description('[read-only][local] Saved token presence and expiry; does not validate with Oracle').action(status);
  auth.command('show').description('[read-only][local] Configuration and token presence (never full token values)').action(async () => {
    const state = await store.load(); localResult('auth show', { config: state.auth, configPath: store.file, tokens: tokenSummary(state.tokens) });
  });
  auth.command('env').description('[read-only][local] List Oracle environment presets; custom permits explicit URLs').action(() => localResult('auth env', { environments, custom: true }));
  auth.command('config').description('[writes-state][local] Set configuration; changing account/endpoints clears existing tokens')
    .option('--env <environment>', 'mte2, mte3, mte4, mte5, mtu1 or custom')
    .option('--auth-url <url>', 'Explicit IDM base URL').option('--sts-url <url>', 'Explicit cloud STS base URL')
    .option('--org <org>', 'Organization short name').option('--username <user>', 'Oracle API username')
    .option('--client-id <id>', 'OAuth client ID; padding and other significant characters are preserved')
    .action(async opts => {
      if (!Object.keys(opts).length) { const state = await store.load(); localResult('auth config', { config: state.auth, configPath: store.file }); return; }
      await store.mutate(async state => {
        const before = JSON.stringify(state.auth);
        if (opts.env) {
          const preset = environments.find(e => e.key === opts.env.toLowerCase());
          if (!preset && opts.env.toLowerCase() !== 'custom') throw new CliError(Exit.usage, 'Unknown environment; run sts auth env');
          if (preset) Object.assign(state.auth, { environment: preset.key, authUrl: preset.authUrl, stsUrl: preset.stsUrl });
          else state.auth.environment = 'custom';
        }
        for (const [option, field] of [['authUrl','authUrl'],['stsUrl','stsUrl'],['org','orgName'],['username','username'],['clientId','clientId']] as const) {
          if (opts[option] !== undefined) {
            if (!opts[option].trim()) throw new CliError(Exit.usage, `${option} cannot be blank`);
            if (option === 'authUrl' || option === 'stsUrl') validateUrl(opts[option]);
            state.auth[field] = opts[option];
          }
        }
        if (opts.authUrl || opts.stsUrl) state.auth.environment = 'custom';
        if (before !== JSON.stringify(state.auth)) delete state.tokens;
      });
      localResult('auth config', { updated: true, configPath: store.file });
    });
  network(auth.command('login').description('[writes-state][network] Oracle authorization-code + PKCE login; password is never stored'))
    .option('--username <user>', 'Override saved username for this login').option('--password <password>', 'Password; prefer the STS_PASSWORD environment variable')
    .action(async opts => {
      const password = opts.password ?? process.env.STS_PASSWORD;
      if (!password) throw new CliError(Exit.usage, 'Supply STS_PASSWORD or --password');
      await store.mutate(async state => {
        if (opts.username) state.auth.username = opts.username;
        state.tokens = await new AuthClient(opts.timeout * 1000, opts.quiet).login(state.auth, password);
      });
      localResult('auth login', { saved: true, configPath: store.file, tokens: tokenSummary((await store.load()).tokens) });
    });
  network(auth.command('refresh').description('[writes-state][network] Refresh tokens; persist the rotated refresh token atomically'))
    .action(async opts => {
      let rotated = false;
      await store.mutate(async state => {
        const previous = state.tokens?.refreshToken;
        state.tokens = await new AuthClient(opts.timeout * 1000, opts.quiet).refresh(state.auth, state.tokens);
        rotated = state.tokens.refreshToken !== previous;
      });
      localResult('auth refresh', { saved: true, refreshTokenRotated: rotated, configPath: store.file, tokens: tokenSummary((await store.load()).tokens) });
    });
  auth.command('restore').description('[writes-state][local] Import a saved StsCli.json (including legacy .NET state); never contacts Oracle')
    .requiredOption('--file <path>', 'Saved StsCli.json to import').option('--force', 'Replace already-configured destination state')
    .action(async opts => {
      let imported;
      try { imported = validateState(JSON.parse((await readFile(opts.file, 'utf8')).replace(/^\uFEFF/, ''))); }
      catch (e) { throw new CliError(Exit.state, `Could not restore state: ${(e as Error).message}`); }
      await store.mutate(async state => {
        if (!opts.force && (Object.keys(state.auth).length || state.tokens)) throw new CliError(Exit.state, 'Destination is already configured; use --force to replace it');
        for (const key of Object.keys(state)) delete (state as unknown as Record<string, unknown>)[key];
        Object.assign(state, imported);
      });
      localResult('auth restore', { restored: true, configPath: store.file });
    });
  auth.command('logout').description('[writes-state][local] Remove locally saved tokens; does not revoke them at Oracle').action(async () => {
    await store.mutate(async state => { delete state.tokens; });
    localResult('auth logout', { cleared: true, configPath: store.file });
  });
  const groups = new Map<string, Command>();
  for (const def of endpoints) {
    let group = groups.get(def.noun);
    if (!group) { group = root.command(def.noun).description('Read-only STS endpoints; raw response bodies'); groups.set(def.noun, group); }
    const cmd = api(group.command(def.verb).description(`[read-only][network] ${def.description}`));
    if (def.location) location(cmd, !!def.rvc);
    if (def.employeeId) cmd.requiredOption('--employee-id <id>', 'EmployeeId query parameter', integer);
    if (def.path.includes('{menuId}')) cmd.option('--menu-id <id>', 'Override default composite menu ID');
    if (def.paged) cmd.option('--offset <offset>', 'Page offset', integer).option('--limit <limit>', 'Page limit', integer);
    usageExample(cmd, `sts ${def.noun} ${def.verb}${def.location ? ' --location <loc>' : ''}${def.rvc ? ' --rvc <rvc>' : ''}${def.employeeId ? ' --employee-id <id>' : ''}`);
    cmd.action(async (opts: Options) => setExit(await execute(buildRead(def, await store.load(), opts), opts)));
  }
  const check = root.command('check').description('Read, calculate, create and update POS checks; writes are explicitly labelled');
  const ex = check.command('example [kind]').description('[read-only][local] Print a ready-to-edit JSON body; zero IDs MUST be replaced with lookup results')
    .addHelpText('after', `\nKinds: ${Object.keys(examples).join(', ')}\nUse tender list to choose type=serviceTotal (leave open) or type=payment (settle).\nThe same body works for new or add. Employee/order type/location/RVC are flags.\nExample: sts check example service-total > order.json\nEdit all zero IDs before submitting. tip example: total 120 includes tip 20.\n`);
  ex.action((kind = 'service-total') => { process.stdout.write(JSON.stringify(example(kind), null, 2) + '\n'); });
  const list = api(location(check.command('list').description('[read-only][network] List checks in one RVC; use a narrow --since-time with --include-closed')))
    .option('--include-closed', 'Include closed checks').option('--check-number <csv>', 'One or more check numbers')
    .option('--since-time <iso-date>', 'Filter since UTC timestamp or YYYY-MM-DD')
    .option('--employee <ref>', 'Filter checkEmployeeRef', integer).option('--order-type <ref>', 'Filter orderTypeRef', integer).option('--table <name>', 'Filter tableName');
  usageExample(list, 'sts check list --location <loc> --rvc <rvc> --since-time 2026-01-01');
  list.action(async (opts: Options) => setExit(await execute(buildCheckRead('list', undefined, await store.load(), opts), opts)));
  const get = api(location(check.command('get <checkRef>').description('[read-only][network] Get one check or its printed receipt'))).option('--printed', 'Get the printed receipt response');
  usageExample(get, 'sts check get <checkRef> --location <loc> --rvc <rvc>');
  get.action(async (ref: string, opts: Options) => setExit(await execute(buildCheckRead('get', ref, await store.load(), opts), opts)));
  for (const verb of ['calculate','new','add','delete'] as const) {
    const hasRef = verb === 'add' || verb === 'delete';
    const cmd = api(location(check.command(verb + (hasRef ? ' <checkRef>' : '')).description(
      verb === 'calculate' ? '[writes-nothing][network] Calculate without saving a check' : `[DESTRUCTIVE][network] ${verb === 'new' ? 'Create a new check' : verb === 'add' ? 'Add a round to an existing check' : 'Void/delete a check'}`)));
    if (verb !== 'delete') {
      cmd.requiredOption('--employee <ref>', 'Employee submitting this round', integer).requiredOption('--order-type <ref>', 'Order type reference', integer)
        .requiredOption('--body <file|-|json>', 'JSON file, stdin (-), or inline JSON; see check example');
    }
    if (verb === 'new' || verb === 'add') {
      cmd.option('--idempotency-id <uuid>', 'Stable ID + detect-duplicate-request header; reuse only for retries of this same write')
        .option('--charged-tip <amount>', 'Set tender chargedTipTotal; never changes tender total or verifies the response', decimal)
        .option('--pickup-time <iso-time>', 'Override header.pickupTime (requires appropriate POS setup)');
    }
    usageExample(cmd, `sts check ${verb}${hasRef ? ' <checkRef>' : ''} --location <loc> --rvc <rvc>${verb !== 'delete' ? ' --employee <emp> --order-type <type> --body order.json' : ''} --dry-run`);
    cmd.action(async (...args: unknown[]) => {
      const ref = hasRef ? args[0] as string : undefined;
      const opts = args[hasRef ? 1 : 0] as Options;
      const body = verb === 'delete' ? {} : await readBody(opts.body);
      setExit(await execute(buildCheckWrite(verb, ref, await store.load(), opts, body), opts));
    });
  }
  const connection = root.command('connection').description('STS connectivity diagnostics');
  const connectionStatus = api(location(connection.command('status').description('[read-only][network] HEAD connectionStatus; header on stderr, empty body on stdout. Missing header is inconclusive.')));
  usageExample(connectionStatus, 'sts connection status --location <loc> --rvc <rvc>');
  connectionStatus.action(async (opts: Options) => {
    const state = await store.load();
    const req = baseRequest(state, opts, '/api/v1/checks/connectionStatus', simHeaders(state, opts));
    req.method = 'HEAD'; setExit(await execute(req, opts));
  });
  return root;
}
export async function main(argv = process.argv): Promise<number> {
  let exitCode = 0;
  const root = createProgram(new StateStore(), code => { exitCode = code; });
  try { await root.parseAsync(argv); return exitCode; }
  catch (e) {
    if (e instanceof CommanderError) return e.exitCode === 0 ? 0 : Exit.usage;
    return reportError(e);
  }
}
