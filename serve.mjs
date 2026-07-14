// Servidor de produção local Atlas — serve frontend + proxy /api → backend.
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const DEFAULT_PORT = 3200;
const DEFAULT_API_URL = 'http://127.0.0.1:3100';
const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_PROXY_TIMEOUT_MS = 120_000;
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

class HttpError extends Error {
  constructor(statusCode, publicMessage) {
    super(publicMessage);
    this.statusCode = statusCode;
    this.publicMessage = publicMessage;
  }
}

class RequestBodyTooLargeError extends Error {}

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(`Invalid positive integer configuration: ${value}`);
  }
  return parsed;
}

function isContained(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function isMissingFile(error) {
  return ['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error?.code);
}

function requestHasBody(method = 'GET') {
  return !['GET', 'HEAD'].includes(method.toUpperCase());
}

function sendText(res, statusCode, message, headers = {}) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = Buffer.from(message);
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

function parseRequestUrl(req) {
  try {
    return new URL(req.url ?? '/', 'http://atlas.local');
  } catch {
    throw new HttpError(400, 'Bad Request');
  }
}

function decodePathname(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, 'Bad Request');
  }
  if (decoded.includes('\0') || decoded.includes('\\')) {
    throw new HttpError(400, 'Bad Request');
  }
  return decoded;
}

async function resolveStaticFile(webRoot, pathname) {
  const decoded = decodePathname(pathname);
  const candidate = resolve(webRoot, decoded.replace(/^\/+/, '') || 'index.html');
  if (!isContained(webRoot, candidate)) throw new HttpError(403, 'Forbidden');
  const canonicalRoot = await realpath(webRoot);
  const canonical = await realpath(candidate);
  if (!isContained(canonicalRoot, canonical)) throw new HttpError(403, 'Forbidden');
  const info = await stat(canonical);
  if (!info.isFile()) {
    const error = new Error('Not a file');
    error.code = 'EISDIR';
    throw error;
  }
  return { path: canonical, size: info.size };
}

async function streamStaticFile(req, res, file, fallback) {
  const extension = extname(file.path).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME_TYPES[extension] ?? 'application/octet-stream',
    'Content-Length': file.size,
    'Cache-Control': fallback
      ? 'no-store, no-cache, must-revalidate'
      : extension === '.html'
        ? 'no-cache'
        : 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  await pipeline(createReadStream(file.path), res);
}

async function serveStatic(req, res, requestUrl, webRoot) {
  if (!['GET', 'HEAD'].includes(req.method ?? 'GET')) {
    req.resume();
    sendText(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
    return;
  }

  try {
    const file = await resolveStaticFile(webRoot, requestUrl.pathname);
    await streamStaticFile(req, res, file, false);
    return;
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }

  const acceptsHtml = String(req.headers.accept ?? '').includes('text/html');
  const routeLike = extname(requestUrl.pathname) === '';
  if (!acceptsHtml && !routeLike) {
    sendText(res, 404, 'Not Found');
    return;
  }

  let fallback;
  try {
    fallback = await resolveStaticFile(webRoot, '/index.html');
  } catch (error) {
    if (isMissingFile(error)) throw new HttpError(500, 'Frontend build is unavailable');
    throw error;
  }
  await streamStaticFile(req, res, fallback, true);
}

function connectionHeaderNames(value) {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function buildProxyRequestHeaders(req, hasBody) {
  const headers = new Headers();
  const blocked = new Set([
    ...HOP_BY_HOP_HEADERS,
    ...connectionHeaderNames(req.headers.connection),
    'host',
  ]);
  for (const [name, rawValue] of Object.entries(req.headers)) {
    if (blocked.has(name.toLowerCase()) || rawValue === undefined) continue;
    headers.set(name, Array.isArray(rawValue) ? rawValue.join(', ') : rawValue);
  }
  if (!hasBody) headers.delete('content-length');

  const remoteAddress = req.socket.remoteAddress;
  const forwardedFor = req.headers['x-forwarded-for'];
  if (remoteAddress) {
    headers.set('x-forwarded-for', forwardedFor ? `${forwardedFor}, ${remoteAddress}` : remoteAddress);
  }
  if (req.headers.host) headers.set('x-forwarded-host', req.headers.host);
  const forwardedProto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]?.trim();
  headers.set('x-forwarded-proto', forwardedProto || (req.socket.encrypted ? 'https' : 'http'));
  return headers;
}

function applyProxyResponseHeaders(res, response) {
  const blocked = new Set([
    ...HOP_BY_HOP_HEADERS,
    ...connectionHeaderNames(response.headers.get('connection')),
  ]);
  for (const [name, value] of response.headers) {
    const normalized = name.toLowerCase();
    if (normalized === 'set-cookie' || blocked.has(normalized)) continue;
    res.setHeader(name, value);
  }
  const cookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [];
  if (cookies.length > 0) res.setHeader('Set-Cookie', cookies);
  else if (response.headers.get('set-cookie')) res.setHeader('Set-Cookie', response.headers.get('set-cookie'));
  if (!res.hasHeader('X-Content-Type-Options')) res.setHeader('X-Content-Type-Options', 'nosniff');
}

function createLimitedBody(req, maxBodyBytes, onExceeded) {
  let received = 0;
  let exceeded = false;
  const stream = new Transform({
    transform(chunk, _encoding, callback) {
      if (exceeded) {
        callback();
        return;
      }
      received += Buffer.byteLength(chunk);
      if (received > maxBodyBytes) {
        exceeded = true;
        onExceeded();
        callback();
        return;
      }
      callback(null, chunk);
    },
  });
  req.pipe(stream);
  return {
    stream,
    exceeded: () => exceeded,
    discardRemaining() {
      req.unpipe(stream);
      stream.destroy();
      req.resume();
    },
  };
}

async function proxyApi(req, res, requestUrl, options) {
  const { apiUrl, fetchImpl, maxBodyBytes, proxyTimeoutMs } = options;
  const target = new URL(`${requestUrl.pathname}${requestUrl.search}`, apiUrl);
  if (target.origin !== apiUrl.origin) throw new HttpError(400, 'Bad Request');

  const hasBody = requestHasBody(req.method);
  const contentLength = Number(req.headers['content-length']);
  if (hasBody && Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
    req.resume();
    sendText(res, 413, 'Payload Too Large');
    return;
  }

  const controller = new AbortController();
  const limitedBody = hasBody
    ? createLimitedBody(req, maxBodyBytes, () => controller.abort(new RequestBodyTooLargeError()))
    : null;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('Proxy timeout'));
  }, proxyTimeoutMs);
  timeout.unref?.();
  const abortForClient = () => controller.abort(new Error('Client aborted request'));
  req.once('aborted', abortForClient);

  try {
    const response = await fetchImpl(target, {
      method: req.method,
      headers: buildProxyRequestHeaders(req, hasBody),
      ...(limitedBody ? { body: limitedBody.stream, duplex: 'half' } : {}),
      redirect: 'manual',
      signal: controller.signal,
    });
    applyProxyResponseHeaders(res, response);
    res.writeHead(response.status);
    if (req.method === 'HEAD' || response.body === null) {
      res.end();
      return;
    }
    await pipeline(Readable.fromWeb(response.body), res);
  } catch (error) {
    if (limitedBody?.exceeded()) {
      limitedBody.discardRemaining();
      sendText(res, 413, 'Payload Too Large');
      return;
    }
    if (req.aborted || res.destroyed) return;
    if (timedOut) {
      sendText(res, 504, 'Gateway Timeout');
      return;
    }
    throw new HttpError(502, 'Bad Gateway');
  } finally {
    clearTimeout(timeout);
    req.off('aborted', abortForClient);
  }
}

function reportError(logger, error) {
  if (logger && typeof logger.error === 'function') logger.error(error);
}

export function createAtlasServer({
  apiUrl = process.env.API_URL ?? DEFAULT_API_URL,
  webDir = process.env.WEB_DIR ?? join(import.meta.dirname, 'apps', 'web', 'dist'),
  maxBodyBytes = positiveInteger(process.env.PROXY_MAX_BODY_BYTES, DEFAULT_MAX_BODY_BYTES),
  proxyTimeoutMs = positiveInteger(process.env.PROXY_TIMEOUT_MS, DEFAULT_PROXY_TIMEOUT_MS),
  fetchImpl = globalThis.fetch,
  logger = console,
} = {}) {
  const normalizedApiUrl = new URL(apiUrl);
  if (!['http:', 'https:'].includes(normalizedApiUrl.protocol)) {
    throw new Error('API_URL must use http or https');
  }
  const webRoot = resolve(webDir);

  return createServer((req, res) => {
    void (async () => {
      const requestUrl = parseRequestUrl(req);
      if (
        requestUrl.pathname.startsWith('/api/')
        || requestUrl.pathname === '/api'
        || requestUrl.pathname === '/health'
        || requestUrl.pathname === '/ready'
      ) {
        await proxyApi(req, res, requestUrl, {
          apiUrl: normalizedApiUrl,
          fetchImpl,
          maxBodyBytes,
          proxyTimeoutMs,
        });
      } else {
        await serveStatic(req, res, requestUrl, webRoot);
      }
    })().catch((error) => {
      reportError(logger, error);
      const statusCode = error instanceof HttpError ? error.statusCode : 500;
      const message = error instanceof HttpError ? error.publicMessage : 'Internal Server Error';
      sendText(res, statusCode, message);
    });
  });
}

function isMainModule() {
  return process.argv[1] !== undefined
    && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const port = positiveInteger(process.env.PORT, DEFAULT_PORT, 65_535);
  const host = process.env.HOST ?? '127.0.0.1';
  const server = createAtlasServer();
  server.listen(port, host, () => {
    console.log(`Atlas web server running on http://${host}:${port}`);
    console.log(`API proxy: ${process.env.API_URL ?? DEFAULT_API_URL}`);
    console.log(`Static: ${process.env.WEB_DIR ?? join(import.meta.dirname, 'apps', 'web', 'dist')}`);
  });
}
