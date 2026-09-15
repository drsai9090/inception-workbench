import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import pg from 'pg';
import { migrate } from '../src/migrate.ts';
import type { ImportResult, Resolution, Workbench } from '../src/shared.ts';

test('abrupt application restart safely replays committed HTTP imports and approval', { timeout: 20_000 }, async () => {
  if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required.');
  const url = new URL(process.env.TEST_DATABASE_URL);
  assert.ok(decodeURIComponent(url.pathname).endsWith('_test'), 'Use a dedicated _test database.');
  const admin = new pg.Pool({ connectionString: url.toString() });
  const schema = `restart_${randomUUID().replaceAll('-', '')}`;
  assert.ok((await admin.query('SELECT current_database() AS name')).rows[0].name.endsWith('_test'));
  await admin.query(`CREATE SCHEMA ${schema}`);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const pool = new pg.Pool({ connectionString: url.toString() });
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address(); assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const reviewer = 'restart-test-reviewer'.padEnd(40, 'r');
  const base = `http://127.0.0.1:${port}`;
  function start() {
    return spawn(process.execPath, ['src/server.ts'], {
      env: { ...process.env, DATABASE_URL: url.toString(), HOST: '127.0.0.1', PORT: String(port), PUBLIC_ORIGIN: base, LOCAL_DEMO: 'false', REVIEWER_TOKEN: reviewer, VIEWER_TOKEN: 'restart-test-viewer'.padEnd(40, 'v') },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
  }
  let child: ReturnType<typeof start> | undefined;
  async function ready() {
    // The server's first output occurs in listen's callback; no fixed startup sleep.
    await Promise.race([
      once(child!.stdout!, 'data'),
      once(child!, 'exit').then(() => { throw new Error('Server exited before listening.'); }),
    ]);
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
  }
  async function stop() {
    if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
  }
  async function request<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${reviewer}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    assert.ok(response.ok, `HTTP ${response.status} for ${path}`);
    return await response.json() as T;
  }
  try {
    await migrate(pool);
    child = start(); await ready();
    const invoice = { kind: 'invoice', filename: 'restart.csv', idempotencyKey: 'restart-invoice-1', csv: 'invoice_id,reference,amount,currency\nRESTART-I,REF-1,19.99,EUR\n' };
    const imported = await request<ImportResult>('/api/imports', invoice);
    await request('/api/imports', { ...invoice, kind: 'payment', idempotencyKey: 'restart-payment-1', csv: 'payment_id,reference,amount,currency\nRESTART-P,REF-1,19.99,EUR\n' });
    const entries = (await request<Workbench>('/api/workbench')).entries;
    const approval = { invoiceId: entries.find(e => e.kind === 'invoice')!.id, paymentId: entries.find(e => e.kind === 'payment')!.id, note: '' };
    const approved = await request<Resolution>('/api/approvals', approval);
    await stop(); child = start(); await ready();
    const replay = await request<ImportResult>('/api/imports', invoice);
    assert.equal(replay.replayed, true); assert.equal(replay.batch.id, imported.batch.id);
    assert.deepEqual(await request('/api/approvals', approval), approved);
    const after = await request<Workbench>('/api/workbench');
    assert.equal(after.imports.length, 2); assert.equal(after.entries.length, 2);
    assert.equal(after.resolutions.length, 1); assert.equal(after.audit.length, 3);
  } finally {
    await stop(); await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  }
});
