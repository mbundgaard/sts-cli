import http, { type IncomingHttpHeaders } from 'node:http';
import https from 'node:https';
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';
import { CliError, Exit } from './output.js';

export interface HttpRequest {
  url: string; method: string; headers?: Record<string, string>;
  body?: string; insecure?: boolean; timeoutMs?: number;
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

// No redirects, no retries, no JSON parsing. Buffered bytes avoid printing partial
// responses as if complete when a socket fails. Body decoding only undoes HTTP compression.
export async function request(input: HttpRequest): Promise<HttpResponse> {
  const url = validateUrl(input.url);
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': 'StsCli-TypeScript/0.2', 'Accept-Encoding': 'identity', ...input.headers };
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(url, { method: input.method, headers, rejectUnauthorized: !input.insecure }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(Buffer.from(chunk)));
      res.on('error', reject);
      res.on('aborted', () => reject(new Error('Response interrupted; request outcome may be uncertain')));
      res.on('end', () => {
        try {
          let body = Buffer.concat(chunks);
          const encoding = res.headers['content-encoding']?.toLowerCase();
          if (encoding === 'gzip') body = gunzipSync(body);
          else if (encoding === 'deflate') body = inflateSync(body);
          else if (encoding === 'br') body = brotliDecompressSync(body);
          else if (encoding && encoding !== 'identity') throw new Error(`Unsupported content encoding: ${encoding}`);
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
        } catch (error) { reject(error); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('HTTP request timed out; write outcome may be uncertain')), input.timeoutMs ?? 30_000);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
    req.end(input.body);
  });
}
export function httpExit(status: number): number {
  if (status >= 200 && status < 300) return Exit.ok;
  if (status === 401) return Exit.auth;
  return Exit.api;
}
