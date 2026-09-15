# Inception · Reconciliation workbench

Import synthetic invoice and payment CSVs, review exceptions, and approve matches with an audit trail.

TypeScript · React · Node.js 24 · PostgreSQL 18. Synthetic data only; no banking connections or money movement.

## Run locally

Prerequisites: Node.js 24 with npm, and either Docker or an existing PostgreSQL 18 installation. These instructions create an isolated database on **127.0.0.1:55438** and serve the app on **127.0.0.1:4318**. Do not reuse an employer or production database.

```sh
npm ci
node scripts/setup.mjs
```

Setup creates random local credentials in ignored `.env` and refuses to overwrite an existing file. Then choose one database path:

**Windows with PostgreSQL already installed** (no Docker needed):

```powershell
./scripts/local-db.ps1
# Different existing installation:
./scripts/local-db.ps1 -PgBin 'C:/Program Files/PostgreSQL/18/bin'
```

The script creates `tmp/postgres` inside this repository, uses SCRAM authentication, and listens only on loopback. It never changes another PostgreSQL service or global configuration. Run `./scripts/local-db.ps1 -Action stop` to stop only this cluster. Starting it again preserves data. Do not run both database paths on port 55438.

**Docker:**

```sh
docker compose up -d --wait
docker compose exec postgres createdb -U inception inception_test
```

Create the test database once; if it already exists, keep it. Use `docker compose stop` to preserve the named volume. Then:

```sh
npm run migrate
npm run dev
```

Open [the local workbench](http://127.0.0.1:4318) and choose **Open local sandbox**. `dev` builds once and serves; after frontend edits run `npm run build` and reload. Restart the server after backend edits. `npm start` serves an existing build. `/healthz` returns 503 if the database or expected schema is unavailable.

## Two-minute walkthrough

1. Open **Imports**, choose **Load invoices**, then **Import and validate**. Inspect the four accepted source rows; close the inspector.
2. Choose **Load payments**, then import. Expect **3 accepted, 1 duplicate, 1 rejected and 1 conflict**.
3. Close the inspector and import the payment sample again with the same delivery key. Expect the original result, two total imports, and no new entries or audit event.
4. In **Reconcile**, approve `PAYMENT-001 → INVOICE-001`: reference and amount agree at **€1,250.00**.
5. Inspect the conflicting `PAYMENT-002` source row: a later row says €481.00 while the retained first entry says €480.00. Choose `INV-1002`, then enter a note explaining the reference typo and why the synthetic example uses the retained €480.00. Approve.
6. Expect **€1,730.00 approved**, two approved matches and four audit events. The **€75.00** partial payment remains unresolved against a €200.00 invoice. Open **Audit history** for reviewer role, time, before/after state and source-conflict evidence.

Reloading disconnects the browser; reopening retains committed records. Replaying the samples does not reset approvals.

## Access model

**One shared sandbox; no tenants or per-user accounts.** Every authorised viewer sees all synthetic data.

| Mode / role | Access |
| --- | --- |
| Explicit local demo | `LOCAL_DEMO=true`, binding and origin must use `127.0.0.1`. Requests without a key require a loopback peer and exact configured Host. Actor is `local-reviewer`. |
| Hosted reviewer | `LOCAL_DEMO=false`; valid `REVIEWER_TOKEN` can read, import and approve. |
| Hosted viewer | Valid `VIEWER_TOKEN` can read all sources and audit events, but cannot import or approve. |
| Unauthenticated hosted visitor | Public app shell, sample files and health only. No imported data or writes. |

Hosted keys must be distinct and at least 32 characters. The UI keeps its key in memory only; refresh clears it. Tokens are sent as bearer headers. Same-origin checks reject cross-origin API requests, and the server does not enable CORS. HTTPS is required for hosted use; Azure ingress enforces it. Shared keys identify a role, **not an individual person**. They are suitable for a controlled synthetic demonstration, not customer identity management. Rotate keys by changing secret configuration and restarting; the app has no self-service account system.

## Data contract and decisions

Fixed headers in this order:

```csv
invoice_id,reference,amount,currency
INVOICE-001,INV-1001,1250.00,EUR
```

```csv
payment_id,reference,amount,currency
PAYMENT-001,INV-1001,1250.00,EUR
```

- UTF-8 only, **256 KiB** per file, **1–500 data records**. The maintained `csv-parse` parser handles quoting and delimiters. Headers are exact. Row labels are logical record numbers with the header counted as row 1.
- Preserve the full original CSV text, including a UTF-8 BOM and line endings, plus separately parsed original fields, normalised fields and validation errors. Invalid UTF-8, NUL and malformed CSV structure are rejected before persistence. Structurally rejected files are not stored.
- Trim and uppercase IDs, references and currency. IDs accept 1–80 letters/digits with `. _ / -`; references allow at most 100 characters without control characters. Invoices require a reference; payments may have a missing reference for review.
- **EUR only.** Positive values up to `999999999.99`, with at most two decimal places; signs, exponents, grouping separators and extra precision are rejected. Convert directly from decimal strings to `BigInt` cents; persist PostgreSQL `bigint`, return cents as JSON strings, and sum/display with `BigInt`.
- Structurally valid files commit accepted and quarantined rows together. Bad fields stay visible as rejected rows and never become matchable entries.
- Canonical identity is `(kind, normalised external ID)`. Identical redelivery is a duplicate. Changed values are a conflict, preserve the first canonical values, and flag the canonical entry for manual review. Conflicts remain in source history after approval; approval does not edit original data.
- Reference + equal whole amount suggests a match. Every match requires approval. Ambiguous candidates, reference overrides and source conflicts need a note of at least 10 characters. Notes explain the decision; the system cannot verify whether their explanation is factually correct.
- Only one full invoice/payment pair can be approved. No splitting, partial allocation, refunds, write-offs, correction ledger or reversal is implemented. A mistaken approval currently requires operator investigation outside the UI.

## Transactions, retries and audit

An import key is globally unique within the sandbox. Its fingerprint is SHA-256 of `kind + NUL + original CSV`; filename is descriptive metadata and deliberately excluded. Reusing a key with identical content returns the saved batch; different content fails with **409**. A new key with repeated source IDs records the new delivery while canonical entries remain unique.

One PostgreSQL transaction contains the import, source rows, canonical entries and audit event. Another transaction contains an approval and its audit event. Unique invoice and payment constraints prevent double allocation. A small sandbox-wide transaction advisory lock serializes mutations; use narrower locks only if measured throughput requires them. Reads use one repeatable-read snapshot.

On a timeout or unknown result, retry the **same** import key/content or the same invoice/payment/note. A failed transaction leaves no partial import or approval. A committed operation survives server termination and replays without adding money or audit events. There is no background job or resumable partial-file processing.

Audit records contain the role identity, timestamp, source links, canonical amount, note and before/after allocation state. Update/delete triggers protect audit rows from ordinary SQL changes. A database owner can bypass those protections: this is **not a cryptographically tamper-proof audit system**.

## API

All `/api/*` routes use the access model above; bodies are JSON and errors are `{ "error": { "code": "...", "message": "..." } }`.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/session` | Current actor and role |
| GET | `/api/workbench` | Imports, entries, resolutions, audit |
| GET | `/api/imports/:id` | Original CSV and every source row |
| POST | `/api/imports` | `{kind, filename, csv, idempotencyKey}`; 201 new, 200 replay |
| POST | `/api/approvals` | `{invoiceId, paymentId, note}`; approved resolution or safe identical replay |
| GET | `/healthz` | Database/schema readiness, no imported data |

Delivery keys: 8–100 ASCII letters/digits, `. _ : -`, starting with a letter or digit. Filename: 1–120 characters. Note: at most 500 characters. IDs in API routes/selections are UUIDs. No extra request fields are accepted. Request bodies are capped at 1.6 MB to allow JSON escaping within the smaller CSV limit.

## Verify

```sh
npm run check
npm test
npm run test:integration
npm run build
```

Integration tests require `TEST_DATABASE_URL`, fail if missing, and refuse a database whose name does not end in `_test`. Each suite creates and drops only its own randomly named schema. Tests execute real PostgreSQL transactions and constraints. The HTTP boundary unit test uses a labelled store stub only for role/header/input checks.

Coverage includes exact money and malformed amounts, byte-preserving UTF-8 uploads, input/role/origin guards, simultaneous import deliveries, inconsistent idempotency keys, source conflicts, concurrent competing approvals, injected audit failures rolling back imports and approvals, and an abruptly terminated/restarted application process replaying committed HTTP operations. Database crash during COMMIT, disk loss, network partitions and production load are not simulated.

See [verification record](docs/verification.md) for observed local checks and the distinction from hosted CI. CI runs the same checks with PostgreSQL and a container smoke check. Deployment instructions are in [deploy/README.md](deploy/README.md); no Azure resources have been provisioned.

## Scope limits

Fixed CSV columns, EUR only, one shared sandbox and shared role keys. Imports are synchronous; pagination and rate limiting are not implemented. Use for controlled synthetic demonstrations only.

Implementation references: [node-postgres transactions](https://node-postgres.com/features/transactions), [CSV parser options](https://csv.js.org/parse/options/), [Azure Container Apps ingress](https://learn.microsoft.com/en-us/azure/container-apps/ingress-how-to).
