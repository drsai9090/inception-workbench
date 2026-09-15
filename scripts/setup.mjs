import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const password = randomBytes(24).toString('hex');
const reviewer = randomBytes(24).toString('hex');
const viewer = randomBytes(24).toString('hex');
await writeFile('.env', `POSTGRES_PASSWORD=${password}\nDATABASE_URL=postgresql://inception:${password}@127.0.0.1:55438/inception\nTEST_DATABASE_URL=postgresql://inception:${password}@127.0.0.1:55438/inception_test\nREVIEWER_TOKEN=${reviewer}\nVIEWER_TOKEN=${viewer}\nHOST=127.0.0.1\nPORT=4318\nLOCAL_DEMO=true\n`, { flag: 'wx', mode: 0o600 });
console.log('Created private .env with random sandbox credentials. Existing files are never overwritten.');
