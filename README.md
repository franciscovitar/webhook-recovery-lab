# Webhook Recovery Lab

<p><strong>Status: implementation in progress — not production software.</strong></p>

A small, failure-aware backend for **signed incoming webhooks** and durable delivery jobs, built with TypeScript, Fastify and PostgreSQL. All events are synthetic. The goal is to demonstrate reliability boundaries with tests, not to simulate production experience.

Architecture and planned fault scenarios: [PAS design review #668](https://github.com/franciscovitar/personal-ai-system/pull/668).

## Implemented in the current development branch

- HMAC-SHA256 signature over `timestamp + '.' + raw request bytes`, including a replay window and constant-time comparison.
- Strict JSON event schema, body limit, explicit HTTP errors and independent `/health` and `/ready` checks.
- Transactional PostgreSQL inbox + delivery job. Returns `202` only after commit, deduplicates by `(provider, event_id)` and returns `409` if the same identity is reused with changed bytes.
- SQL migration with named database constraints, unit tests and PostgreSQL integration tests (the latter **require a running database** and never silently skip).
- Separate worker process with short `SKIP LOCKED` claims, 15-second leases, fencing token, capped retry/backoff, dead-letter state and audited replay generations.
- Synthetic receiver with a separate `receiver_db`, stable `delivery_id`, idempotent receipts, local fault-plan CLI and explicit attempt counters.
- Runbook and architecture decisions in [docs](docs/DECISIONS.md).

**Verification status:** TypeScript, unit tests, lint and build are locally executable. **The actual PostgreSQL SQL, locking, Compose boot and end-to-end behavior have not yet been verified against a live server**. A complete deterministic scripted demo and hosted CI evidence are still pending. Source code presence alone is not proof of the DB guarantees.

## Local setup

Prerequisites: Node.js 24 LTS, npm, Docker Desktop/Engine with Docker Compose.

```bash
docker compose up --build -d db migrate api receiver worker
curl http://localhost:3000/health
curl http://localhost:3000/ready
```

This uses **local-only demo secrets**, port `3000` for API and `5436` for PostgreSQL, bound to loopback on the host. The receiver is internal to the Compose network and does not publish a port. The cluster contains two logical databases (`gateway_db`, `receiver_db`) so their transactions cannot be combined. Replace secrets before any exposure beyond a local test machine. Never feed it real provider/customer data. Containers and volumes are not automatically removed by the commands above.

To send a signed event from the host, create a local `.env` file from `.env.example` (the placeholder key matches Compose), then run `npm ci` and `npm run demo:ingress`. The script only targets loopback HTTP and generates a synthetic order event. The ingress contract is `POST /v1/webhooks/sandbox` with `X-WRL-Key-Id`, `X-WRL-Timestamp`, and `X-WRL-Signature` headers.

## Validation

```bash
npm ci
npm run typecheck
npm run lint
npm run format:check
npm run test:unit
```

To execute PostgreSQL integration tests, start the **disposable test stack** (port `5437`, no named volume). Use separate test DBs: `gateway_test` and `receiver_test`. The suite refuses demo/client database names. In PowerShell:

```powershell
docker compose -f compose.test.yaml up -d
$env:DATABASE_URL = "postgres://wrl_test:synthetic_test_only@127.0.0.1:5437/gateway_test"
$env:RECEIVER_DATABASE_URL = "postgres://wrl_test:synthetic_test_only@127.0.0.1:5437/receiver_test"
npm run migrate
npm run migrate:receiver
$env:TEST_DATABASE_URL = $env:DATABASE_URL
$env:TEST_RECEIVER_DATABASE_URL = $env:RECEIVER_DATABASE_URL
npm run test:integration
docker compose -f compose.test.yaml down
```

The integration suite fails if either test URL is missing, not isolated, or PostgreSQL is unreachable. These commands require Docker and are **instructions, not observed test results**. Passing unit tests alone does not verify transactions, SQL constraints or concurrency. A test failure should be investigated before any claim of recovery or correctness.

## Technical decisions

An inbox row and its job share one transaction; the HTTP handler never calls the downstream system. This deliberately avoids acknowledging an event that would be lost before persistence. A `409` on mismatched payload protects against accidentally reusing an event identity.

The worker is designed for **at-least-once attempts**, not exactly-once delivery to an external service. Recovery after a crash may require redelivery, and the receiver enforces idempotency with a stable `delivery_id` in its own database. This behavior is the target of the real-DB integration tests, not yet a verified outcome.

Security boundaries: local-only synthetic keys, no public administrative endpoints, no user-controlled destinations, no raw body or secret in logs, and no external hosting.
