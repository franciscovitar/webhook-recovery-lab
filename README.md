# Webhook Recovery Lab

<p><strong>Status: implementation in progress — not production software.</strong></p>

A small, failure-aware backend for **signed incoming webhooks** and durable delivery jobs, built with TypeScript, Fastify and PostgreSQL. All events are synthetic. The goal is to demonstrate reliability boundaries with tests, not to simulate production experience.

Architecture and planned fault scenarios: [PAS design review #668](https://github.com/franciscovitar/personal-ai-system/pull/668).

## Implemented in this first checkpoint

- HMAC-SHA256 signature over `timestamp + '.' + raw request bytes`, including a replay window and constant-time comparison.
- Strict JSON event schema, body limit, explicit HTTP errors and independent `/health` and `/ready` checks.
- Transactional PostgreSQL inbox + delivery job. Returns `202` only after commit, deduplicates by `(provider, event_id)` and returns `409` if the same identity is reused with changed bytes.
- SQL migration with named database constraints, unit tests and PostgreSQL integration tests (the latter **require a running database** and never silently skip).

**Not implemented yet:** worker, asynchronous attempts, backoff/leases/dead-letter, mock receiver, replay CLI, full fault-injection demo and hosted CI verification. The database schema includes tables reserved for those components, but that is not evidence that their behavior exists.

## Local setup

Prerequisites: Node.js 24 LTS, npm, Docker Desktop/Engine with Docker Compose.

```bash
docker compose up --build -d db migrate api
curl http://localhost:3000/health
curl http://localhost:3000/ready
```

This uses a **local-only demo secret**, port `3000` for API and `5436` for PostgreSQL, bound to loopback on the host. Replace secrets before any exposure beyond a local test machine. Never feed it real provider/customer data. Containers and volumes are not automatically removed by the commands above.

To send a signed event from the host, create a local `.env` file from `.env.example` (the placeholder key matches Compose), then run `npm ci` and `npm run demo:ingress`. The script only targets loopback HTTP and generates a synthetic order event. The ingress contract is `POST /v1/webhooks/sandbox` with `X-WRL-Key-Id`, `X-WRL-Timestamp`, and `X-WRL-Signature` headers.

## Validation

```bash
npm ci
npm run typecheck
npm run lint
npm run format:check
npm run test:unit
```

To execute PostgreSQL integration tests, migrate the database and set `TEST_DATABASE_URL` to a **test-only** database. The migration command uses `DATABASE_URL` and is non-destructive to existing data; do not point tests at the demo or a client database.

```bash
npm run migrate
npm run test:integration
```

The integration suite fails if `TEST_DATABASE_URL` is missing or PostgreSQL is unreachable. Passing unit tests alone **does not** verify transactions, SQL constraints or concurrency.

## Technical decisions

An inbox row and its job share one transaction; the HTTP handler never calls the downstream system. This deliberately avoids acknowledging an event that would be lost before persistence. A `409` on mismatched payload protects against accidentally reusing an event identity.

When the worker is built, it will provide **at-least-once attempts**, not a claim of exactly-once delivery to an external service. Recovery after a crash may require redelivery, and the receiver must enforce idempotency on its own side.

Security boundaries: local-only synthetic keys, no public administrative endpoints, no user-controlled destinations, no raw body or secret in logs, and no external hosting.
