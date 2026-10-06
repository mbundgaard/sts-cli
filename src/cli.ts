import { Command, CommanderError } from 'commander';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { AuthClient } from './auth.js';
import { StateStore, tokenSummary, validateState } from './state.js';
import { environments } from './environments.js';
import { endpoints } from './endpoints.js';
import { examples, example } from './examples.js';
import { buildRead, buildCheckRead, buildCheckWrite, baseRequest, simHeaders, integer, decimal, readBody, validateStsUrl, type Options, type BuiltRequest } from './requests.js';
import { httpExit, request, validateUrl } from './transport.js';
import { CliError, Exit, localResult, reportError } from './output.js';
import { networkFailureHint } from './diagnostics.js';
import { parseJson } from './json.js';
import { FeedbackStore, registerFeedback } from './feedback.js';
import { checkForUpdates } from './updates.js';
import { organizationFromClientId } from './identity.js';

const version: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export async function execute(req: BuiltRequest, options: Options): Promise<number> {
  if (options.dryRun) {
    localResult('request preview', { method: req.method, url: req.url, headers: req.headers,
      body: req.body ? parseJson(req.body) : undefined, target: req.target, tlsVerification: !req.insecure });
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
    throw new CliError(Exit.network, `STS request failed: ${(e as Error).message}`, networkFailureHint(e, req));
  }
}
function network(cmd: Command): Command {
  return cmd.option('-q, --quiet', 'Suppress HTTP diagnostics (errors still go to stderr)')
    .option('--timeout <seconds>', 'HTTP timeout in seconds; no automatic retries', value => {
      const n = integer(value); if (n < 1) throw new CliError(Exit.usage, 'Timeout must be positive'); return n;
    }, 30);
}
function api(cmd: Command): Command {
  return network(cmd)
    .option('--sts-url <url>', 'Override saved STS base URL for this call only; explicit http(s):// URL; scheme, port and base path retained; no default port 5443')
    .option('--insecure', 'This call only: disable HTTPS certificate verification after explicit user confirmation; refused for known Oracle cloud/IDM hosts; never saved')
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
  cmd.addHelpText('after', `\nExample:\n  ${text}\n\nEndpoint selection:\n  Without --sts-url: use the saved STS URL.\n  --sts-url https://pos.example:5443/gateway overrides it for one call.\n  Explicit ports are retained; omitted ports use HTTPS 443 / HTTP 80.\n  Endpoint paths are appended to the supplied base path. No local/cloud routing.\n  --insecure explicitly disables certificate checks for this call only.\n  Agents: obtain explicit user confirmation for the endpoint before using --insecure.\n  Fix certificate/CA configuration first; never automatically retry with --insecure.\n  The CLI is noninteractive and does not prompt for confirmation itself.\n  Example for a trusted self-signed host: --sts-url https://pos.example:5443 --insecure\n  Known Oracle cloud hosts and the configured IDM host cannot use --insecure.\n  Neither flag changes saved configuration or affects auth login/refresh.\n  Use only a trusted STS URL: the saved Bearer token is sent to it.\n  --local-sts-ip has been removed; bare hosts are not accepted.\n\nSTS response bodies go unchanged to stdout. HTTP diagnostics go to stderr.\n\nOptional feedback: sts feedback status provides agent guidance and reminder eligibility.\nFor suspected CLI bugs or repeated confusion, offer a sanitized report and ask the user first.\nNever submit credentials, STS payloads or unreviewed logs. Feedback is never automatic.\n`);
}
export function createProgram(store = new StateStore(), setExit: (code: number) => void = code => { process.exitCode = code; }, checkVersion = checkForUpdates): Command {
  const feedback = new FeedbackStore(store.directory, version);
  const runApi = async (req: BuiltRequest, opts: Options) => {
    const code = await execute(req, opts);
    if (code === Exit.ok && !opts.dryRun) {
      try {
        const interactive = !opts.quiet && !!(process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY);
        if (await feedback.recordSuccess(interactive)) process.stderr.write('\nWould you like to share feedback or rate sts (1-5)? Optional: sts feedback submit --message "..." or --rating <1-5>. Skip freely; snooze with sts feedback snooze, or disable with sts feedback config --reminders off.\n');
      } catch {
        // Optional local bookkeeping must never change an STS result or its bytes.
        if (!opts.quiet) process.stderr.write('Feedback reminder state unavailable; STS result unaffected. Inspect with sts feedback status.\n');
      }
    }
    return code;
  };
  const root = new Command('sts').description('Oracle Simphony STS Gen2 CLI. Auth/state + explicit request building + unchanged API response bodies.\nSTS calls: raw stdout, diagnostics on stderr. Local and feedback commands: JSON. No automatic write retries.')
    .version(version).showHelpAfterError().exitOverride();
  root.addHelpText('after', '\nStart: sts auth status; reuse saved tokens or explicitly refresh when needed.\nFirst-time setup only: sts auth env → sts auth config --help → sts auth login\nDiscover: sts endpoints; sts check example --help\nUpdates: agents may run sts version --check once per session; ask before updating.\nSupport: support@muneris.dk (never send passwords, tokens or unreviewed customer data).\nOptional feedback: sts feedback status (agent guidance); ask before submitting.\nState: shared per OS user (Windows: AppData/Roaming/StsCli); no directory override.\nDocs: https://docs.oracle.com/en/industries/food-beverage/simphony/omsstsg2api/\n');
  root.action(() => { root.outputHelp(); });
  registerFeedback(root, feedback);
  root.command('version').description('[read-only] Show installed/runtime versions; --check explicitly queries npm')
    .option('--check', 'Check npm latest with a 5-second timeout; advisory only, never installs updates')
    .addHelpText('after', '\nAgents: check once at session start, not on every STS call. Notify only if newer and ask before updating.\nAn unavailable check is not proof that the installed version is current; continue the user\'s work.\nThe update command is for global npm installs. Respect the installation method in use.\nNo Oracle credentials, configuration or customer data are sent. Normal STS calls never check npm.\nSupport: support@muneris.dk. Never email passwords, tokens or unreviewed customer data.\n')
    .action(async opts => localResult('version', { version, runtime: process.version, platform: process.platform, architecture: process.arch,
      ...(opts.check ? { update: await checkVersion(version) } : {}) }));
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
    .option('--auth-url <url>', 'Explicit IDM base URL').option('--sts-url <url>', 'Save the default STS base URL (http(s)://host[:port][/base-path])')
    .option('--username <user>', 'Oracle API username')
    .option('--client-id <id>', 'Base64 <organization>.<UUID>; organization is derived automatically, original ID preserved')
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
        for (const [option, field] of [['authUrl','authUrl'],['stsUrl','stsUrl'],['username','username'],['clientId','clientId']] as const) {
          if (opts[option] !== undefined) {
            if (!opts[option].trim()) throw new CliError(Exit.usage, `${option} cannot be blank`);
            if (option === 'authUrl') validateUrl(opts[option]);
            if (option === 'stsUrl') validateStsUrl(opts[option]);
            if (option === 'clientId') state.auth.orgName = organizationFromClientId(opts[option]);
            state.auth[field] = opts[option];
          }
        }
        if (opts.authUrl || opts.stsUrl) state.auth.environment = 'custom';
        if (before !== JSON.stringify(state.auth)) delete state.tokens;
      });
      localResult('auth config', { updated: true, configPath: store.file });
    });
  network(auth.command('login').description('[writes-state][network] Oracle authorization-code + PKCE login; password is never stored'))
    .option('--username <user>', 'Override saved username for this login').option('--password <password>', 'Password for this login only; never saved')
    .addHelpText('after', '\nExample: sts auth login --password "<password>"\nAgents: first run sts auth status and reuse saved tokens or explicitly refresh them.\nWhen the user supplies credentials and authorizes login, use --password as requested;\ndo not refuse solely because a password was supplied.\nThe password is used for login only and is not saved by the CLI. Later sessions reuse saved tokens.\nRefresh uses the saved refresh token, not the password. You can rotate the password afterward in Oracle.\nDo not assume it is expired, one-time, or requires changing unless Oracle explicitly reports that.\nHTTP 401 alone does not establish a password-change requirement. Never echo it or include it in feedback.\nArgument values can be visible in shell history/process listings.\n')
    .action(async opts => {
      const password = opts.password;
      if (!password) throw new CliError(Exit.usage, 'Supply --password');
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
  auth.command('restore').description('[writes-state][local] Import a saved StsCli.json; never contacts Oracle')
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
    cmd.action(async (opts: Options) => setExit(await runApi(buildRead(def, await store.load(), opts), opts)));
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
  list.action(async (opts: Options) => setExit(await runApi(buildCheckRead('list', undefined, await store.load(), opts), opts)));
  const get = api(location(check.command('get <checkRef>').description('[read-only][network] Get one check or its printed receipt'))).option('--printed', 'Get the printed receipt response');
  usageExample(get, 'sts check get <checkRef> --location <loc> --rvc <rvc>');
  get.action(async (ref: string, opts: Options) => setExit(await runApi(buildCheckRead('get', ref, await store.load(), opts), opts)));
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
        .option('--charged-tip <amount>', 'Set tender chargedTipTotal; never changes total. HTTP 200 does not prove a tip applied; inspect returned tenders/totals', decimal)
        .option('--pickup-time <iso-time>', 'Override header.pickupTime using property-local wall time, not UTC (e.g. 2026-11-01T14:30:00); responses use UTC; requires POS setup');
    }
    usageExample(cmd, `sts check ${verb}${hasRef ? ' <checkRef>' : ''} --location <loc> --rvc <rvc>${verb !== 'delete' ? ' --employee <emp> --order-type <type> --body order.json' : ''} --dry-run`);
    cmd.action(async (...args: unknown[]) => {
      const ref = hasRef ? args[0] as string : undefined;
      const opts = args[hasRef ? 1 : 0] as Options;
      const body = verb === 'delete' ? {} : await readBody(opts.body);
      setExit(await runApi(buildCheckWrite(verb, ref, await store.load(), opts, body), opts));
    });
  }
  const connection = root.command('connection').description('STS connectivity diagnostics');
  const connectionStatus = api(location(connection.command('status').description('[read-only][network] HEAD connectionStatus; header on stderr, empty body on stdout. Missing header is inconclusive.')));
  usageExample(connectionStatus, 'sts connection status --location <loc> --rvc <rvc>');
  connectionStatus.action(async (opts: Options) => {
    const state = await store.load();
    const req = baseRequest(state, opts, '/api/v1/checks/connectionStatus', simHeaders(state, opts));
    req.method = 'HEAD'; setExit(await runApi(req, opts));
  });
  return root;
}
export async function main(argv = process.argv, store = new StateStore()): Promise<number> {
  let exitCode = 0;
  const root = createProgram(store, code => { exitCode = code; });
  try { await root.parseAsync(argv); return exitCode; }
  catch (e) {
    if (e instanceof CommanderError) return e.exitCode === 0 ? 0 : Exit.usage;
    return reportError(e);
  }
}
