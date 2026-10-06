import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { type Endpoint } from './endpoints.js';
import { parseJson, isRawJson } from './json.js';
import { CliError, Exit } from './output.js';
import { type State, tokenSummary } from './state.js';
import { validateUrl, type HttpRequest } from './transport.js';

export interface Options {
  location?: string; rvc?: number; employee?: number; orderType?: number; employeeId?: number;
  menuId?: string; offset?: number; limit?: number; stsUrl?: string; insecure?: boolean; body?: string;
  dryRun?: boolean; quiet?: boolean; timeout?: number; idempotencyId?: string;
  chargedTip?: number; pickupTime?: string; includeClosed?: boolean; checkNumber?: string;
  sinceTime?: string; table?: string; printed?: boolean;
}
export interface BuiltRequest extends HttpRequest {
  target: 'saved' | 'override';
  insecureAllowed: boolean;
}
export function integer(value: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new CliError(Exit.usage, `Expected a non-negative integer: ${value}`);
  return Number(value);
}
export function decimal(value: string): number {
  if (!/^\d+(\.\d+)?$/.test(value) || !Number.isFinite(Number(value))) throw new CliError(Exit.usage, `Expected a non-negative decimal: ${value}`);
  return Number(value);
}
export function required(options: Options, keys: (keyof Options)[]) {
  const missing = keys.filter(k => options[k] === undefined || options[k] === '');
  if (missing.length) throw new CliError(Exit.usage, `Required: ${missing.map(k => '--' + k.replace(/[A-Z]/g, c => '-' + c.toLowerCase())).join(', ')}`);
}
export function validateStsUrl(value: string): URL {
  if (value !== value.trim() || !/^https?:\/\//i.test(value)) throw new CliError(Exit.usage, 'STS URL must be an explicit http:// or https:// URL without surrounding whitespace');
  const url = validateUrl(value);
  if (value.includes('?') || value.includes('#')) throw new CliError(Exit.usage, 'STS base URL must not contain a query string or fragment');
  return url;
}
function canUseInsecure(url: URL, state: State): boolean {
  if (url.protocol !== 'https:') return false;
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  const oracleDomains = ['oraclecloud.com', 'oraclemicros.com', 'oraclerestaurants.com', 'oracleindustry.com'];
  if (oracleDomains.some(domain => hostname === domain || hostname.endsWith('.' + domain))) return false;
  if (state.auth.authUrl) {
    try {
      if (hostname === validateUrl(state.auth.authUrl).hostname.toLowerCase().replace(/\.$/, '')) return false;
    } catch {
      // An invalid IDM URL cannot establish that this host is safe to bypass.
      return false;
    }
  }
  return true;
}
export function baseRequest(state: State, options: Options, apiPath: string, headers: Record<string, string> = {}): BuiltRequest {
  if (!state.auth.orgName) throw new CliError(Exit.notConfigured, 'Client ID not configured; run sts auth config --client-id <id>');
  const base = options.stsUrl ?? state.auth.stsUrl;
  if (base === undefined) throw new CliError(Exit.notConfigured, 'STS URL not configured; supply --sts-url or run sts auth config');
  const url = validateStsUrl(base);
  const insecureAllowed = canUseInsecure(url, state);
  if (options.insecure && !insecureAllowed) {
    throw new CliError(Exit.usage, url.protocol !== 'https:'
      ? '--insecure requires an HTTPS STS URL'
      : '--insecure cannot disable TLS verification for Oracle cloud or the configured IDM host; IDM configuration must also be valid');
  }
  if (!options.dryRun) {
    if (!state.tokens?.accessToken) throw new CliError(Exit.noTokens, 'No access token saved; run sts auth login');
    if (tokenSummary(state.tokens).expired) throw new CliError(Exit.auth, 'Access token expired; run sts auth refresh');
  }
  return { method: 'GET', url: `${base.replace(/\/+$/, '')}/${apiPath.replace(/^\//, '')}`,
    headers: { Accept: 'application/json', ...(!options.dryRun ? { Authorization: `Bearer ${state.tokens!.accessToken}` } : {}), ...headers },
    target: options.stsUrl !== undefined ? 'override' : 'saved', insecure: options.insecure === true, insecureAllowed,
    timeoutMs: (options.timeout ?? 30) * 1000 };
}
export function simHeaders(state: State, options: Options): Record<string, string> {
  required(options, ['location','rvc']);
  return { 'Simphony-OrgShortName': state.auth.orgName!, 'Simphony-LocRef': options.location!, 'Simphony-RvcRef': String(options.rvc) };
}
export function buildRead(def: Endpoint, state: State, options: Options): BuiltRequest {
  required(options, [...(def.location ? ['location' as const] : []), ...(def.rvc ? ['rvc' as const] : []), ...(def.employeeId ? ['employeeId' as const] : [])]);
  const params: Record<string, string> = { org: state.auth.orgName ?? '', loc: options.location ?? '',
    rvc: String(options.rvc ?? ''), menuId: options.menuId || `${state.auth.orgName}:${options.location}:${options.rvc}` };
  let apiPath = def.path.replace(/\{(\w+)\}/g, (_, key: string) => encodeURIComponent(params[key] ?? ''));
  const query = new URLSearchParams();
  if (def.addressing === 'query') {
    query.set('OrgShortName', state.auth.orgName ?? '');
    query.set('LocRef', options.location!);
    if (def.rvc) query.set('RvcRef', String(options.rvc));
    if (def.employeeId) query.set('EmployeeId', String(options.employeeId));
  }
  if (def.paged) {
    if (options.offset !== undefined) query.set('offset', String(options.offset));
    if (options.limit !== undefined) query.set('limit', String(options.limit));
  }
  if (query.size) apiPath += '?' + query;
  return baseRequest(state, options, apiPath, def.addressing === 'header' ? simHeaders(state, options) : {});
}
export function buildCheckRead(verb: string, checkRef: string | undefined, state: State, options: Options): BuiltRequest {
  const headers = simHeaders(state, options);
  let apiPath = '/api/v1/checks';
  if (verb === 'get') {
    if (!checkRef?.trim()) throw new CliError(Exit.usage, 'A check reference is required');
    apiPath += '/' + encodeURIComponent(checkRef) + (options.printed ? '/printed' : '');
  } else {
    const query = new URLSearchParams();
    if (options.includeClosed) query.set('includeClosed', 'true');
    if (options.checkNumber) {
      const numbers = options.checkNumber.split(',').map(s => s.trim());
      numbers.forEach(integer);
      query.set('checkNumbers', numbers.join(','));
    }
    if (options.sinceTime) {
      const since = /^\d{4}-\d{2}-\d{2}$/.test(options.sinceTime) ? options.sinceTime + 'T00:00:00Z' : options.sinceTime;
      if (!Number.isFinite(Date.parse(since))) throw new CliError(Exit.usage, 'Invalid --since-time');
      query.set('sinceTime', since);
    }
    if (options.orderType !== undefined) query.set('orderTypeRef', String(options.orderType));
    if (options.employee !== undefined) query.set('checkEmployeeRef', String(options.employee));
    if (options.table !== undefined) query.set('tableName', options.table);
    if (query.size) apiPath += '?' + query;
  }
  return baseRequest(state, options, apiPath, headers);
}
export async function readBody(input?: string): Promise<Record<string, unknown>> {
  if (!input) throw new CliError(Exit.usage, 'Supply --body <file|-|inline-json>; see sts check example');
  let raw: string;
  if (input === '-') {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    raw = Buffer.concat(chunks).toString('utf8');
  } else if (input.trimStart().startsWith('{')) raw = input;
  else {
    try { raw = await readFile(input, 'utf8'); }
    catch { throw new CliError(Exit.usage, 'Could not read --body file'); }
  }
  try {
    const value = parseJson(raw.replace(/^\uFEFF/, ''));
    if (!value || typeof value !== 'object' || Array.isArray(value) || isRawJson(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new CliError(Exit.usage, '--body must be a JSON object'); }
}
export function buildCheckWrite(verb: 'new' | 'add' | 'calculate' | 'delete', checkRef: string | undefined, state: State, options: Options, input: Record<string, unknown> = {}): BuiltRequest {
  required(options, verb === 'delete' ? ['location','rvc'] : ['location','rvc','employee','orderType']);
  if (['add','delete'].includes(verb) && !checkRef?.trim()) throw new CliError(Exit.usage, 'A check reference is required');
  let apiPath = '/api/v1/checks';
  if (verb === 'calculate') apiPath += '/calculator';
  if (verb === 'add' || verb === 'delete') apiPath += '/' + encodeURIComponent(checkRef!);
  if (verb === 'add') apiPath += '/round';
  const req = baseRequest(state, options, apiPath, simHeaders(state, options));
  req.method = verb === 'delete' ? 'DELETE' : 'POST';
  if (verb === 'delete') return req;
  // A JSON round-trip preserves raw numeric values; structuredClone loses their brand.
  const root = parseJson(JSON.stringify(input)) as Record<string, unknown>;
  if (root.header !== undefined && (!root.header || typeof root.header !== 'object' || Array.isArray(root.header) || isRawJson(root.header))) throw new CliError(Exit.usage, 'header must be a JSON object');
  const header = (root.header ?? {}) as Record<string, unknown>;
  let id = randomUUID().replaceAll('-', '');
  if (options.idempotencyId !== undefined) {
    if (!/^(?:[a-fA-F0-9]{32}|[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12})$/.test(options.idempotencyId)) throw new CliError(Exit.usage, '--idempotency-id must be a UUID or 32 hex characters');
    id = options.idempotencyId.replaceAll('-', '').toLowerCase();
    req.headers!['Simphony-Features'] = 'detect-duplicate-request';
  }
  Object.assign(header, { orgShortName: state.auth.orgName, locRef: options.location, rvcRef: options.rvc,
    checkEmployeeRef: options.employee, orderTypeRef: options.orderType, idempotencyId: id });
  if (verb === 'add') header.checkRef = checkRef;
  else delete header.checkRef;
  if (options.pickupTime !== undefined) {
    if (!Number.isFinite(Date.parse(options.pickupTime))) throw new CliError(Exit.usage, 'Invalid --pickup-time');
    header.pickupTime = options.pickupTime;
  }
  if (options.chargedTip !== undefined) {
    if (!Array.isArray(root.tenders) || root.tenders.length !== 1 || !root.tenders[0] || typeof root.tenders[0] !== 'object' || Array.isArray(root.tenders[0]) || isRawJson(root.tenders[0])) {
      throw new CliError(Exit.usage, '--charged-tip requires exactly one tender object');
    }
    root.tenders[0].chargedTipTotal = options.chargedTip;
  }
  root.header = header;
  req.headers!['Content-Type'] = 'application/json';
  req.body = JSON.stringify(root);
  return req;
}
