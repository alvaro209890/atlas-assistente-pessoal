import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createAtlasServer } from './serve.mjs';

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function close(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function request(port, { path = '/', method = 'GET', headers = {}, chunks = [] } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const body = [];
      res.on('data', (chunk) => body.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(body).toString('utf8'),
      }));
    });
    req.on('error', reject);
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
}

describe('Atlas local production server', () => {
  let directory;

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), 'atlas-serve-'));
    await writeFile(join(directory, 'index.html'), '<!doctype html><h1>Atlas SPA</h1>');
    await writeFile(join(directory, 'app.js'), 'globalThis.atlas = true;');
  });

  after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('strips query strings from static paths and keeps the SPA fallback uncached', async () => {
    const server = createAtlasServer({ webDir: directory, logger: { error() {} } });
    const port = await listen(server);
    try {
      const asset = await request(port, { path: '/app.js?v=release-1' });
      assert.equal(asset.status, 200);
      assert.equal(asset.body, 'globalThis.atlas = true;');
      assert.match(asset.headers['cache-control'], /immutable/);

      const route = await request(port, {
        path: '/workspace/today?tab=inbox',
        headers: { Accept: 'text/html' },
      });
      assert.equal(route.status, 200);
      assert.match(route.body, /Atlas SPA/);
      assert.match(route.headers['cache-control'], /no-store/);

      const head = await request(port, { path: '/app.js?v=release-1', method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(head.body, '');
      assert.equal(Number(head.headers['content-length']), Buffer.byteLength('globalThis.atlas = true;'));
    } finally {
      await close(server);
    }
  });

  it('blocks encoded traversal and malformed path encodings', async () => {
    const server = createAtlasServer({ webDir: directory, logger: { error() {} } });
    const port = await listen(server);
    try {
      const traversal = await request(port, { path: '/%2e%2e%2foutside-secret.txt' });
      assert.equal(traversal.status, 403);
      assert.doesNotMatch(traversal.body, /Atlas SPA/);

      const malformed = await request(port, { path: '/%E0%A4%A' });
      assert.equal(malformed.status, 400);
    } finally {
      await close(server);
    }
  });

  it('streams proxy requests, preserves query and cookies, and removes connection-scoped headers', async () => {
    const upstream = createServer((req, res) => {
      const body = [];
      req.on('data', (chunk) => body.push(chunk));
      req.on('end', () => {
        res.setHeader('Set-Cookie', [
          'atlas_session=one; Path=/; HttpOnly; SameSite=Lax',
          'atlas_refresh=two; Path=/; HttpOnly; SameSite=Strict',
        ]);
        res.setHeader('X-Upstream', 'atlas-api');
        res.end(JSON.stringify({
          method: req.method,
          url: req.url,
          body: Buffer.concat(body).toString('utf8'),
          forwardedHost: req.headers['x-forwarded-host'],
          forwardedProto: req.headers['x-forwarded-proto'],
          removedHeader: req.headers['x-remove-me'] ?? null,
        }));
      });
    });
    const upstreamPort = await listen(upstream);
    const server = createAtlasServer({
      webDir: directory,
      apiUrl: `http://127.0.0.1:${upstreamPort}`,
      logger: { error() {} },
    });
    const port = await listen(server);
    try {
      const response = await request(port, {
        path: '/api/echo?source=whatsapp',
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
          Connection: 'x-remove-me',
          'X-Remove-Me': 'must-not-reach-upstream',
        },
        chunks: ['mensagem ', 'em streaming'],
      });
      assert.equal(response.status, 200);
      const payload = JSON.parse(response.body);
      assert.equal(payload.method, 'POST');
      assert.equal(payload.url, '/api/echo?source=whatsapp');
      assert.equal(payload.body, 'mensagem em streaming');
      assert.match(payload.forwardedHost, /^127\.0\.0\.1:/);
      assert.equal(payload.forwardedProto, 'http');
      assert.equal(payload.removedHeader, null);
      assert.equal(response.headers['x-upstream'], 'atlas-api');
      assert.deepEqual(response.headers['set-cookie'], [
        'atlas_session=one; Path=/; HttpOnly; SameSite=Lax',
        'atlas_refresh=two; Path=/; HttpOnly; SameSite=Strict',
      ]);

      const readiness = await request(port, { path: '/ready' });
      assert.equal(readiness.status, 200);
      assert.equal(JSON.parse(readiness.body).url, '/ready');
    } finally {
      await close(server);
      await close(upstream);
    }
  });

  it('rejects oversized declared and streamed bodies and maps an unavailable upstream to 502', async () => {
    const upstream = createServer((req, res) => {
      req.resume();
      req.on('end', () => res.end('ok'));
    });
    const upstreamPort = await listen(upstream);
    const server = createAtlasServer({
      webDir: directory,
      apiUrl: `http://127.0.0.1:${upstreamPort}`,
      maxBodyBytes: 8,
      logger: { error() {} },
    });
    const port = await listen(server);
    try {
      const declared = await request(port, {
        path: '/api/upload',
        method: 'POST',
        headers: { 'Content-Length': '20' },
        chunks: ['12345678901234567890'],
      });
      assert.equal(declared.status, 413);

      const streamed = await request(port, {
        path: '/api/upload',
        method: 'POST',
        chunks: ['12345', '67890'],
      });
      assert.equal(streamed.status, 413);
    } finally {
      await close(server);
      await close(upstream);
    }

    const unavailable = createServer();
    const unavailablePort = await listen(unavailable);
    await close(unavailable);
    const gateway = createAtlasServer({
      webDir: directory,
      apiUrl: `http://127.0.0.1:${unavailablePort}`,
      logger: { error() {} },
    });
    const gatewayPort = await listen(gateway);
    try {
      const response = await request(gatewayPort, { path: '/health' });
      assert.equal(response.status, 502);
      assert.equal(response.body, 'Bad Gateway');
    } finally {
      await close(gateway);
    }
  });
});
