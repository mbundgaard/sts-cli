import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Command } from 'commander';
import { CliError, Exit, localResult } from './output.js';
import { request, validateUrl } from './transport.js';

export const feedbackDefaultUrl = 'https://feedback.muneris.cloud/';
const product = '@muneris/sts-cli';
const day = 86_400_000;
const categories = ['general', 'bug', 'feature'] as const;
type Category = typeof categories[number];
interface Payload {
  schemaVersion: 1; product: string; productVersion: string; category: Category;
  message?: string; rating?: number; submittedAtUtc: string; submissionId: string;
}
interface Submission {
  payload: Payload; url: string; status: 'sending' | 'failed' | 'sent'; attempts: number;
  lastHttpStatus?: number;
}
interface FeedbackState {
  schemaVersion: 1; baseUrl?: string; reminders: boolean; successfulRequests: number;
  startedAt?: string; lastAskedAt?: string; snoozedUntil?: string; submissions: Submission[];
}
interface SubmitOptions { message?: string; rating?: number; category?: string; url?: string; timeout?: number; quiet?: boolean; dryRun?: boolean; new?: boolean }
const agentGuidance = [
  'Feedback is optional. Ask the user before submitting; never treat an error or reminder as consent.',
  'For direct or sensitive security support, contact support@muneris.dk instead of ordinary feedback. Never email passwords, tokens or unreviewed customer data.',
  'When a reminder is due, offer a brief message or a 1-5 rating, with skip/snooze/disable choices. Record the question with sts feedback asked. Do not repeatedly ask after a decline.',
  'If you notice a likely CLI bug or recurring agent confusion, you may offer a report even before a reminder is due. Distinguish suspected bugs, configuration issues and verified defects. Do not interrupt urgent work or repeat a declined suggestion.',
  'Propose a short sanitized summary: expected behavior, actual behavior, minimal reproduction and uncertainty. Show the intended text/rating to the user and get approval before sending.',
  'Never attach STS requests/responses, credentials, cookies, account identifiers, customer data or console dumps. No diagnostic collection is automatic.',
  'Use sts feedback submit --dry-run to preview, then submit the approved content. Failure preserves it locally; retry the saved ID only after warning that another row may be created.',
];
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function timestamp(value: unknown): boolean { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function uuid(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value); }
export function feedbackUrl(value: string): string {
  const url = validateUrl(value);
  if (value !== value.trim() || value.includes('?') || value.includes('#') ||
      (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new CliError(Exit.usage, 'Feedback URL requires HTTPS (HTTP is allowed only on loopback), without credentials, query or fragment');
  }
  return url.toString().replace(/\/+$/, '') + '/';
}
function validPayload(value: unknown): value is Payload {
  if (!object(value) || value.schemaVersion !== 1 || value.product !== product || typeof value.productVersion !== 'string' || !value.productVersion.trim() ||
      !categories.includes(value.category as Category) || !timestamp(value.submittedAtUtc) || !uuid(value.submissionId)) return false;
  if (Object.keys(value).some(k => !['schemaVersion','product','productVersion','category','message','rating','submittedAtUtc','submissionId'].includes(k))) return false;
  if (value.message !== undefined && (typeof value.message !== 'string' || !value.message.trim())) return false;
  if (value.rating !== undefined && (typeof value.rating !== 'number' || !Number.isInteger(value.rating) || value.rating < 1 || value.rating > 5)) return false;
  return value.message !== undefined || value.rating !== undefined;
}
function encode(payload: Payload): string {
  const body = JSON.stringify(payload);
  // Leave headroom under the service's 98,304-byte and 32,768-code-unit ceilings.
  if (body.length > 24_000 || Buffer.byteLength(body, 'utf8') > 65_536) throw new CliError(Exit.usage, 'Feedback is too long; shorten it (client limits: 24,000 UTF-16 code units and 65,536 UTF-8 bytes, including metadata)');
  return body;
}
function contentKey(p: Payload): string { return JSON.stringify([p.productVersion, p.category, p.message, p.rating]); }
function due(state: FeedbackState, now: Date): boolean {
  if (!state.reminders || !state.startedAt || (state.snoozedUntil && Date.parse(state.snoozedUntil) > now.getTime())) return false;
  const eligible = state.successfulRequests >= 25 || now.getTime() - Date.parse(state.startedAt) >= 7 * day;
  return eligible && (!state.lastAskedAt || now.getTime() - Date.parse(state.lastAskedAt) >= 30 * day);
}
function timeout(value: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 120) throw new CliError(Exit.usage, 'Feedback timeout must be 1-120 seconds');
  return Number(value);
}
function rating(value: string): number {
  if (!/^[1-5]$/.test(value)) throw new CliError(Exit.usage, 'Feedback rating must be 1-5');
  return Number(value);
}

// Separate from authentication state: usage counters never rewrite or transmit tokens.
export class FeedbackStore {
  constructor(private readonly stateDirectory: string, readonly version: string) {}
  get directory(): string { return path.join(this.stateDirectory, 'feedback'); }
  get file(): string { return path.join(this.directory, 'Feedback.json'); }
  private async load(): Promise<FeedbackState> {
    let text: string;
    try { text = await readFile(this.file, 'utf8'); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, reminders: true, successfulRequests: 0, submissions: [] };
      throw new CliError(Exit.state, `Cannot read private feedback state at ${this.file}`);
    }
    try {
      const s: unknown = JSON.parse(text);
      if (!object(s) || s.schemaVersion !== 1 || typeof s.reminders !== 'boolean' || !Number.isSafeInteger(s.successfulRequests) || (s.successfulRequests as number) < 0 || !Array.isArray(s.submissions)) throw new Error();
      for (const key of ['startedAt','lastAskedAt','snoozedUntil']) if (s[key] !== undefined && !timestamp(s[key])) throw new Error();
      if ((s.successfulRequests as number) > 0 && !s.startedAt) throw new Error();
      if (s.baseUrl !== undefined && (typeof s.baseUrl !== 'string' || feedbackUrl(s.baseUrl) !== s.baseUrl)) throw new Error();
      const ids = new Set<string>();
      for (const record of s.submissions) {
        if (!object(record) || !validPayload(record.payload) || typeof record.url !== 'string' || feedbackUrl(record.url) !== record.url ||
            !['sending','failed','sent'].includes(record.status as string) || !Number.isSafeInteger(record.attempts) || (record.attempts as number) < 1 ||
            (record.lastHttpStatus !== undefined && (!Number.isInteger(record.lastHttpStatus) || (record.lastHttpStatus as number) < 100 || (record.lastHttpStatus as number) > 599))) throw new Error();
        encode(record.payload);
        if (ids.has(record.payload.submissionId)) throw new Error();
        ids.add(record.payload.submissionId);
      }
      return s as unknown as FeedbackState;
    } catch { throw new CliError(Exit.state, `Invalid private feedback state at ${this.file}; it has not been reset`, 'Inspect locally; do not paste the file into chat or a report.'); }
  }
  private async save(state: FeedbackState): Promise<void> {
    const temp = `${this.file}.${randomUUID()}.tmp`;
    let complete = false;
    try {
      const file = await open(temp, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(state, null, 2) + '\n'); await file.sync(); complete = true; }
      finally { await file.close(); }
      await rename(temp, this.file);
    } catch {
      throw new CliError(Exit.state, 'Could not persist private feedback state; do not blindly resubmit', complete ? `A complete private recovery copy is at ${temp}. Inspect it before restoring ${this.file}; a POST may already have succeeded.` : 'No complete recovery copy is available. Inspect saved submission state before retrying.');
    } finally { if (!complete) await unlink(temp).catch(() => {}); }
  }
  private async locked<T>(action: (state: FeedbackState) => Promise<T>): Promise<T> {
    const lockPath = this.file + '.lock';
    let lock;
    try { await mkdir(this.directory, { recursive: true, mode: 0o700 }); lock = await open(lockPath, 'wx', 0o600); }
    catch { throw new CliError(Exit.state, 'Feedback state is busy or unavailable; no new submission was started', `If interrupted, confirm no feedback operation is running before removing ${lockPath}. Do not remove a live lock.`); }
    try { await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); return await action(await this.load()); }
    finally { await lock.close(); await unlink(lockPath); }
  }
  private url(state: FeedbackState, override?: string): string { return feedbackUrl(override ?? state.baseUrl ?? feedbackDefaultUrl); }
  async status(now = new Date()) {
    const s = await this.load();
    return { baseUrl: this.url(s), remindersEnabled: s.reminders, feedbackDue: due(s, now), successfulRequests: s.successfulRequests,
      startedAt: s.startedAt, lastAskedAt: s.lastAskedAt, snoozedUntil: s.snoozedUntil,
      policy: { firstAfterDays: 7, orSuccessfulRequests: 25, repeatAfterDays: 30 },
      savedSubmissionCount: s.submissions.length,
      recentSubmissions: s.submissions.slice(-10).map(r => ({ submissionId: r.payload.submissionId, status: r.status, attempts: r.attempts, lastHttpStatus: r.lastHttpStatus })),
      agentGuidance, commands: { preview: 'sts feedback submit --message "<approved summary>" --category bug --dry-run', submit: 'sts feedback submit --message "<approved feedback>"', rating: 'sts feedback submit --rating 5', asked: 'sts feedback asked', snooze: 'sts feedback snooze --days 30', disable: 'sts feedback config --reminders off' } };
  }
  async configure(options: { url?: string; reminders?: string }, now = new Date()) {
    if (options.reminders !== undefined && !['on','off'].includes(options.reminders)) throw new CliError(Exit.usage, '--reminders must be on or off');
    const baseUrl = options.url === undefined ? undefined : feedbackUrl(options.url);
    await this.locked(async s => {
      if (baseUrl !== undefined) s.baseUrl = baseUrl;
      if (options.reminders !== undefined) {
        if (options.reminders === 'on' && (!s.reminders || !s.startedAt)) { s.startedAt = now.toISOString(); s.successfulRequests = 0; }
        s.reminders = options.reminders === 'on';
      }
      await this.save(s);
    });
    return this.status(now);
  }
  async asked(snoozeDays?: number, now = new Date()): Promise<void> {
    if (snoozeDays !== undefined && (!Number.isInteger(snoozeDays) || snoozeDays < 1 || snoozeDays > 365)) throw new CliError(Exit.usage, 'Snooze days must be 1-365');
    await this.locked(async s => {
      s.lastAskedAt = now.toISOString();
      if (snoozeDays !== undefined) s.snoozedUntil = new Date(now.getTime() + snoozeDays * day).toISOString();
      await this.save(s);
    });
  }
  async recordSuccess(interactive: boolean, now = new Date()): Promise<boolean> {
    if (!(await this.load()).reminders) return false;
    return this.locked(async s => {
      if (!s.reminders) return false;
      s.startedAt ??= now.toISOString();
      s.successfulRequests = Math.min(Number.MAX_SAFE_INTEGER, s.successfulRequests + 1);
      const ask = interactive && due(s, now);
      if (ask) s.lastAskedAt = now.toISOString();
      await this.save(s);
      return ask;
    });
  }
  private find(s: FeedbackState, id: string): Submission {
    if (!uuid(id)) throw new CliError(Exit.usage, 'Expected the saved feedback submission UUID');
    const record = s.submissions.find(r => r.payload.submissionId === id);
    if (!record) throw new CliError(Exit.state, 'Saved feedback submission not found');
    return record;
  }
  async show(id: string) { return this.find(await this.load(), id); }
  async discard(id: string) {
    await this.locked(async s => { this.find(s, id); s.submissions = s.submissions.filter(r => r.payload.submissionId !== id); await this.save(s); });
    return { submissionId: id, deletedLocally: true, deletedFromService: false };
  }
  async health(options: SubmitOptions) {
    const url = this.url(await this.load(), options.url);
    const timeoutMs = timeout(String(options.timeout ?? 15)) * 1000;
    let response;
    try { response = await request({ method: 'GET', url: url + 'health', headers: { Accept: 'application/json' }, timeoutMs }); }
    catch { throw new CliError(Exit.network, 'Feedback health request failed; no feedback was submitted'); }
    if (response.status !== 200) throw new CliError(Exit.api, `Feedback health returned HTTP ${response.status}`);
    try { if (JSON.parse(response.body.toString('utf8')).status !== 'ok') throw new Error(); }
    catch { throw new CliError(Exit.api, 'Unexpected feedback health response'); }
    return { status: 'ok', storageVerified: false, baseUrl: url };
  }
  async submit(options: SubmitOptions) {
    const payload: Payload = { schemaVersion: 1, product, productVersion: this.version, category: (options.category ?? 'general') as Category,
      ...(options.message !== undefined ? { message: options.message } : {}), ...(options.rating !== undefined ? { rating: options.rating } : {}),
      submittedAtUtc: new Date().toISOString(), submissionId: randomUUID() };
    if (!validPayload(payload)) throw new CliError(Exit.usage, 'Supply a nonblank --message and/or --rating 1-5; category must be general, bug or feature');
    encode(payload);
    if (options.dryRun) return { dryRun: true, baseUrl: this.url(await this.load(), options.url), payload, notice: 'Preview only. Ask the user to approve the content before submitting; omit credentials and private/customer data.' };
    return this.locked(async s => {
      const url = this.url(s, options.url);
      const existing = [...s.submissions].reverse().find(r => r.url === url && contentKey(r.payload) === contentKey(payload));
      if (existing && !options.new) {
        s.lastAskedAt = new Date().toISOString(); await this.save(s);
        if (existing.status === 'sent') return { submitted: true, alreadySubmitted: true, submissionId: existing.payload.submissionId };
        throw new CliError(Exit.state, 'Identical feedback is already saved; no additional POST was made', this.retryHint(existing));
      }
      const record: Submission = { payload, url, status: 'sending', attempts: 1 };
      s.submissions.push(record); s.lastAskedAt = new Date().toISOString();
      return this.send(s, record, options);
    });
  }
  async retry(id: string, options: SubmitOptions) {
    return this.locked(async s => {
      const record = this.find(s, id);
      s.lastAskedAt = new Date().toISOString();
      if (record.status === 'sent') { await this.save(s); return { submitted: true, alreadySubmitted: true, submissionId: id }; }
      // Retries stay on the original destination and reuse the original bytes/ID.
      record.status = 'sending'; record.attempts++; delete record.lastHttpStatus;
      return this.send(s, record, options);
    });
  }
  private retryHint(record: Submission): string {
    return `Feedback is saved locally as ${record.payload.submissionId}. Review with sts feedback show ${record.payload.submissionId}. Delivery may have succeeded; another POST creates another row. Only after user approval, run sts feedback retry ${record.payload.submissionId}. This preserves the ID for traceability, not server deduplication.`;
  }
  private async send(s: FeedbackState, record: Submission, options: SubmitOptions) {
    const body = encode(record.payload);
    const timeoutMs = timeout(String(options.timeout ?? 15)) * 1000;
    await this.save(s); // Persist intent and content before any network side effect.
    if (!options.quiet) process.stderr.write('[feedback] Submitting approved feedback; no automatic retry...\n');
    let response;
    try { response = await request({ method: 'POST', url: record.url, body, timeoutMs,
      headers: { 'Content-Type': 'application/json; charset=utf-8', Accept: 'application/json' } }); }
    catch {
      record.status = 'failed'; await this.save(s);
      throw new CliError(Exit.network, 'Feedback submission failed or timed out; delivery is uncertain', this.retryHint(record));
    }
    record.lastHttpStatus = response.status;
    if (response.status !== 204) {
      record.status = 'failed'; await this.save(s);
      const meaning: Record<number, string> = { 400: 'request rejected', 413: 'storage limits exceeded; shorten feedback', 503: 'service/storage unavailable' };
      throw new CliError(Exit.api, `Feedback HTTP ${response.status}: ${meaning[response.status] ?? 'unexpected response'}`, this.retryHint(record));
    }
    record.status = 'sent'; await this.save(s);
    if (!options.quiet) process.stderr.write('[feedback] Submitted successfully (HTTP 204).\n');
    return { submitted: true, submissionId: record.payload.submissionId };
  }
}

export function registerFeedback(root: Command, store: FeedbackStore): void {
  const group = root.command('feedback').description('Optional product feedback and ratings; no STS data collection; never auto-submits')
    .addHelpText('after', '\nFor agents: sts feedback status returns reminder eligibility and consent/privacy guidance.\nOffer suspected CLI bugs or repeated agent confusion as optional reports; show a sanitized summary and ask before sending.\nDirect support: support@muneris.dk. Never email passwords, tokens or unreviewed customer data.\nQuick start: sts feedback submit --rating 5 --message "Helpful CLI" --dry-run\nAfter user approval, omit --dry-run to send. No authentication or STS configuration needed.\nReminders are on by default for new profiles. Disable: sts feedback config --reminders off\nFirst reminder: after 7 days or 25 successful STS calls; subsequent reminders: at least 30 days apart.\n');
  group.action(() => group.outputHelp());
  const network = (cmd: Command, url = true) => {
    if (url) cmd.option('--url <base-url>', 'Override feedback base URL; otherwise saved URL, then deployed default');
    return cmd.option('--timeout <seconds>', 'Bounded timeout (1-120); no automatic retries', timeout, 15).option('-q, --quiet', 'Suppress progress messages');
  };
  group.command('status').description('[read-only][local] Reminder state, saved submission IDs and agent guidance; no network').action(async () => localResult('feedback status', await store.status()));
  group.command('config').description('[writes-state][local] Feedback URL and local reminders; separate from auth state')
    .option('--url <base-url>', 'Save feedback base URL; HTTPS or HTTP loopback, no credentials/query/fragment')
    .option('--reminders <on|off>', 'Enable or disable local reminder tracking; default on for new profiles')
    .action(async opts => localResult('feedback config', Object.keys(opts).length ? await store.configure(opts) : await store.status()));
  group.command('asked').description('[writes-state][local] Agent: record that you asked; suppress reminders for 30 days; sends nothing')
    .action(async () => { await store.asked(); localResult('feedback asked', { recorded: true, submitted: false }); });
  group.command('snooze').description('[writes-state][local] Snooze reminders; sends nothing').option('--days <days>', '1-365 days (30-day post-question cooldown still applies)', value => Number(value), 30)
    .action(async opts => { await store.asked(opts.days); localResult('feedback snooze', { snoozed: true, submitted: false }); });
  network(group.command('health').description('[read-only][network] Service liveness only, NOT storage validation'))
    .action(async opts => localResult('feedback health', await store.health(opts)));
  network(group.command('submit').description('[writes-feedback][network] Send only user-approved text/rating; saved locally before POST'))
    .option('--message <text>', 'User-approved feedback; never include secrets or customer data')
    .option('--rating <1-5>', 'Optional user-selected rating', rating).option('--category <category>', 'general, bug or feature', 'general')
    .option('--dry-run', 'Preview exact fields locally; no save or network')
    .option('--new', 'Intentionally create another identical submission; NOT a retry')
    .addHelpText('after', '\nUse --message and/or --rating. Duplicate identical content to the same URL is blocked locally unless --new is explicit.\nA failed submission remains saved. Use feedback show <id> to review, then feedback retry <id> only after approval.\nRetries reuse the original payload/ID/URL but may create another row; the server does NOT deduplicate.\nNo STS requests/responses, tokens, cookies, usernames or reminder counters are automatically included.\n')
    .action(async opts => localResult('feedback submit', await store.submit(opts)));
  network(group.command('retry <submissionId>').description('[writes-feedback][network] Explicitly retry saved feedback; may create duplicates; original ID/body/URL retained'), false)
    .action(async (id, opts) => localResult('feedback retry', await store.retry(id, opts)));
  group.command('show <submissionId>').description('[read-only][local] Show private saved content and destination for review; do not share unreviewed output')
    .action(async id => localResult('feedback show', await store.show(id)));
  group.command('discard <submissionId>').description('[writes-state][local] Remove local content/history only; cannot delete a server row; removes local duplicate protection')
    .action(async id => localResult('feedback discard', await store.discard(id)));
}
