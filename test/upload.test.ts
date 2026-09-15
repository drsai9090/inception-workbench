import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeCsv } from '../src/client/read-csv.ts';

test('CSV upload preserves UTF-8 bytes including BOM, quoted Unicode and CRLF', () => {
  const bytes = new TextEncoder().encode('\uFEFFinvoice_id,reference,amount,currency\r\nINV-1,"Réf, one",10.00,EUR\r\n');
  assert.deepEqual(new TextEncoder().encode(decodeCsv(bytes.buffer)), bytes);
});

test('CSV upload rejects malformed UTF-8 instead of replacing original bytes', () => {
  assert.throws(() => decodeCsv(new Uint8Array([0xc3, 0x28]).buffer), /UTF-8 encoded CSV/);
});
