import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import { request } from '../dist/transport.js';

async function serverFor(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}
for (const encoding of ['gzip', 'deflate', 'br', 'unknown']) {
  for (const [method, status] of [['HEAD', 200], ['HEAD', 400], ['GET', 204], ['GET', 304]]) {
    test(`${method} ${status} ignores ${encoding} representation metadata without a body`, async t => {
      let calls = 0;
      const url = await serverFor(t, (req, res) => {
        calls++; assert.equal(req.method, method);
        res.writeHead(status, { 'Content-Encoding': encoding, 'Simphony-POS-Connected': 'true' });
        res.end();
      });
      const result = await request({ method, url });
      assert.equal(result.status, status);
      assert.equal(result.headers['simphony-pos-connected'], 'true');
      assert.deepEqual(result.body, Buffer.alloc(0));
      assert.equal(calls, 1);
    });
  }
}
for (const [encoding, compress] of [['gzip', gzipSync], ['deflate', deflateSync], ['br', brotliCompressSync]]) {
  test(`${encoding} GET preserves decoded bytes and rejects empty/truncated encoded bodies`, async t => {
    const body = Buffer.from('{ "large": 9007199254740993 }\r\n');
    const encoded = compress(body);
    const url = await serverFor(t, (req, res) => {
      res.writeHead(200, { 'Content-Encoding': encoding });
      res.end(req.url === '/empty' ? Buffer.alloc(0) : req.url === '/truncated' ? encoded.subarray(0, 2) : encoded);
    });
    assert.deepEqual((await request({ method: 'GET', url })).body, body);
    await assert.rejects(request({ method: 'GET', url: url + '/empty' }));
    await assert.rejects(request({ method: 'GET', url: url + '/truncated' }));
  });
}
