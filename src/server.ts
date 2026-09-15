import pg from 'pg';
import { createApp } from './http.ts';
import { createStore } from './store.ts';

const port = Number(process.env.PORT ?? 4318);
const host = process.env.HOST ?? '127.0.0.1';
const localDemo = process.env.LOCAL_DEMO === 'true';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1–65535.');
if (localDemo && host !== '127.0.0.1') throw new Error('LOCAL_DEMO may only bind to 127.0.0.1.');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required. Run migrations before starting.');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5, connectionTimeoutMillis: 5000, statement_timeout: 15000 });
pool.on('error', () => console.error(JSON.stringify({ event: 'database_connection_error' })));
const server = createApp({
  store: createStore(pool), reviewerToken: process.env.REVIEWER_TOKEN ?? '', viewerToken: process.env.VIEWER_TOKEN ?? '',
  origin: process.env.PUBLIC_ORIGIN ?? `http://${host}:${port}`, localDemo,
  ready: async () => { await pool.query('SELECT 1 FROM import_batches LIMIT 0'); },
});
server.listen(port, host, () => console.log(`Inception synthetic sandbox: http://${host}:${port} (${localDemo ? 'local reviewer access' : 'access keys required'})`));
async function shutdown() {
  server.close(async () => { await pool.end(); process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
