import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { StateStore } from '../dist/state.js';
import { clientIdFor } from './fixtures.mjs';
export const clientId = clientIdFor('test-enterprise');
export const tokens = () => ({ accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', codeVerifier: 'a'.repeat(43), obtainedAt: new Date().toISOString(), expiresIn: 3600 });
export async function setup(t, handler = (_, res) => { res.writeHead(500); res.end(); }) {
  const directory = await mkdtemp(path.join(tmpdir(), 'sts-response-tests-'));
  const errors = [], calls = [];
  const server = http.createServer((req, res) => {
    calls.push(req.url);
    Promise.resolve().then(() => handler(req, res)).catch(error => { errors.push(error); res.writeHead(500); res.end(); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); if (errors.length) throw errors[0]; });
  const url = `http://127.0.0.1:${server.address().port}`;
  const store = new StateStore(directory);
  await store.save({ auth: { authUrl: url, stsUrl: url, clientId, orgName: 'test-enterprise', username: 'Synthetic_User' } });
  const run = args => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['tests/cli-runner.mjs', directory, ...args]);
    const out = [], err = [];
    child.stdout.on('data', b => out.push(b)); child.stderr.on('data', b => err.push(b));
    child.on('error', reject); child.on('close', code => resolve({ code, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() }));
  });
  return { directory, store, url, calls, run };
}
export async function form(req) {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  return new URLSearchParams(Buffer.concat(chunks).toString());
}
