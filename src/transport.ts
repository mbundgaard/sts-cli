import http, { type IncomingHttpHeaders } from 'node:http';
import https from 'node:https';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CliError, Exit } from './output.js';

export interface HttpRequest {
  url: string; method: string; headers?: Record<string, string>;
  body?: string; insecure?: boolean; timeoutMs?: number; signal?: AbortSignal;
}
export interface HttpResponse { status: number; headers: IncomingHttpHeaders; body: Buffer }
export function validateUrl(input: string): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new CliError(Exit.usage, 'Expected an absolute HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new CliError(Exit.usage, 'URL must use HTTP(S), without embedded credentials or a fragment');
  }
  return url;
}

// Shared HTTP plumbing. Decoding is transport processing, never JSON interpretation.
// The caller's sink controls storage; data calls never accumulate the entire body here.
export async function requestInto(input: HttpRequest, sink: Writable): Promise<Omit<HttpResponse, 'body'>> {
  const url = validateUrl(input.url);
  const timeout = input.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeout) || timeout <= 0) throw new CliError(Exit.usage, 'Timeout must be positive');
  const headers = { 'User-Agent': 'StsCli-TypeScript/0.4', 'Accept-Encoding': 'identity', ...input.headers };
  const client = url.protocol === 'https:' ? https : http;
  const req = client.request(url, { method: input.method, headers, rejectUnauthorized: !input.insecure, signal: input.signal });
  // A timeout can destroy the sink before headers arrive and pipeline attaches listeners.
  const ignoreEarlyError = () => {};
  sink.on('error', ignoreEarlyError);
  const response = new Promise<http.IncomingMessage>((resolve, reject) => {
    req.once('response', resolve); req.once('error', reject);
  });
  const timer = setTimeout(() => {
    const error = new Error('HTTP request timed out; request outcome may be uncertain');
    req.destroy(error); sink.destroy(error);
  }, timeout);
  try {
    req.end(input.body);
    const res = await response;
    const encoding = res.headers['content-encoding']?.trim().toLowerCase();
    const noBody = input.method.toUpperCase() === 'HEAD' || res.statusCode === 204 || res.statusCode === 304;
    let decoder: Transform | undefined;
    if (noBody) decoder = new Transform({ transform(_chunk, _encoding, done) { done(); } });
    else if (encoding === 'gzip') decoder = createGunzip();
    else if (encoding === 'deflate') decoder = createInflate();
    else if (encoding === 'br') decoder = createBrotliDecompress();
    else if (encoding && encoding !== 'identity') throw new Error('Unsupported content encoding');
    if (decoder) await pipeline(res, decoder, sink, { signal: input.signal });
    else await pipeline(res, sink, { signal: input.signal });
    return { status: res.statusCode ?? 0, headers: res.headers };
  } catch (error) {
    req.destroy(); sink.destroy(); throw error;
  } finally {
    clearTimeout(timer);
    // Keep the harmless sink error listener through asynchronous destruction.
  }
}

// Auth requires internal parsing of the complete token response. It never uses data
// delivery receipts or export files. Existing auth callers keep this buffered API.
export async function request(input: HttpRequest): Promise<HttpResponse> {
  const chunks: Buffer[] = [];
  const sink = new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
  const response = await requestInto(input, sink);
  return { ...response, body: Buffer.concat(chunks) };
}
export function httpExit(status: number): number {
  if (status >= 200 && status < 300) return Exit.ok;
  if (status === 401) return Exit.auth;
  return Exit.api;
}
