CREATE TABLE import_batches (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('invoice', 'payment')),
  filename text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  fingerprint text NOT NULL,
  original_csv text NOT NULL,
  counts jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE source_rows (
  id uuid PRIMARY KEY,
  import_id uuid NOT NULL REFERENCES import_batches(id),
  row_number integer NOT NULL CHECK (row_number >= 2),
  original jsonb NOT NULL,
  normalized jsonb NOT NULL,
  errors jsonb NOT NULL,
  disposition text NOT NULL CHECK (disposition IN ('accepted', 'duplicate', 'rejected', 'conflict')),
  entry_id uuid,
  UNIQUE (import_id, row_number)
);

CREATE TABLE entries (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('invoice', 'payment')),
  external_id text NOT NULL,
  reference text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 99999999999),
  currency text NOT NULL CHECK (currency = 'EUR'),
  source_row_id uuid NOT NULL UNIQUE REFERENCES source_rows(id),
  UNIQUE (kind, external_id)
);
ALTER TABLE source_rows ADD CONSTRAINT source_entry_fk FOREIGN KEY (entry_id) REFERENCES entries(id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE resolutions (
  id uuid PRIMARY KEY,
  invoice_id uuid NOT NULL UNIQUE REFERENCES entries(id),
  payment_id uuid NOT NULL UNIQUE REFERENCES entries(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 99999999999),
  note text NOT NULL,
  method text NOT NULL CHECK (method IN ('exact', 'reference_override')),
  actor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (invoice_id <> payment_id)
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  action text NOT NULL CHECK (action IN ('import_committed', 'resolution_approved')),
  actor_id text NOT NULL,
  details jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION prevent_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Audit events are append-only';
END;
$$;
CREATE TRIGGER immutable_audit BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();
