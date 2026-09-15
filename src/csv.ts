import { parse } from 'csv-parse/sync';
import { AppError, type Kind, type SourceRow } from './shared.ts';

export const MAX_CSV_BYTES = 256 * 1024;
export const MAX_ROWS = 500;
export const MAX_AMOUNT_MINOR = 99999999999n;

export function parseAmount(value: string): string | null {
  if (value !== value.trim() || !/^\d{1,9}(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const minor = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
  return minor > 0n && minor <= MAX_AMOUNT_MINOR ? minor.toString() : null;
}

export type ParsedRow = Pick<SourceRow, 'rowNumber' | 'original' | 'normalized' | 'errors'>;

export function validateCsvText(csv: unknown): asserts csv is string {
  if (typeof csv !== 'string' || !csv.length || Buffer.byteLength(csv, 'utf8') > MAX_CSV_BYTES) {
    throw new AppError(400, 'INVALID_CSV_SIZE', 'CSV must contain data and be no larger than 256 KiB.');
  }
  // In Unicode mode the surrogate range matches only unpaired UTF-16 code units.
  if (/[\u0000\uD800-\uDFFF]/u.test(csv)) throw new AppError(400, 'INVALID_CSV_TEXT', 'CSV must contain valid Unicode without NUL characters.');
}

export function parseCsv(kind: Kind, csv: string): ParsedRow[] {
  if (kind !== 'invoice' && kind !== 'payment') throw new AppError(400, 'INVALID_KIND', 'Choose invoice or payment CSV.');
  validateCsvText(csv);
  let records: string[][];
  try {
    records = parse(csv, { bom: true, max_record_size: MAX_CSV_BYTES }) as string[][];
  } catch {
    throw new AppError(400, 'INVALID_CSV', 'CSV structure is invalid. Check quotes and use exactly four columns on each row.');
  }
  const headers = [`${kind}_id`, 'reference', 'amount', 'currency'];
  if (!records[0] || records[0].length !== headers.length || records[0].some((v, i) => v !== headers[i])) {
    throw new AppError(400, 'INVALID_HEADERS', `Expected CSV headers: ${headers.join(',')}`);
  }
  if (records.length < 2 || records.length > MAX_ROWS + 1) throw new AppError(400, 'INVALID_ROW_COUNT', 'CSV must contain between 1 and 500 data rows.');
  return records.slice(1).map((values, index) => {
    const original = Object.fromEntries(headers.map((key, i) => [key, values[i]!]));
    const externalId = values[0]!.trim().toUpperCase();
    const reference = values[1]!.trim().toUpperCase();
    const amountMinor = parseAmount(values[2]!.trim());
    const currency = values[3]!.trim().toUpperCase();
    const errors: string[] = [];
    if (!/^[A-Z0-9][A-Z0-9._/-]{0,79}$/.test(externalId)) errors.push('ID must be 1–80 letters, digits, dots, underscores, slashes or hyphens.');
    if ((kind === 'invoice' && !reference) || reference.length > 100 || /[\p{Cc}\p{Cf}]/u.test(reference)) errors.push('Reference must be at most 100 characters, with no control characters; invoices require a reference.');
    if (amountMinor === null) errors.push('Amount must be positive, no larger than 999999999.99, with at most two decimal places; no signs, separators or exponents.');
    if (currency !== 'EUR') errors.push('Only EUR is supported.');
    return { rowNumber: index + 2, original, normalized: { externalId, reference, amountMinor, currency }, errors };
  });
}
