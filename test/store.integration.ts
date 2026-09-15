import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import pg from 'pg';
import { createStore } from '../src/store.ts';
import { migrate } from '../src/migrate.ts';
import type { Actor, ImportInput, Kind } from '../src/shared.ts';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error('TEST_DATABASE_URL is required for real PostgreSQL integration tests.');
const testUrl = new URL(connectionString);
if (!decodeURIComponent(testUrl.pathname).endsWith('_test')) throw new Error('Integration tests require a dedicated database whose name ends in _test.');
const schema = `test_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString });
testUrl.searchParams.set('options', `-c search_path=${schema}`);
const pool = new pg.Pool({ connectionString: testUrl.toString(), max: 8 });
const store = createStore(pool);
const actor: Actor = { id: 'test-reviewer', role: 'reviewer' };
const viewer: Actor = { id: 'test-viewer', role: 'viewer' };
const invoiceCsv = 'invoice_id,reference,amount,currency\nI1,REF-1,120.50,EUR\n';
const paymentCsv = 'payment_id,reference,amount,currency\nP1,REF-1,120.50,EUR\n';
const input = (kind: Kind, csv: string, key = randomUUID()): ImportInput => ({ kind, csv, filename: `${kind}s.csv`, idempotencyKey: key });

before(async () => {
  const actual = (await admin.query('SELECT current_database() AS name')).rows[0]!.name;
  assert.ok(actual.endsWith('_test'), 'Connected database must end in _test.');
  await admin.query(`CREATE SCHEMA ${schema}`);
  assert.equal((await pool.query('SELECT current_schema() AS name')).rows[0]!.name, schema);
  await migrate(pool);
  await migrate(pool);
});
beforeEach(async () => {
  await pool.query('DROP TRIGGER IF EXISTS reject_audit ON audit_events');
  await pool.query('TRUNCATE audit_events, resolutions, entries, source_rows, import_batches CASCADE');
});
after(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
});

async function seedPair() {
  await store.importCsv(input('invoice', invoiceCsv), actor);
  await store.importCsv(input('payment', paymentCsv), actor);
  const state = await store.snapshot();
  return { invoiceId: state.entries.find(e => e.kind === 'invoice')!.id, paymentId: state.entries.find(e => e.kind === 'payment')!.id, note: 'Verified synthetic source records.' };
}
async function rejectAudit() {
  await pool.query("CREATE OR REPLACE FUNCTION fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected audit failure'; END; $$");
  await pool.query('CREATE TRIGGER reject_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_audit()');
}

test('same key delivery replays the original batch, including simultaneous requests', async () => {
  const request = input('invoice', invoiceCsv);
  const outcomes = await Promise.all([store.importCsv(request, actor), store.importCsv({ ...request, filename: 'renamed.csv' }, actor)]);
  assert.equal(outcomes.filter(r => r.replayed).length, 1);
  assert.equal(outcomes[0]!.batch.id, outcomes[1]!.batch.id);
  const state = await store.snapshot();
  assert.equal(state.imports.length, 1);
  assert.equal(state.entries.length, 1);
  assert.equal(state.audit.length, 1);
  const detail = await store.importDetail(state.imports[0]!.id);
  assert.equal(detail.csv, invoiceCsv);
  assert.deepEqual(detail.rows[0]!.original, { invoice_id: 'I1', reference: 'REF-1', amount: '120.50', currency: 'EUR' });
});

test('a used key rejects altered content and kind, even malformed replacement CSV', async () => {
  const request = input('invoice', invoiceCsv);
  await store.importCsv(request, actor);
  for (const changed of [{ ...request, csv: invoiceCsv.replace('120.50', '120.51') }, { ...request, kind: 'payment' as const, csv: paymentCsv }, { ...request, csv: 'broken' }]) {
    await assert.rejects(store.importCsv(changed, actor), { status: 409, code: 'IDEMPOTENCY_CONFLICT' });
  }
  assert.equal((await store.snapshot()).imports.length, 1);
});

test('different keys preserve duplicate deliveries and quarantine conflicting canonical IDs', async () => {
  const outcomes = await Promise.all([store.importCsv(input('invoice', invoiceCsv), actor), store.importCsv(input('invoice', invoiceCsv), actor)]);
  assert.equal(outcomes.reduce((n, r) => n + r.batch.counts.accepted, 0), 1);
  assert.equal(outcomes.reduce((n, r) => n + r.batch.counts.duplicate, 0), 1);
  const conflicted = await store.importCsv(input('invoice', invoiceCsv.replace('120.50', '125.00')), actor);
  assert.equal(conflicted.batch.counts.conflict, 1);
  const detail = await store.importDetail(conflicted.batch.id);
  assert.equal(detail.rows[0]!.normalized.amountMinor, '12500');
  const state = await store.snapshot();
  assert.equal(state.entries.length, 1);
  assert.equal(state.entries[0]!.amountMinor, '12050');
  assert.equal(detail.rows[0]!.entryId, state.entries[0]!.id);
  await assert.rejects(pool.query('INSERT INTO entries SELECT $1::uuid, kind, external_id, reference, amount_minor, currency, source_row_id FROM entries LIMIT 1', [randomUUID()]), { code: '23505' });
});

test('valid rows commit with invalid rows preserved in quarantine; structural failure has no effects', async () => {
  const csv = invoiceCsv + 'I2,REF-2,1.005,EUR\nI3,REF-3,-2,EUR\nI4,REF-4,10,GBP\n';
  const result = await store.importCsv(input('invoice', csv), actor);
  assert.deepEqual(result.batch.counts, { accepted: 1, duplicate: 0, rejected: 3, conflict: 0 });
  const detail = await store.importDetail(result.batch.id);
  assert.equal(detail.csv, csv);
  assert.equal(detail.rows.length, 4);
  assert.equal(detail.rows[1]!.original.amount, '1.005');
  assert.equal(detail.rows[1]!.normalized.amountMinor, null);
  await assert.rejects(store.importCsv(input('invoice', 'invoice_id,reference,amount,currency\nI5,REF,3'), actor), { status: 400 });
  assert.equal((await store.snapshot()).imports.length, 1);
});

test('audit failure rolls back entire import and its key can recover on retry', async () => {
  await rejectAudit();
  const request = input('invoice', invoiceCsv);
  await assert.rejects(store.importCsv(request, actor), /injected audit failure/);
  const empty = await store.snapshot();
  assert.equal(empty.imports.length, 0);
  assert.equal(empty.entries.length, 0);
  assert.equal(empty.audit.length, 0);
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM source_rows')).rows[0]!.count, 0);
  await pool.query('DROP TRIGGER reject_audit ON audit_events');
  assert.equal((await store.importCsv(request, actor)).replayed, false);
});

test('viewer and absent identity cannot import or approve', async () => {
  await assert.rejects(store.importCsv(input('invoice', invoiceCsv), viewer), { status: 403 });
  await assert.rejects(store.importCsv(input('invoice', invoiceCsv), { id: '', role: 'reviewer' }), { status: 403 });
  const approval = await seedPair();
  await assert.rejects(store.approve(approval, viewer), { status: 403 });
  await assert.rejects(store.approve(approval, undefined as unknown as Actor), { status: 403 });
  const state = await store.snapshot();
  assert.equal(state.resolutions.length, 0);
  assert.equal(state.audit.length, 2);
});

test('ill-formed Unicode metadata rejects before database effects', async () => {
  for (const invalid of ['\uD800', '\uDC00']) {
    await assert.rejects(store.importCsv({ ...input('invoice', invoiceCsv), filename: `bad-${invalid}.csv` }, actor), { status: 400, code: 'INVALID_FILENAME' });
    await assert.rejects(store.importCsv(input('invoice', invoiceCsv), { ...actor, id: `reviewer-${invalid}` }), { status: 403, code: 'INVALID_ACTOR' });
  }
  assert.equal((await store.snapshot()).imports.length, 0);
  const approval = await seedPair();
  await assert.rejects(store.approve({ ...approval, note: 'Invalid note \uD800' }, actor), { status: 400, code: 'INVALID_NOTE' });
  const state = await store.snapshot();
  assert.equal(state.resolutions.length, 0);
  assert.equal(state.audit.length, 2);
});

test('human approval is exact, linked to original sources, immutable in audit and safely replayable', async () => {
  const approval = await seedPair();
  assert.equal((await store.snapshot()).resolutions.length, 0);
  const result = await store.approve(approval, actor);
  assert.equal(result.method, 'exact');
  assert.equal(result.amountMinor, '12050');
  assert.deepEqual(await store.approve(approval, actor), result);
  await assert.rejects(store.approve({ ...approval, note: 'Changed review note.' }, actor), { status: 409 });
  const state = await store.snapshot();
  assert.equal(state.resolutions.length, 1);
  const audit = state.audit.find(e => e.action === 'resolution_approved')!;
  assert.equal(audit.details.resolutionId, result.id);
  assert.deepEqual(audit.details.before, { invoice: 'unallocated', payment: 'unallocated' });
  assert.deepEqual(audit.details.after, { invoice: 'allocated', payment: 'allocated' });
  assert.ok((audit.details.invoiceSource as { rowId: string }).rowId);
  await assert.rejects(pool.query("UPDATE audit_events SET actor_id = 'changed' WHERE id = $1", [audit.id]), /append-only/);
  await assert.rejects(pool.query('DELETE FROM audit_events WHERE id = $1', [audit.id]), /append-only/);
});

test('simultaneous competing approvals allocate a payment once', async () => {
  const first = await seedPair();
  await store.importCsv(input('invoice', invoiceCsv.replace('I1,', 'I2,')), actor);
  const secondId = (await store.snapshot()).entries.find(e => e.externalId === 'I2')!.id;
  const results = await Promise.allSettled([
    store.approve(first, actor), store.approve({ ...first, invoiceId: secondId, note: 'Reviewed the ambiguous reference.' }, actor),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const failure = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
  assert.equal(failure.reason.status, 409);
  const state = await store.snapshot();
  assert.equal(state.resolutions.length, 1);
  assert.equal(state.resolutions[0]!.method, 'reference_override');
  assert.equal(state.audit.filter(e => e.action === 'resolution_approved').length, 1);
});

test('mismatch and ambiguity require review explanation; unequal amounts and reversed kinds fail', async () => {
  const approval = await seedPair();
  await store.importCsv(input('invoice', invoiceCsv.replace('I1,', 'I2,')), actor);
  await assert.rejects(store.approve({ ...approval, note: '' }, actor), { status: 400, code: 'REVIEW_NOTE_REQUIRED' });
  await assert.rejects(store.approve({ ...approval, invoiceId: approval.paymentId, paymentId: approval.invoiceId }, actor), { status: 404 });
  await store.importCsv(input('payment', paymentCsv.replace('P1,REF-1,120.50', 'P2,OTHER,120.50')), actor);
  await store.importCsv(input('payment', paymentCsv.replace('P1,REF-1,120.50', 'P3,REF-1,120.51')), actor);
  const entries = (await store.snapshot()).entries;
  const mismatch = { ...approval, paymentId: entries.find(e => e.externalId === 'P2')!.id };
  await assert.rejects(store.approve({ ...mismatch, note: 'short' }, actor), { status: 400 });
  await assert.rejects(store.approve({ ...approval, paymentId: entries.find(e => e.externalId === 'P3')!.id }, actor), { status: 409, code: 'AMOUNT_MISMATCH' });
  assert.equal((await store.approve(mismatch, actor)).method, 'reference_override');
});

test('audit failure rolls back approval so a subsequent retry remains possible', async () => {
  const approval = await seedPair();
  await rejectAudit();
  await assert.rejects(store.approve(approval, actor), /injected audit failure/);
  assert.equal((await store.snapshot()).resolutions.length, 0);
  assert.equal((await store.snapshot()).audit.length, 2);
  await pool.query('DROP TRIGGER reject_audit ON audit_events');
  assert.equal((await store.approve(approval, actor)).method, 'exact');
});

test('disputed canonical source data requires review and records conflict evidence in approval audit', async () => {
  const approval = await seedPair();
  const conflicting = await store.importCsv(input('payment', paymentCsv.replace('120.50', '121.00')), actor);
  const detail = await store.importDetail(conflicting.batch.id);
  const payment = (await store.snapshot()).entries.find(e => e.id === approval.paymentId)!;
  assert.deepEqual(payment.conflictSourceRowIds, [detail.rows[0]!.id]);
  await assert.rejects(store.approve({ ...approval, note: '' }, actor), { status: 400, code: 'REVIEW_NOTE_REQUIRED' });
  const approved = await store.approve({ ...approval, note: 'Reviewed disputed source; original synthetic amount is correct.' }, actor);
  assert.equal(approved.method, 'reference_override');
  assert.equal(approved.amountMinor, '12050');
  const audit = (await store.snapshot()).audit.find(e => e.action === 'resolution_approved')!;
  const conflicts = audit.details.sourceConflicts as { importId: string; normalized: { amountMinor: string } }[];
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]!.importId, conflicting.batch.id);
  assert.equal(conflicts[0]!.normalized.amountMinor, '12100');
});
