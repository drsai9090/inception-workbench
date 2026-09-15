# Deployment preparation

This is a single shared synthetic sandbox. A viewer key permits reads; a separate reviewer key permits imports and approvals. Keys identify roles rather than individual people. There is no tenant isolation, user provisioning or real payment integration. Keep reviewer access private and use synthetic data only.

## Local containers

The repository's primary local path runs Node on the host. Compose starts only an isolated PostgreSQL 18 database at `127.0.0.1:55438`; it does not touch another database or start the application. Set a fresh `POSTGRES_PASSWORD` in your process environment before running:

```powershell
docker compose up --detach --wait
```

Set `DATABASE_URL` in the ignored `.env` to the resulting `inception` database, using user `inception` and the URL-encoded password. The Compose user is an administrator for this disposable local database only. Follow the main README to migrate and start the local application. Stop the repository's native PostgreSQL instance first if it already uses port 55438. Run `docker compose down` to stop containers while keeping the named volume; deleting that volume destroys the synthetic history.

PostgreSQL 18 stores its versioned data beneath the mounted `/var/lib/postgresql` directory. [Official image documentation](https://github.com/docker-library/docs/blob/master/postgres/README.md)

Build the application image from the repository root:

```powershell
docker build --tag inception-workbench:local .
```

The two-stage image builds the React assets and runs Node 24 as the non-root `node` user. Node runs the TypeScript server directly. The Docker build context is an explicit allowlist and excludes `.env`, private files, Git history and local database contents. The image defaults to `HOST=0.0.0.0`, port 4318 and `LOCAL_DEMO=false`; supply the database URL, two distinct access keys of at least 32 characters and the exact `PUBLIC_ORIGIN` through runtime environment variables. Bind a local container's published port to `127.0.0.1`.

Migrations are a separate operation, never an application-start side effect. With `DATABASE_URL` temporarily set to the migration-role connection URL and an image digest in `INCEPTION_IMAGE`, run this from a host whose database route is approved:

```powershell
docker run --rm --env DATABASE_URL "$env:INCEPTION_IMAGE" npm run migrate
```

A container's `127.0.0.1` points to itself. For the host's local database on Docker Desktop, use `host.docker.internal:55438` in the container's connection URL. The PostgreSQL host must permit this connection. Restore the restricted runtime URL before starting the app.

## Azure template

`main.bicep` creates one Container App using an **existing** managed environment in the deployment resource group, with a `Consumption` workload profile. Supply an existing dedicated PostgreSQL database reachable from that environment; this template creates no database, environment, registry or logging workspace. The image must already be publicly pullable. Private registry authentication is outside this slice.

The template constructs an immutable image reference from `imageRepository` plus a 64-character SHA-256 digest. It uses the environment's default domain to configure the application's exact HTTPS origin, disables insecure ingress, exposes target port 4318 and limits replicas to zero through one. Database URL and role keys are secure parameters stored as Container App secrets. Startup and readiness check `/healthz`, which checks database schema availability; liveness checks the TCP listener so a database outage does not repeatedly restart the process. [Container App resource reference](https://learn.microsoft.com/en-us/azure/templates/microsoft.app/2025-07-01/containerapps), [health probes](https://learn.microsoft.com/en-us/azure/container-apps/health-probes)

### Approval and cost boundary

Nothing here provisions or publishes resources automatically. Before publishing an image or running a deployment, confirm the subscription, region, environment, image visibility, PostgreSQL ownership, networking, monthly cost ceiling and teardown owner with the user. **No cost estimate has been measured and no numeric estimate is asserted.** Scale-to-zero is a configuration choice, not a free-hosting guarantee: active compute, requests, the existing database, environment, logging, registry and outbound traffic may cost money. Use the chosen region and expected usage in the [Azure pricing calculator](https://azure.microsoft.com/en-us/pricing/calculator/) before agreeing a ceiling; [budget alerts do not stop consumption](https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/tutorial-acm-create-budgets).

After approval, build/publish the reviewed commit's image and record its registry digest. Create `deploy/.env.azure.parameters.json` locally (ignored by Git), replacing every placeholder. Do not commit this file or place real keys in command lines, shell history, logs or issue descriptions:

```json
{
  "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#",
  "contentVersion": "1.0.0.0",
  "parameters": {
    "environmentName": { "value": "EXISTING_ENVIRONMENT" },
    "location": { "value": "EXISTING_ENVIRONMENT_REGION" },
    "appName": { "value": "inception-workbench" },
    "imageRepository": { "value": "ghcr.io/YOUR_OWNER/inception-workbench" },
    "imageDigest": { "value": "REPLACE_WITH_THE_64_HEX_CHARACTERS_OF_THE_REVIEWED_IMAGE_DIGEST" },
    "databaseUrl": { "value": "RESTRICTED_RUNTIME_URL_WITH_SSLMODE_VERIFY_FULL" },
    "reviewerToken": { "value": "REPLACE_WITH_A_FRESH_RANDOM_REVIEWER_KEY" },
    "viewerToken": { "value": "REPLACE_WITH_A_DIFFERENT_FRESH_RANDOM_VIEWER_KEY" }
  }
}
```

Migrate first with the migration role from an approved network path, grant the runtime privileges below, then review the resource plan. Compile locally before contacting Azure; `tmp` is ignored:

```powershell
New-Item -ItemType Directory -Force tmp | Out-Null
az bicep build --file deploy/main.bicep --outfile tmp/inception-arm.json
az deployment group what-if --resource-group "$env:AZURE_RESOURCE_GROUP" --template-file deploy/main.bicep --parameters '@deploy/.env.azure.parameters.json'
```

Only after the cost ceiling and concrete plan are approved:

```powershell
az deployment group create --name inception-approved --resource-group "$env:AZURE_RESOURCE_GROUP" --template-file deploy/main.bicep --parameters '@deploy/.env.azure.parameters.json'
```

Check the emitted URL's `/healthz`, confirm unauthenticated API calls fail, verify viewer write rejection, and run the synthetic import/approval flow before sharing the URL. The default hostname is the only configured origin; custom domains require a coordinated origin and ingress change.

### Database roles and secrets

Use an independently created database owned by a migration role. The app's runtime login must not own that database, schema or tables and must not have superuser, role-management, schema-creation or migration privileges. Create its password using the database administrator's normal secret-handling process; do not paste passwords into this example. After migration, an owner can grant the existing `inception_runtime` role the following privileges **in this dedicated database only**:

```sql
GRANT CONNECT ON DATABASE inception TO inception_runtime;
GRANT USAGE ON SCHEMA public TO inception_runtime;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT SELECT, INSERT ON import_batches, source_rows, entries, resolutions, audit_events TO inception_runtime;
GRANT UPDATE (counts) ON import_batches TO inception_runtime;
GRANT UPDATE (id) ON entries TO inception_runtime;
```

The column-level `entries.id` grant permits PostgreSQL's `SELECT ... FOR UPDATE` row locks; application code does not modify IDs. Runtime receives no update/delete permission on original rows, amounts or audit records. Audit triggers also reject ordinary updates/deletes; an administrator can still change the database. Test privileges with the real runtime URL before release. Future migrations may require reviewed grants. Never give the hosted app the migration-role URL.

Use a PostgreSQL URL with `sslmode=verify-full` and a certificate valid for its hostname. Keep networking restricted to the approved application environment and migration path. Rotate each shared access key separately, supply fresh secrets through the secure parameter file and deploy a new revision to pick them up. Delete the local secrets file when it is no longer required.

### Rollback and recovery

Record the previous image digest and active revision before deployment. If a release fails, redeploy the previous digest with the same environment and valid secrets; verify readiness and viewer/reviewer behavior. This initial migration is additive and has no automatic down migration. An application rollback does not reverse approved resolutions, imports or database changes. Retain the database and audit history; use a separate reviewed backup/restore procedure when data recovery is required. Reuse the original import key and content after an uncertain response; changed content under that key must fail.

## Verification boundaries

CI installs locked dependencies, checks types, runs unit/HTTP and real PostgreSQL integration tests, builds the React assets and Docker image, migrates the disposable service database using that image, and checks container readiness plus unauthenticated/viewer access. Actions are pinned to commits verified from the official `actions/checkout` and `actions/setup-node` repositories. Inspect the actual run for the PR's exact commit before calling CI passed.

Local Docker engine availability and hosted Azure behavior are separate from source/test verification. The template's existence or successful compilation is not evidence of a cloud deployment, cloud cost, certificate setup, network access or hosted isolation.

Local configuration verification: Bicep CLI 0.47.16 compiled this template without warnings or errors; `docker compose config --quiet` accepted the Compose file. A temporary restricted role in the isolated PostgreSQL test database successfully imported and approved synthetic rows using the documented grants, while amount updates, audit deletion and schema creation were denied. Docker image build/run was not executed locally because the Docker engine was unavailable. No Azure resources were provisioned.
