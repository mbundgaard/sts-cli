import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync, deflateSync, brotliCompressSync, createGzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { once } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { ResponseCollector, INLINE_MAX_BYTES, INLINE_MAX_LINES } from '../dist/responses.js';
import { request, requestInto } from '../dist/transport.js';
import { setup, tokens } from './response-helpers.mjs';
const args = ['menu', 'get', '--location', 'synthetic', '--rvc', '1'];
const digest = data => createHash('sha256').update(data).digest('hex');
const folders = directory => fs.readdir(path.join(directory, 'responses')).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
async function authorized(t, handler) {
  const s = await setup(t, handler); await s.store.mutate(async state => { state.tokens = tokens(); }); return s;
}
async function collectorFor(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sts-responses-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, collector: new ResponseCollector(directory) };
}
async function checkReceipt(result, s, body, status = 200) {
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.delivery, 'file'); assert.equal(receipt.httpStatus, status);
  assert.equal(receipt.bytes, body.length); assert.equal(receipt.sha256, digest(body));
  assert.ok(path.isAbsolute(receipt.path)); assert.equal(fileURLToPath(receipt.uri), receipt.path);
  assert.ok(receipt.path.startsWith(path.join(s.directory, 'responses') + path.sep));
  assert.deepEqual(await fs.readFile(receipt.path), body);
  assert.deepEqual(await fs.readdir(path.dirname(receipt.path)), ['response.body']);
  assert.ok(Buffer.byteLength(result.stdout) < 4096); assert.match(receipt.instructions, /instead of loading it all/);
  assert.doesNotMatch(result.stdout, /synthetic-access|synthetic-refresh|PRIVATE-RECORD/);
  return receipt;
}

for (const [label, body, saved] of [
  ['empty', Buffer.alloc(0), false],
  ['exact byte limit', Buffer.alloc(16384, 120), false],
  ['one byte over', Buffer.alloc(16385, 120), true],
  ['500 terminated lines', Buffer.from('x\r\n'.repeat(500)), false],
  ['500 unterminated lines', Buffer.from('x\n'.repeat(499) + 'x'), false],
  ['501 lines', Buffer.from('x\n'.repeat(500) + 'x'), true],
  ['UTF-8 bytes not characters', Buffer.from('ø'.repeat(8193)), true],
]) test(`automatic response delivery: ${label}`, async t => {
  assert.equal(INLINE_MAX_BYTES, 16384); assert.equal(INLINE_MAX_LINES, 500);
  const s = await authorized(t, (_, res) => res.end(body));
  const state = await fs.readFile(s.store.file, 'utf8');
  const result = await s.run([...args, '--quiet']);
  assert.equal(result.code, 0, result.stderr); assert.equal(result.stderr, ''); assert.equal(s.calls.length, 1);
  if (saved) await checkReceipt(result, s, body);
  else { assert.equal(result.stdout, body.toString()); assert.deepEqual(await folders(s.directory), []); }
  assert.equal(await fs.readFile(s.store.file, 'utf8'), state);
});

for (const [encoding, encode] of [['gzip', gzipSync], ['deflate', deflateSync], ['br', brotliCompressSync]]) {
  test(`${encoding}: thresholds apply to decoded bytes, exact large bytes are saved`, async t => {
    const body = Buffer.from('{"precise":9007199254740993,"text":"' + 'PRIVATE-RECORD'.repeat(2000) + '"}\r\n');
    const encoded = encode(body); assert.ok(encoded.length < INLINE_MAX_BYTES);
    const s = await authorized(t, (_, res) => { res.setHeader('Content-Encoding', encoding); res.end(encoded); });
    const result = await s.run(args); assert.equal(result.code, 0, result.stderr); await checkReceipt(result, s, body);
  });
}

for (const [status, code] of [[302, 11], [400, 11], [401, 9], [403, 11], [500, 11]]) {
  test(`large HTTP ${status} body is preserved in a file and exit ${code} remains unchanged`, async t => {
    const body = Buffer.concat([Buffer.from('PRIVATE-RECORD'), Buffer.alloc(20000, 255)]);
    const s = await authorized(t, (_, res) => { res.writeHead(status, { Location: '/must-not-follow' }); res.end(body); });
    const result = await s.run([...args, '--quiet']); assert.equal(result.code, code); assert.equal(result.stderr, '');
    await checkReceipt(result, s, body, status); assert.equal(s.calls.length, 1);
  });
}

test('every catalog read endpoint uses the same shared delivery handler', async t => {
  const { endpoints } = await import('../dist/endpoints.js');
  const body = Buffer.alloc(20000, 120);
  const s = await authorized(t, (_, res) => res.end(body));
  const files = new Set();
  for (const endpoint of endpoints) {
    const result = await s.run([endpoint.noun, endpoint.verb,
      ...(endpoint.location ? ['--location', 'synthetic'] : []),
      ...(endpoint.rvc ? ['--rvc', '1'] : []),
      ...(endpoint.employeeId ? ['--employee-id', '1'] : [])]);
    assert.equal(result.code, 0, result.stderr); files.add((await checkReceipt(result, s, body)).path);
  }
  assert.equal(files.size, endpoints.length); assert.equal(s.calls.length, endpoints.length);
});

test('check reads, calculator and writes share delivery without retries; HEAD stays empty', async t => {
  const body = Buffer.alloc(20000, 120);
  const s = await authorized(t, (req, res) => {
    req.resume(); res.setHeader('Simphony-POS-Connected', 'true'); res.end(body);
  });
  const scope = ['--location', 'synthetic', '--rvc', '1'];
  const commands = [
    ['check', 'list'], ['check', 'get', 'synthetic-check'], ['check', 'get', 'synthetic-check', '--printed'],
    ['check', 'calculate', '--employee', '1', '--order-type', '1', '--body', '{}'],
    ['check', 'new', '--employee', '1', '--order-type', '1', '--body', '{}'],
    ['check', 'add', 'synthetic-check', '--employee', '1', '--order-type', '1', '--body', '{}'],
    ['check', 'delete', 'synthetic-check'],
  ];
  for (const command of commands) {
    const result = await s.run([...command, ...scope]);
    assert.equal(result.code, 0, result.stderr); await checkReceipt(result, s, body);
    assert.match(result.stderr, /Simphony-POS-Connected: true/);
  }
  const before = (await folders(s.directory)).length;
  const head = await s.run(['connection', 'status', ...scope]);
  assert.equal(head.code, 0); assert.equal(head.stdout, ''); assert.match(head.stderr, /Simphony-POS-Connected: true/);
  assert.equal((await folders(s.directory)).length, before); assert.equal(s.calls.length, commands.length + 1);
});

test('write response storage failure warns about outcome and never repeats the write', async t => {
  const s = await authorized(t, (req, res) => { req.resume(); res.end(Buffer.alloc(20000, 120)); });
  await fs.writeFile(path.join(s.directory, 'responses'), 'blocked');
  const result = await s.run(['check', 'new', '--location', 'synthetic', '--rvc', '1', '--employee', '1', '--order-type', '1', '--body', '{}']);
  assert.equal(result.code, 1); assert.equal(result.stdout, ''); assert.equal(s.calls.length, 1);
  assert.match(result.stderr, /Outcome may be uncertain/); assert.match(result.stderr, /Do not blindly retry/);
});

test('saved responses are private and filenames contain no caller identifiers', async t => {
  const s = await authorized(t, (_, res) => res.end(Buffer.alloc(20000, 120)));
  const result = await s.run(args); const file = JSON.parse(result.stdout).path;
  assert.doesNotMatch(file, /synthetic|test-enterprise|menu-items/);
  if (process.platform === 'win32') {
    const system = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
    const sid = execFileSync(path.join(system, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).match(/S-1-\d+(?:-\d+)+/)[0];
    const acl = execFileSync(path.join(system, 'icacls.exe'), [path.dirname(file), '/findsid', '*' + sid], { encoding: 'utf8' });
    assert.ok(acl.includes(path.dirname(file)));
    assert.doesNotMatch(execFileSync(path.join(system, 'icacls.exe'), [path.dirname(file)], { encoding: 'utf8' }), /\(I\)/);
  } else {
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);
  }
});

for (const failure of ['disconnect', 'corrupt-gzip', 'unsupported-encoding']) test(`${failure} produces no receipt and removes partial files`, async t => {
  const body = Buffer.alloc(256 * 1024, 120);
  const s = await authorized(t, (_, res) => {
    if (failure === 'disconnect') {
      res.writeHead(200, { 'Content-Length': body.length + 100 }); res.write(body); setTimeout(() => res.destroy(), 200);
    } else if (failure === 'corrupt-gzip') {
      const encoded = gzipSync(body); encoded[encoded.length - 8] ^= 255;
      res.setHeader('Content-Encoding', 'gzip'); res.end(encoded);
    } else { res.setHeader('Content-Encoding', 'unsupported'); res.end(body); }
  });
  const result = await s.run(args); assert.equal(result.code, 10, result.stderr); assert.equal(result.stdout, '');
  assert.deepEqual(await folders(s.directory), []); assert.equal(s.calls.length, 1);
});

test('unwritable response storage fails locally without falling back to a large stdout body', async t => {
  const s = await authorized(t, (_, res) => res.end(Buffer.alloc(20000, 120)));
  await fs.writeFile(path.join(s.directory, 'responses'), 'block-directory-creation');
  const result = await s.run(args); assert.equal(result.code, 1); assert.equal(result.stdout, '');
  assert.match(result.stderr, /Cannot store STS response securely/); assert.equal(s.calls.length, 1);
});

for (const method of ['writeFile', 'sync', 'rename']) test(`response ${method} failure removes unpublished data`, async t => {
  const { directory, collector } = await collectorFor(t);
  if (method === 'rename') t.mock.method(fs, 'rename', async () => { throw Error('synthetic failure'); });
  else {
    const open = fs.open;
    t.mock.method(fs, 'open', async (...args) => {
      const handle = await open(...args); t.mock.method(handle, method, async () => { throw Error('synthetic failure'); }); return handle;
    });
  }
  syncBuiltinESMExports();
  try {
    await assert.rejects(async () => {
      await pipeline(Readable.from([Buffer.alloc(20000)]), collector); await collector.complete();
    }, error => error.exitCode === 1);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await collector.discard(); }
  assert.deepEqual(await folders(directory), []);
});

test('aborting a streamed response cleans its partial file', async t => {
  const { directory, collector } = await collectorFor(t);
  const s = await setup(t, (_, res) => {
    const timer = setInterval(() => res.write(Buffer.alloc(65536)), 20);
    res.on('close', () => clearInterval(timer));
  });
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 500);
  try { await assert.rejects(requestInto({ url: s.url, method: 'POST', signal: controller.signal }, collector)); }
  finally { clearTimeout(timer); await collector.discard(); }
  assert.deepEqual(await folders(directory), []); assert.equal(s.calls.length, 1);
});

test('buffered auth transport remains separate from automatic data exports', async t => {
  const body = Buffer.alloc(20000, 120);
  const s = await setup(t, (_, res) => res.end(body));
  assert.deepEqual((await request({ url: s.url, method: 'POST' })).body, body);
  assert.deepEqual(await folders(s.directory), []);
});

test('concurrent calls retain separate complete files without changing auth state', async t => {
  const s = await authorized(t, (_, res) => res.end(Buffer.alloc(20000, 120)));
  const before = await fs.readFile(s.store.file, 'utf8');
  const results = await Promise.all(Array.from({ length: 4 }, () => s.run(args)));
  const files = new Set();
  for (const result of results) {
    assert.equal(result.code, 0, result.stderr);
    files.add((await checkReceipt(result, s, Buffer.alloc(20000, 120))).path);
  }
  assert.equal(files.size, 4); assert.equal(await fs.readFile(s.store.file, 'utf8'), before);
});

test('close failure is local and the unpublished file can still be cleaned', async t => {
  const { directory, collector } = await collectorFor(t);
  const open = fs.open;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args), close = handle.close.bind(handle); let failed = false;
    t.mock.method(handle, 'close', async () => { if (!failed) { failed = true; throw Error('synthetic close failure'); } await close(); });
    return handle;
  }); syncBuiltinESMExports();
  try {
    await pipeline(Readable.from([Buffer.alloc(20000)]), collector);
    await assert.rejects(collector.complete(), error => error.exitCode === 1);
    await collector.discard();
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.deepEqual(await folders(directory), []);
});

test('failed partial-file cleanup is reported, never hidden as completed output', async t => {
  const { directory, collector } = await collectorFor(t);
  await pipeline(Readable.from([Buffer.alloc(20000)]), collector);
  t.mock.method(fs, 'rm', async () => { throw Error('synthetic cleanup failure'); }); syncBuiltinESMExports();
  try {
    await assert.rejects(collector.discard(), error => error.exitCode === 1 && /cleanup failed/.test(error.message) && error.hint.includes(directory));
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await collector.discard(); }
});

for (const gzip of [false, true]) test(`128 MiB ${gzip ? 'compressed' : 'plain'} response streams to disk with exact hash and small stdout`, { timeout: 90000 }, async t => {
  const block = Buffer.alloc(64 * 1024, 120), count = 2048;
  const hash = createHash('sha256'); for (let i = 0; i < count; i++) hash.update(block);
  const s = await authorized(t, async (_, res) => {
    if (gzip) res.setHeader('Content-Encoding', 'gzip');
    const output = gzip ? createGzip() : res; if (gzip) output.pipe(res);
    for (let i = 0; i < count; i++) if (!output.write(block)) await once(output, 'drain');
    output.end();
  });
  const script = `import {main} from './dist/cli.js'; import {StateStore} from './dist/state.js';
    const before=process.memoryUsage().rss;
    process.exitCode=await main(['node','sts',...${JSON.stringify(args)},'--quiet','--timeout','60'],new StateStore(${JSON.stringify(s.directory)}));
    console.error(JSON.stringify({before,after:process.memoryUsage().rss,peak:process.resourceUsage().maxRSS*1024}));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script]);
  let stdout = '', stderr = ''; child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  const [code] = await once(child, 'close'); assert.equal(code, 0, stderr);
  const receipt = JSON.parse(stdout), memory = JSON.parse(stderr);
  assert.equal(receipt.bytes, block.length * count); assert.equal(receipt.sha256, hash.digest('hex'));
  assert.ok(stdout.length < 4096); assert.equal((await fs.stat(receipt.path)).size, receipt.bytes);
  // Hash the saved bytes in a stream, not by loading the export into the test process.
  const actual = createHash('sha256'); const file = await fs.open(receipt.path);
  for await (const chunk of file.createReadStream()) actual.update(chunk);
  assert.equal(actual.digest('hex'), receipt.sha256);
  t.diagnostic(`response=128 MiB; RSS baseline=${Math.round(memory.before / 1048576)} MiB; peak=${Math.round(memory.peak / 1048576)} MiB`);
  // Allow platform/allocator variance, but catch reintroducing ~256 MiB response copies.
  if (memory.peak > 0) assert.ok(memory.peak - memory.before < 128 * 1024 * 1024, JSON.stringify(memory));
});
