# Inception — Reconciliation Workbench

A personal portfolio project for reviewing synthetic invoice and payment data.

The first workflow imports one invoice CSV and one payment CSV, validates records, matches exact references and amounts, and sends exceptions for human review. Replaying the same import must not double-count records or money.

## Planned implementation

TypeScript, React, Node.js and PostgreSQL, with Docker, automated checks and an Azure deployment path. Start with one currency and one complete workflow. This repository is independent of any employer application.

## Current status

Project kickoff. The application is not implemented or deployed yet. No test or performance results are claimed.

## Demonstration boundary

Synthetic data only. This is not an accounting product and does not connect to banks, move money, issue legal communications or process real client information.
