import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AppError } from './shared.ts';
import type { Actor } from './shared.ts';
import type { createStore } from './store.ts';

export interface HttpOptions {
  store: ReturnType<typeof createStore>;
  reviewerToken: string;
  viewerToken: string;
  origin: string;
  localDemo?: boolean;
  publicDir?: string;
  ready?: () => Promise<void>;
}
const hash = (value: string) => createHash('sha256').update(value).digest();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function fail(status: number, code: string, message: string): never { throw new AppError(status, code, message); }
function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') fail(415, 'CONTENT_TYPE', 'Send application/json.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_600_000) fail(413, 'BODY_LIMIT', 'Request is too large. CSV files must be at most 256 KiB.');
    chunks.push(chunk);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); } catch { fail(400, 'INVALID_JSON', 'Send a valid UTF-8 JSON object.'); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') fail(400, 'INVALID_BODY', 'Send a JSON object.');
  return parsed as Record<string, unknown>;
}
function textField(data: Record<string, unknown>, field: string, max: number): string {
  const value = data[field];
  if (typeof value !== 'string' || value.length > max || !value.isWellFormed()) fail(400, 'INVALID_FIELD', `${field} must be valid Unicode text of at most ${max} characters.`);
  return value;
}
function onlyFields(data: Record<string, unknown>, fields: string[]) {
  if (Object.keys(data).some(key => !fields.includes(key))) fail(400, 'INVALID_FIELD', 'Unexpected request field.');
}
export function createApp(options: HttpOptions) {
  const { store, reviewerToken, viewerToken, localDemo = false } = options;
  const origin = new URL(options.origin);
  if (reviewerToken.length < 32 || viewerToken.length < 32 || reviewerToken === viewerToken) throw new Error('Two distinct access keys of at least 32 characters are required.');
  if (localDemo && (origin.hostname !== '127.0.0.1' || origin.protocol !== 'http:')) throw new Error('LOCAL_DEMO requires an http://127.0.0.1 origin.');
  const publicDir = options.publicDir ?? resolve('dist');
  function actor(req: IncomingMessage): Actor {
    if (req.headers.origin && req.headers.origin !== origin.origin) fail(403, 'ORIGIN', 'This origin is not allowed.');
    // Local access is opt-in and requires both a loopback peer and the literal configured Host.
    if (localDemo && !req.headers.authorization && req.socket.remoteAddress === '127.0.0.1' && req.headers.host === origin.host) return { id: 'local-reviewer', role: 'reviewer' };
    const auth = req.headers.authorization ?? '';
    if (!auth.startsWith('Bearer ') || auth.length > 1024) fail(401, 'UNAUTHENTICATED', 'Local access is unavailable. Enter a valid access key.');
    const provided = hash(auth.slice(7));
    if (timingSafeEqual(provided, hash(reviewerToken))) return { id: 'reviewer', role: 'reviewer' };
    if (timingSafeEqual(provided, hash(viewerToken))) return { id: 'viewer', role: 'viewer' };
    fail(401, 'UNAUTHENTICATED', 'The access key is not valid.');
  }
  return createServer({ requestTimeout: 15_000, headersTimeout: 10_000, maxHeaderSize: 8192 }, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const path = new URL(req.url ?? '/', origin).pathname;
      if (req.method === 'GET' && path === '/healthz') {
        try { await options.ready?.(); } catch { return json(res, 503, { status: 'unavailable' }); }
        return json(res, 200, { status: 'ok', mode: 'synthetic' });
      }
      if (path.startsWith('/api/')) {
        const currentActor = actor(req);
        if (req.method === 'GET' && path === '/api/session') return json(res, 200, { actor: currentActor });
        if (req.method === 'GET' && path === '/api/workbench') return json(res, 200, await store.snapshot());
        if (req.method === 'GET' && path.startsWith('/api/imports/')) {
          const id = path.slice('/api/imports/'.length);
          if (!uuid.test(id)) fail(400, 'INVALID_ID', 'Invalid import identifier.');
          return json(res, 200, await store.importDetail(id));
        }
        if (req.method === 'POST' && (path === '/api/imports' || path === '/api/approvals')) {
          if (currentActor.role !== 'reviewer') fail(403, 'FORBIDDEN', 'Reviewer access is required.');
          const data = await body(req);
          if (path === '/api/imports') {
            onlyFields(data, ['kind', 'filename', 'csv', 'idempotencyKey']);
            const kind = data.kind;
            if (kind !== 'invoice' && kind !== 'payment') fail(400, 'INVALID_KIND', 'Select invoice or payment.');
            const filename = textField(data, 'filename', 120).trim();
            const csv = textField(data, 'csv', 262144);
            const idempotencyKey = textField(data, 'idempotencyKey', 100);
            if (!filename || /[\x00-\x1f\x7f]/.test(filename)) fail(400, 'INVALID_FILENAME', 'Provide a filename without control characters.');
            if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,99}$/.test(idempotencyKey)) fail(400, 'INVALID_KEY', 'Import key must be 8–100 letters, numbers, dots, colons, underscores or hyphens.');
            if (Buffer.byteLength(csv, 'utf8') > 262144) fail(413, 'CSV_LIMIT', 'CSV files must be at most 256 KiB.');
            const result = await store.importCsv({ kind, filename, csv, idempotencyKey }, currentActor);
            return json(res, result.replayed ? 200 : 201, result);
          }
          onlyFields(data, ['invoiceId', 'paymentId', 'note']);
          const invoiceId = textField(data, 'invoiceId', 36);
          const paymentId = textField(data, 'paymentId', 36);
          const note = textField(data, 'note', 500).trim();
          if (!uuid.test(invoiceId) || !uuid.test(paymentId)) fail(400, 'INVALID_ID', 'Choose a valid invoice and payment.');
          return json(res, 200, await store.approve({ invoiceId, paymentId, note }, currentActor));
        }
        fail(404, 'NOT_FOUND', 'Endpoint not found.');
      }
      const files: Record<string, [string, string]> = {
        '/': ['index.html', 'text/html; charset=utf-8'],
        '/assets/app.js': ['assets/app.js', 'text/javascript; charset=utf-8'],
        '/assets/app.css': ['assets/app.css', 'text/css; charset=utf-8'],
        '/samples/invoices.csv': ['samples/invoices.csv', 'text/csv; charset=utf-8'],
        '/samples/payments.csv': ['samples/payments.csv', 'text/csv; charset=utf-8'],
      };
      if ((req.method !== 'GET' && req.method !== 'HEAD') || !files[path]) fail(404, 'NOT_FOUND', 'Page not found.');
      const [file, contentType] = files[path];
      let bytes: Buffer;
      try { bytes = await readFile(resolve(publicDir, file)); } catch { fail(503, 'BUILD_MISSING', 'Build the application with npm run build.'); }
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      if (res.destroyed) return;
      if (error instanceof AppError) return json(res, error.status, { error: { code: error.code, message: error.message } });
      // Never log uploaded rows, connection strings or tokens.
      console.error(JSON.stringify({ event: 'request_failed', errorType: error instanceof Error ? error.name : 'Unknown' }));
      json(res, 500, { error: { code: 'INTERNAL_ERROR', message: 'The operation failed. Retry with the same import key; committed work will not be repeated.' } });
    }
  });
}
