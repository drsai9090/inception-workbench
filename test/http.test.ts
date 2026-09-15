import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { get } from 'node:http';
import { createApp } from '../src/http.ts';
import type { HttpOptions } from '../src/http.ts';

const reviewerToken = 'test-reviewer-'.padEnd(40, 'r');
const viewerToken = 'test-viewer-'.padEnd(40, 'v');
const empty = { imports: [], entries: [], resolutions: [], audit: [] };
// HTTP-only stub; transaction and constraint assertions run against real PostgreSQL separately.
const store: HttpOptions['store'] = {
  snapshot: async () => empty,
  importCsv: async () => { throw new Error('unreachable in boundary tests'); },
  importDetail: async () => { throw new Error('unreachable in boundary tests'); },
  approve: async () => { throw new Error('unreachable in boundary tests'); },
};
async function serve(run: (url: string) => Promise<void>, options: Partial<HttpOptions> = {}) {
  const app = createApp({ store, reviewerToken, viewerToken, origin: 'http://127.0.0.1:4318', ...options });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const address = app.address();
  assert.ok(address && typeof address !== 'string');
  try { await run(`http://127.0.0.1:${address.port}`); } finally { app.closeAllConnections(); await new Promise<void>(resolve => app.close(() => resolve())); }
}
test('hosted access requires a key; viewer reads but cannot import or approve', async () => {
  await serve(async url => {
    assert.equal((await fetch(`${url}/api/workbench`)).status, 401);
    assert.equal((await fetch(`${url}/api/workbench`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
    const headers = { Authorization: `Bearer ${viewerToken}` };
    const view = await fetch(`${url}/api/workbench`, { headers });
    assert.equal(view.status, 200); assert.deepEqual(await view.json(), empty);
    for (const path of ['imports', 'approvals']) assert.equal((await fetch(`${url}/api/${path}`, { method: 'POST', headers })).status, 403);
    const session = await fetch(`${url}/api/session`, { headers: { Authorization: `Bearer ${reviewerToken}` } });
    assert.deepEqual(await session.json(), { actor: { id: 'reviewer', role: 'reviewer' } });
  });
});
test('cross-origin authenticated requests are refused without CORS permission', async () => {
  await serve(async url => {
    const response = await fetch(`${url}/api/workbench`, { headers: { Authorization: `Bearer ${reviewerToken}`, Origin: 'https://unrelated.example' } });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.match(response.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  });
});
test('explicit local access requires literal configured Host and loopback origin', async () => {
  assert.throws(() => createApp({ store, reviewerToken, viewerToken, localDemo: true, origin: 'https://example.com' }), /127.0.0.1/);
  await serve(async url => {
    assert.equal((await fetch(`${url}/api/session`)).status, 401); // Ephemeral Host differs from configured local origin.
    const response = await new Promise<unknown>((resolve, reject) => {
      get(`${url}/api/session`, { headers: { Host: '127.0.0.1:4318' } }, response => {
        let data = ''; response.on('data', chunk => { data += chunk; });
        response.on('end', () => resolve(JSON.parse(data))); response.on('error', reject);
      }).on('error', reject);
    });
    assert.deepEqual(response, { actor: { id: 'local-reviewer', role: 'reviewer' } });
    const blocked = await fetch(`${url}/api/session`, { headers: { Host: '127.0.0.1:4318', Origin: 'https://evil.example' } });
    assert.equal(blocked.status, 403);
  }, { localDemo: true });
});
test('reject invalid JSON, wrong media type, invalid keys/IDs and unrecognised fields', async () => {
  await serve(async url => {
    const auth = { Authorization: `Bearer ${reviewerToken}` };
    const headers = { ...auth, 'Content-Type': 'application/json' };
    assert.equal((await fetch(`${url}/api/imports`, { method: 'POST', headers: auth, body: '{}' })).status, 415);
    for (const content of ['{', 'null', '[]']) assert.equal((await fetch(`${url}/api/imports`, { method: 'POST', headers, body: content })).status, 400);
    assert.equal((await fetch(`${url}/api/imports`, { method: 'POST', headers, body: Buffer.from([123,34,120,34,58,34,255,34,125]) })).status, 400);
    const valid = { kind: 'invoice', filename: 'invoices.csv', csv: '', idempotencyKey: 'upload-1234' };
    for (const changes of [{ idempotencyKey: 'bad' }, { kind: 'bank' }, { currency: 'USD' }, { filename: '' }, { filename: '\ud800.csv' }, { csv: 25 }]) {
      assert.equal((await fetch(`${url}/api/imports`, { method: 'POST', headers, body: JSON.stringify({ ...valid, ...changes }) })).status, 400);
    }
    assert.equal((await fetch(`${url}/api/imports/not-a-uuid`, { headers: auth })).status, 400);
    assert.equal((await fetch(`${url}/api/approvals`, { method: 'POST', headers, body: JSON.stringify({ invoiceId: 'bad', paymentId: 'bad', note: '' }) })).status, 400);
    assert.equal((await fetch(`${url}/api/imports`, { method: 'POST', headers, body: JSON.stringify({ ...valid, csv: 'a'.repeat(262145) }) })).status, 400);
    assert.equal((await fetch(`${url}/api/imports`, { method: 'POST', headers, body: JSON.stringify({ ...valid, csv: 'é'.repeat(140000) }) })).status, 413);
  });
});
test('health indicates readiness and missing assets produce a useful build error', async () => {
  await serve(async url => {
    assert.equal((await fetch(`${url}/healthz`)).status, 200);
    assert.equal((await fetch(`${url}/`)).status, 503);
    assert.equal((await fetch(`${url}/.env`)).status, 404);
    assert.equal((await fetch(`${url}/src/server.ts`)).status, 404);
  }, { publicDir: 'tmp/intentionally-missing-assets' });
  await serve(async url => assert.equal((await fetch(`${url}/healthz`)).status, 503), { ready: async () => { throw new Error('offline'); } });
});
