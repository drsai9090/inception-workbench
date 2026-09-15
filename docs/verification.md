# Verification record

Local verification on 15 September 2026: Windows, Node.js **24.19.0**, PostgreSQL **18.6**. The database was a new repository-local cluster bound to `127.0.0.1:55438`, with separate `inception` and `inception_test` databases. Existing database services were not changed.

## Observed local results

- TypeScript check and production client build passed.
- **12 unit/HTTP tests passed**: decimal precision, CSV validation and quoting, Unicode, byte-preserving UTF-8 upload, role/origin/input guards and readiness.
- **14 real PostgreSQL integration tests passed**: duplicate and simultaneous imports, conflicting keys/content, quarantine, source conflicts, permissions at service/API boundaries, atomic rollback, competing approvals, reconnect replay, and abrupt application-process restart/replay.
- The restart check kills a server process after committed imports and approval, starts a new process, then resubmits the same operations through HTTP. It proves persistence and safe replay after application termination; it does not simulate database crash during COMMIT or disk loss.
- A PostgreSQL trigger intentionally rejects audit inserts in failure tests. Both source/import writes and approval writes roll back, then succeed after the injected failure is removed.
- `scripts/local-db.ps1` recognises the isolated local cluster. The cluster was successfully initialised and started with PostgreSQL tools; the helper's stop/start path was not exercised. Setup generates random local secrets and refuses existing `.env` files.
- Bicep compiled with the official **v0.47.16** compiler without errors or warnings. Compose configuration validated. Local Docker image execution was unavailable because the Docker daemon was not running.

## Browser walkthrough

Verified in Brave at the local URL `http://127.0.0.1:4318`:

1. Local access and reconnection after page reload.
2. Invoice sample: 4 accepted; payment sample: 3 accepted, 1 duplicate, 1 rejected, 1 conflicting.
3. Payment replay: same saved result, still 2 imports, no extra entries.
4. Exact €1,250.00 approval and reviewed €480.00 reference/source-conflict approval.
5. Total €1,730.00, 2 approvals, 4 audit events; €75.00 partial payment remains open.
6. Source inspector exposes original and normalised values, rejected amount and conflicting row evidence.
7. Narrow 390 × 844 layout and source dialog: no page horizontal overflow. Desktop layout checked separately; native modal closes with Escape and restores focus.

No performance benchmark, user study, production deployment, tenant isolation or real-money outcome is claimed. Shared keys identify viewer/reviewer roles rather than individual people. The sample sandbox contains no real client records.

## Hosted delivery

The PR's GitHub Actions run is authoritative for Linux/PostgreSQL/container execution. Local checks and Bicep compilation alone do not establish hosted CI or Azure operation. Refer to the draft PR for the exact revision and run result. No Azure resources were provisioned and no cloud cost ceiling was agreed.
