# Inception — Reconciliation Workbench

Build a small, independent personal portfolio application for synthetic invoice/payment reconciliation. The user approved this separate project and its proposed stack: TypeScript, React, Node.js and PostgreSQL. It is not a migration of DocketBench.

## Work scope

- Work only in this repository. Do not modify adjacent repositories or read unrelated CV/credential files in parent directories.
- Use synthetic fixtures written here. Do not copy employer source, schema, prompts, branding, fixtures or client data.
- Start with one invoice CSV and one payment CSV, one currency, exact matching, exception review and a traceable approved result.
- Preserve original source rows separately from normalised fields. Validate all external input, and limit file sizes and row counts.
- Use exact decimal handling or integer minor units for money. Never use an LLM to calculate balances or approve a match.
- Enforce import identity with database constraints and transactional writes. Replaying an import must have one intended effect. Conflicting payloads with the same idempotency key must fail explicitly.
- Test duplicate delivery, concurrent submissions, transaction failure and restart/replay. State exactly which behaviours are implemented.
- Keep the interface keyboard accessible and usable at narrow widths. Show clear errors and review status.

## Smallest useful architecture

One application and PostgreSQL are enough. Prefer Node's built-in HTTP server/test runner and existing/native capabilities. Use a maintained CSV parser if needed for correct quoted-field handling; do not invent a partial parser. Add a worker only when work must survive an HTTP request. No generic workflow engine, microservices, Kafka, Kubernetes, banking integrations, tax engine or multi-currency support in v1.

## Delivery

- Implement in tested vertical slices and small commits on a feature branch. Preserve main as the current reviewed baseline.
- Stage explicit paths and inspect staged diffs for secrets and unrelated files. Never print tokens or commit credentials, generated output, local data or CV files.
- Use only already authorised credentials through their normal tools. No credential searches outside this repository.
- Provide reproducible setup, migrations and focused correctness tests. Do not substitute an in-memory fake for PostgreSQL while claiming database behaviour is verified.
- Open small draft PRs in this repository. Document local checks and exact hosted CI evidence separately.
- Prepare Azure deployment configuration after the local path works. Do not provision paid resources without a concrete cost ceiling confirmed by the user.
- AI explanations are optional after the deterministic workflow works. Cached or synthetic output must never be presented as a live model response.
