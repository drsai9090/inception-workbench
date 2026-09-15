import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_CSV_BYTES, parseAmount, parseCsv } from '../src/csv.ts';

test('decimal amounts are exact positive EUR cents with bounded precision', () => {
  assert.equal(parseAmount('0.01'), '1');
  assert.equal(parseAmount('123.4'), '12340');
  assert.equal(parseAmount('999999999.99'), '99999999999');
  for (const malformed of ['0', '0.00', '-1', '+1', '1e3', '1,000', '1.001', 'NaN', '', '.50', '1.', '1000000000', ' 1', '1\n']) assert.equal(parseAmount(malformed), null, malformed);
});

test('CSV preserves quoted original fields and normalizes without changing source', () => {
  const csv = '\ufeffinvoice_id,reference,amount,currency\r\n inv-1 ," ref, one ",12.30, eur \r\n';
  const [row] = parseCsv('invoice', csv);
  assert.deepEqual(row, {
    rowNumber: 2,
    original: { invoice_id: ' inv-1 ', reference: ' ref, one ', amount: '12.30', currency: ' eur ' },
    normalized: { externalId: 'INV-1', reference: 'REF, ONE', amountMinor: '1230', currency: 'EUR' },
    errors: [],
  });
});

test('bad fields quarantine individually; payments may omit references', () => {
  const rows = parseCsv('payment', 'payment_id,reference,amount,currency\nP1,,20,EUR\nP2,REF,1.005,GBP\n,bad,0,EUR\n');
  assert.equal(rows[0]!.errors.length, 0);
  assert.equal(rows[1]!.normalized.amountMinor, null);
  assert.equal(rows[1]!.errors.length, 2);
  assert.equal(rows[2]!.errors.length, 2);
  assert.equal(parseCsv('invoice', 'invoice_id,reference,amount,currency\nI1,,20,EUR')[0]!.errors.length, 1);
});

test('malformed CSV, headers, size and row counts reject the whole input', () => {
  for (const csv of [
    '', 'invoice_id,reference,amount,currency',
    'invoice_id,reference,amount,currency\nI1,R,1',
    'invoice_id,reference,amount,currency\nI1,"R,1,EUR',
    'reference,invoice_id,amount,currency\nR,I1,1,EUR',
    'invoice_id,reference,amount,currency\n' + 'I1,R,1,EUR\n'.repeat(501),
    'x'.repeat(MAX_CSV_BYTES + 1),
  ]) assert.throws(() => parseCsv('invoice', csv), { status: 400 });
});

test('CSV rejects NUL and lone surrogates but preserves valid astral Unicode', () => {
  const csv = 'invoice_id,reference,amount,currency\nI1,REFERENCE,1,EUR';
  for (const invalid of ['\u0000', '\uD800', '\uDC00']) assert.throws(() => parseCsv('invoice', csv.replace('REFERENCE', invalid)), { status: 400, code: 'INVALID_CSV_TEXT' });
  assert.equal(parseCsv('invoice', csv.replace('REFERENCE', 'SYNTHETIC-\u{1F9EA}'))[0]!.original.reference, 'SYNTHETIC-\u{1F9EA}');
});
