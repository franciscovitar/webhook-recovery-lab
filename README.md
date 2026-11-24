# Webhook Recovery Lab

> **Product direction (24 Nov 2026):** evolve the existing engine into a real, no-login, isolated synthetic **Webhook Operations Console** with a single-service hosting candidate and US$0 additional budget. See [current V3 architecture and UX](docs/PRODUCT_ARCHITECTURE_V3.md). The browser-only showcase remains technical evidence. V3 is design only; hosting preflight and implementation remain pending.

<p><strong>Status: V1 implementation merged into main; verified in local and hosted CI checkpoints — not production software.</strong></p>

A small, failure-aware backend for **signed incoming webhooks** and durable delivery jobs, built with TypeScript, Fastify and PostgreSQL. All events are synthetic. The goal is to demonstrate reliability boundaries with tests, not to simulate production experience.

Architecture and planned fault scenarios: [PAS design review #668](https://github.com/franciscovitar/personal-ai-system/pull/668).

## Implemented in main

- HMAC-SHA256 signature over `timestamp + '.' + raw request bytes`, including a replay window and constant-time comparison.
- Strict JSON event schema, body limit, explicit HTTP errors and independent `/health` and `/ready` checks.
- Transactional PostgreSQL inbox + delivery job. Returns `202` only after commit, deduplicates by `(provider, event_id)` and returns `409` if the same identity is reused with changed bytes.
- SQL migration with named database constraints, unit tests and PostgreSQL integration tests (the latter **require a running database** and never silently skip).
- Separate worker process with short `SKIP LOCKED` claims, 15-second leases, fencing token, capped retry/backoff, dead-letter state and audited replay generations.
- Synthetic receiver with a separate `receiver_db`, stable `delivery_id`, idempotent receipts, local fault-plan CLI and explicit attempt counters.
- Runbook and architecture decisions in [docs](docs/DECISIONS.md), read-only operational snapshots in [observability](docs/OBSERVABILITY.md), the [engineering case study](docs/CASE_STUDY.md), and the [architecture/security review](docs/SECURITY_REVIEW.md).

**Verification status (local run, 2026-11-19, commit `79355ef`):** typecheck, lint, build and 21 unit tests pass. The 8 integration tests (0 skipped) pass against PostgreSQL 17.12 started from `compose.test.yaml`, and were stable over three consecutive runs: concurrent duplicate ingress (20 connections, one row), changed-payload `409`, six workers competing for one job, 503 retries, a worker crash after receiver success (two deliveries, one receipt), stale-ACK rejection after lease reclaim, and dead-letter with audited replay. Rollback of the inbox row when the job insert fails was additionally checked by hand with a temporary trigger; it is **not** an automated test.

**Subsequent hosted checkpoints:** [CI #44534829515](https://github.com/franciscovitar/webhook-recovery-lab/actions/runs/44534829515) verified the multi-service Compose smoke after real PostgreSQL test suites; [CI #44538366466](https://github.com/franciscovitar/webhook-recovery-lab/actions/runs/44538366466) is another successful PR run. These are historical branch-linked CI observations, not production experience or automatic proof of future changes.

## Public interactive console

The independent `showcase/` folder demonstrates signed ingress, duplicates, worker crash after receiver commit, lease recovery, bounded retry and replay through a synthetic JavaScript state model. It is intended for public hosting on Vercel, **not** for hosting the Fastify/PostgreSQL/worker backend. No real HMAC verification, network request, Postgres process or API is run from the browser. Run its tests via `cd showcase && npm test`. The underlying repository stays private unless its owner explicitly changes visibility.

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

The integration suite fails if either test URL is missing, not isolated, or PostgreSQL is unreachable. Mutable tests require the **exact** `gateway_test` and `receiver_test` names on a loopback host, without connection-string query or fragment overrides. These commands require Docker. Passing unit tests alone does not verify transactions, SQL constraints or concurrency; the integration results above come from running exactly these commands. A test failure should be investigated before any claim of recovery or correctness.

The repository declares LF line endings in `.gitattributes`. Older Windows checkouts with `core.autocrlf=true` may still have a CRLF working tree: `npx prettier --check . --end-of-line crlf` can diagnose that checkout artifact. Do not reformat unrelated changes to fix it.

## Repeatable recovery demo and CI

After setting up the two disposable `gateway_test` and `receiver_test` databases and running migrations as above, run:

```bash
npm run demo:scenario -- --run-id local-001
```

The script binds real API and receiver HTTP listeners to ephemeral loopback ports, uses both PostgreSQL test databases and prints a fixed transcript for signed ingress, duplicate/conflict, 503 retries, a simulated crash before ACK, and a dead-letter/replay cycle. It refuses non-local or non-test database names and rejects repeated run IDs before writing. It does **not** start or verify the multi-container Compose demo. Use a new run ID for subsequent runs or recreate the disposable test stack.

The pull-request workflow [`.github/workflows/ci.yml`](.github/workflows/ci.yml) uses Node 24 and PostgreSQL 17, runs migrations, checks static analysis, executes unit/integration suites, rejects skipped or missing cases from machine-readable reports, and invokes the HTTP demo. It also builds and starts the five-service demo Compose stack under a unique CI project name, sends a signed webhook to the containerized API and verifies the worker's durable success and receiver's single receipt against both databases. It collects Compose logs on failure and stops only the uniquely named CI stack without deleting volumes. A workflow file alone is not evidence: inspect the actual commit-linked GitHub Actions run and logs for results.

## Read-only diagnostics and bounded probe

Run `npm run ops:snapshot` with `DATABASE_URL` (and optionally `RECEIVER_DATABASE_URL`) to print queue states, due work, expired leases, last-hour attempts and receiver receipts without mutating data. Missing receiver data is reported as `null`, not as a fabricated zero. See [signal definitions and limits](docs/OBSERVABILITY.md).

PR CI also runs a **bounded functional probe** of 40 synthetic events at concurrency 8 against the full Compose stack. It checks that every accepted event produces a durable succeeded job and exactly one receiver receipt. It prints observed ingress p50/p95 and throughput for that single CI runner, with **no claimed SLO, capacity estimate or load-test certification**. The [case study](docs/CASE_STUDY.md) separates measured evidence from architectural claims.

**Prior CI evidence:** [run #44536380766](https://github.com/franciscovitar/webhook-recovery-lab/actions/runs/44536380766) verified 25 unit and 13 PostgreSQL integration tests (0 skipped), scripted recovery, full Compose smoke, a 40-event bounded functional probe and read-only queue diagnostics. Newly added security/rollback tests require their own commit-linked run.

## Security review and exposure boundary

See [docs/SECURITY_REVIEW.md](docs/SECURITY_REVIEW.md) for the explicit trust boundaries and the production-exposure gates. The review hardens the integration test database guard and adds an automated PostgreSQL rollback fault test. This remains a **synthetic, local-only laboratory**: do not publicly deploy it with the demo keys, lack of rate limiting, and no external TLS/secret-management plan. A green CI run is not a vulnerability scan or production certification.

## Technical decisions

An inbox row and its job share one transaction; the HTTP handler never calls the downstream system. This deliberately avoids acknowledging an event that would be lost before persistence. A `409` on mismatched payload protects against accidentally reusing an event identity.

The worker is designed for **at-least-once attempts**, not exactly-once delivery to an external service. Recovery after a crash may require redelivery, and the receiver enforces idempotency with a stable `delivery_id` in its own database. This behavior is exercised by the real-DB integration tests, which passed in the local run above; the end-to-end Compose path is not yet verified.

Security boundaries: local-only synthetic keys, no public administrative endpoints, no user-controlled destinations, no raw body or secret in logs, and no external hosting.
