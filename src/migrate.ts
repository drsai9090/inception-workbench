import { readFile } from 'node:fs/promises';
import pg from 'pg';

export async function migrate(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(428519700)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())');
    const existing = await client.query('SELECT version FROM schema_migrations WHERE version = 1');
    if (!existing.rowCount) {
      await client.query(await readFile(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8'));
      await client.query('INSERT INTO schema_migrations(version) VALUES (1)');
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

if (import.meta.main) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await migrate(pool);
    console.log('Database migration complete.');
  } finally {
    await pool.end();
  }
}
