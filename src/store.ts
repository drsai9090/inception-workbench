import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { parseCsv, validateCsvText } from './csv.ts';
import { AppError, type Actor, type ApprovalInput, type ImportBatch, type ImportDetail, type ImportInput, type ImportResult, type Resolution, type Workbench } from './shared.ts';

const iso = (value: Date | string): string => new Date(value).toISOString();
const batch = (r: pg.QueryResultRow): ImportBatch => ({ id: r.id, kind: r.kind, filename: r.filename, idempotencyKey: r.idempotency_key, counts: r.counts, createdAt: iso(r.created_at) });
const resolution = (r: pg.QueryResultRow): Resolution => ({ id: r.id, invoiceId: r.invoice_id, paymentId: r.payment_id, amountMinor: r.amount_minor, note: r.note, method: r.method, actorId: r.actor_id, createdAt: iso(r.created_at) });
const uuid = (value: unknown): value is string => typeof value === 'string' && value.length === 36 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

function reviewer(actor: Actor): void {
  if (!actor || actor.role !== 'reviewer') throw new AppError(403, 'FORBIDDEN', 'Reviewer access is required.');
  if (typeof actor.id !== 'string' || !actor.id.trim() || !actor.id.isWellFormed() || actor.id.length > 100 || /[\p{Cc}\p{Cf}]/u.test(actor.id)) throw new AppError(403, 'INVALID_ACTOR', 'A valid reviewer identity is required.');
}

async function transaction<T>(pool: pg.Pool, work: (client: pg.PoolClient) => Promise<T>, readonly = false): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(readonly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
    // ponytail: one sandbox serializes writes; use per-import and per-entry locks if throughput requires it.
    if (!readonly) await client.query('SELECT pg_advisory_xact_lock(428519701)');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    if ((error as { code?: string }).code === '23505') throw new AppError(409, 'CONCURRENT_CONFLICT', 'Another request already imported or allocated this item. Refresh and review.');
    throw error;
  } finally {
    client.release();
  }
}

export function createStore(pool: pg.Pool) {
  return {
    async importCsv(input: ImportInput, actor: Actor): Promise<ImportResult> {
      reviewer(actor);
      if (!input || (input.kind !== 'invoice' && input.kind !== 'payment')) throw new AppError(400, 'INVALID_KIND', 'Choose invoice or payment CSV.');
      if (typeof input.filename !== 'string' || !input.filename.trim() || !input.filename.isWellFormed() || input.filename.length > 120 || /[\p{Cc}\p{Cf}]/u.test(input.filename)) throw new AppError(400, 'INVALID_FILENAME', 'A valid Unicode filename of 1–120 characters is required.');
      if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length < 8 || input.idempotencyKey.length > 100 || !/^[A-Za-z0-9]/.test(input.idempotencyKey) || /[^A-Za-z0-9._:-]/.test(input.idempotencyKey)) throw new AppError(400, 'INVALID_KEY', 'Use an import key of 8–100 letters, digits, dots, underscores, colons or hyphens, starting with a letter or digit.');
      validateCsvText(input.csv);
      const fingerprint = createHash('sha256').update(input.kind).update('\0').update(input.csv).digest('hex');
      return transaction(pool, async client => {
        const prior = await client.query('SELECT * FROM import_batches WHERE idempotency_key = $1', [input.idempotencyKey]);
        if (prior.rows[0]) {
          if (prior.rows[0].fingerprint !== fingerprint) throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'This import key was already used for different content. Use the original content or a new key.');
          return { batch: batch(prior.rows[0]), replayed: true };
        }
        const parsed = parseCsv(input.kind, input.csv);
        const id = randomUUID();
        const counts = { accepted: 0, duplicate: 0, rejected: 0, conflict: 0 };
        const beforeCount = (await client.query('SELECT count(*)::integer AS count FROM entries')).rows[0]!.count;
        await client.query('INSERT INTO import_batches(id, kind, filename, idempotency_key, fingerprint, original_csv, counts) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, input.kind, input.filename, input.idempotencyKey, fingerprint, input.csv, counts]);
        const sourceRowIds: string[] = [];
        for (const row of parsed) {
          const rowId = randomUUID();
          sourceRowIds.push(rowId);
          let disposition: 'accepted' | 'duplicate' | 'rejected' | 'conflict' = row.errors.length ? 'rejected' : 'accepted';
          let entryId: string | null = null;
          if (!row.errors.length) {
            const canonical = (await client.query('SELECT * FROM entries WHERE kind = $1 AND external_id = $2', [input.kind, row.normalized.externalId])).rows[0];
            if (canonical) {
              entryId = canonical.id;
              disposition = canonical.reference === row.normalized.reference && canonical.amount_minor === row.normalized.amountMinor && canonical.currency === row.normalized.currency ? 'duplicate' : 'conflict';
              if (disposition === 'conflict') row.errors.push('This ID already has different canonical data. Original entry retained. Inspect the conflicting evidence and explain any approval using the retained amount.');
            } else entryId = randomUUID();
          }
          counts[disposition]++;
          await client.query('INSERT INTO source_rows(id, import_id, row_number, original, normalized, errors, disposition, entry_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [rowId, id, row.rowNumber, row.original, row.normalized, JSON.stringify(row.errors), disposition, entryId]);
          if (disposition === 'accepted') await client.query('INSERT INTO entries(id, kind, external_id, reference, amount_minor, currency, source_row_id) VALUES ($1,$2,$3,$4,$5,$6,$7)', [entryId, input.kind, row.normalized.externalId, row.normalized.reference, row.normalized.amountMinor, row.normalized.currency, rowId]);
        }
        const saved = await client.query('UPDATE import_batches SET counts = $2 WHERE id = $1 RETURNING *', [id, counts]);
        await client.query('INSERT INTO audit_events(id, action, actor_id, details) VALUES ($1,$2,$3,$4)', [randomUUID(), 'import_committed', actor.id, { importId: id, kind: input.kind, filename: input.filename, counts, sourceRowIds, before: { canonicalEntries: beforeCount }, after: { canonicalEntries: beforeCount + counts.accepted } }]);
        return { batch: batch(saved.rows[0]!), replayed: false };
      });
    },

    async snapshot(): Promise<Workbench> {
      return transaction(pool, async client => {
        const imports = await client.query('SELECT * FROM import_batches ORDER BY created_at DESC, id');
        const entries = await client.query("SELECT e.*, ARRAY(SELECT s.id FROM source_rows s WHERE s.entry_id = e.id AND s.disposition = 'conflict' ORDER BY s.id) AS conflict_source_row_ids FROM entries e ORDER BY kind, external_id");
        const resolutions = await client.query('SELECT * FROM resolutions ORDER BY created_at DESC, id');
        const audit = await client.query('SELECT * FROM audit_events ORDER BY created_at DESC, id');
        return {
          imports: imports.rows.map(batch),
          entries: entries.rows.map(r => ({ id: r.id, kind: r.kind, externalId: r.external_id, reference: r.reference, amountMinor: r.amount_minor, currency: r.currency, sourceRowId: r.source_row_id, conflictSourceRowIds: r.conflict_source_row_ids })),
          resolutions: resolutions.rows.map(resolution),
          audit: audit.rows.map(r => ({ id: r.id, action: r.action, actorId: r.actor_id, createdAt: iso(r.created_at), details: r.details })),
        };
      }, true);
    },

    async importDetail(id: string): Promise<ImportDetail> {
      if (!uuid(id)) throw new AppError(400, 'INVALID_ID', 'Import ID is invalid.');
      return transaction(pool, async client => {
        const result = await client.query('SELECT * FROM import_batches WHERE id = $1', [id]);
        if (!result.rows[0]) throw new AppError(404, 'NOT_FOUND', 'Import not found.');
        const rows = await client.query('SELECT * FROM source_rows WHERE import_id = $1 ORDER BY row_number', [id]);
        return { ...batch(result.rows[0]), csv: result.rows[0].original_csv, rows: rows.rows.map(r => ({ id: r.id, rowNumber: r.row_number, original: r.original, normalized: r.normalized, errors: r.errors, disposition: r.disposition, entryId: r.entry_id })) };
      }, true);
    },

    async approve(input: ApprovalInput, actor: Actor): Promise<Resolution> {
      reviewer(actor);
      if (!input || !uuid(input.invoiceId) || !uuid(input.paymentId) || input.invoiceId === input.paymentId) throw new AppError(400, 'INVALID_SELECTION', 'Choose one invoice and one payment.');
      if (typeof input.note !== 'string' || !input.note.isWellFormed() || input.note.length > 500 || /[\p{Cc}\p{Cf}]/u.test(input.note)) throw new AppError(400, 'INVALID_NOTE', 'Review note must contain valid Unicode, at most 500 characters and no control characters.');
      const note = input.note.trim();
      return transaction(pool, async client => {
        const prior = await client.query('SELECT * FROM resolutions WHERE invoice_id = $1 OR payment_id = $2', [input.invoiceId, input.paymentId]);
        if (prior.rowCount) {
          const identical = prior.rows.find(r => r.invoice_id === input.invoiceId && r.payment_id === input.paymentId && r.note === note);
          if (identical) return resolution(identical);
          throw new AppError(409, 'ALREADY_ALLOCATED', 'The invoice or payment has already been allocated. Refresh before reviewing again.');
        }
        const selected = await client.query('SELECT e.*, s.import_id FROM entries e JOIN source_rows s ON s.id = e.source_row_id WHERE e.id = ANY($1::uuid[]) ORDER BY e.id FOR UPDATE OF e', [[input.invoiceId, input.paymentId]]);
        const invoice = selected.rows.find(r => r.id === input.invoiceId && r.kind === 'invoice');
        const payment = selected.rows.find(r => r.id === input.paymentId && r.kind === 'payment');
        if (!invoice || !payment) throw new AppError(404, 'NOT_FOUND', 'Selected invoice or payment was not found.');
        if (invoice.amount_minor !== payment.amount_minor) throw new AppError(409, 'AMOUNT_MISMATCH', 'Amounts must be exactly equal. Partial payments and write-offs are outside this demo.');
        const candidates = await client.query('SELECT e.kind, count(*)::integer AS count FROM entries e WHERE e.reference = $1 AND e.amount_minor = $2 AND NOT EXISTS (SELECT 1 FROM resolutions r WHERE r.invoice_id = e.id OR r.payment_id = e.id) GROUP BY e.kind', [invoice.reference, invoice.amount_minor]);
        const uniqueInvoice = candidates.rows.find(r => r.kind === 'invoice')?.count === 1;
        const uniquePayment = candidates.rows.find(r => r.kind === 'payment')?.count === 1;
        const disputed = await client.query("SELECT id, import_id, entry_id, normalized FROM source_rows WHERE entry_id = ANY($1::uuid[]) AND disposition = 'conflict' ORDER BY import_id, row_number", [[invoice.id, payment.id]]);
        const sourceConflicts = disputed.rows.map(r => ({ rowId: r.id, importId: r.import_id, entryId: r.entry_id, normalized: r.normalized }));
        const method = invoice.reference === payment.reference && uniqueInvoice && uniquePayment && !sourceConflicts.length ? 'exact' : 'reference_override';
        if (method === 'reference_override' && note.length < 10) throw new AppError(400, 'REVIEW_NOTE_REQUIRED', 'Explain the reference mismatch, ambiguity or disputed source data in at least 10 characters.');
        const saved = await client.query('INSERT INTO resolutions(id, invoice_id, payment_id, amount_minor, note, method, actor_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [randomUUID(), invoice.id, payment.id, invoice.amount_minor, note, method, actor.id]);
        const approved = resolution(saved.rows[0]!);
        await client.query('INSERT INTO audit_events(id, action, actor_id, details) VALUES ($1,$2,$3,$4)', [randomUUID(), 'resolution_approved', actor.id, {
          resolutionId: approved.id, invoiceId: invoice.id, paymentId: payment.id,
          invoiceSource: { importId: invoice.import_id, rowId: invoice.source_row_id, externalId: invoice.external_id, reference: invoice.reference },
          paymentSource: { importId: payment.import_id, rowId: payment.source_row_id, externalId: payment.external_id, reference: payment.reference },
          amountMinor: approved.amountMinor, currency: 'EUR', method, note, sourceConflicts,
          before: { invoice: 'unallocated', payment: 'unallocated' }, after: { invoice: 'allocated', payment: 'allocated' },
        }]);
        return approved;
      });
    },
  };
}
