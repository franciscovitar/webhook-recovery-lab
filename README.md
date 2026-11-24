# Webhook Recovery Lab

**A functional webhook operations console for synthetic orders.**

[Open the live app](https://webhook-recovery-lab-v3-qa-franv-20261124.onrender.com) · [Engineering case study](https://franciscovitar.vercel.app/work/webhook-recovery-lab)

Send a signed test event, inspect its delivery, deliberately reject a delivery, restore the receiver and replay it. No account is needed. The Spanish-language interface uses real HTTP processing and PostgreSQL persistence, not an in-memory simulation.

## Try it

1. Open the app and create a test order with a normal delivery.
2. Inspect the event and resend its identical payload to observe deduplication.
3. Choose a controlled failure, open Recovery (Recuperación), restore the receiver and replay the delivery.
4. Inspect recorded attempts and technical details. Each browser has its own temporary workspace.

The public sandbox uses fictional data only. Free hosting may take about a minute to wake; quotas and temporary workspace expiration apply. This is a portfolio demonstration, not a production webhook platform.

## Architecture

React/Vite and Fastify share one Render Free service with an event-driven worker and a loopback-only HTTP receiver. Two logical PostgreSQL databases on an independent Neon Free project separate gateway and receiver transactions.

- Signed raw-byte HMAC ingress and transactional inbox/job persistence.
- Workspace-scoped deduplication, bounded quotas, opaque cookie sessions and same-origin mutations.
- Row-locked leases and fencing, bounded retries, audited replay and idempotent downstream effects.
- Safe cleanup of expired workspaces, readiness checks of migration versions and a fixed internal receiver.
- At-least-once delivery attempts, not exactly-once transport.

## Verification and status

The V3 local checkpoint at `c45a0148` documents 32 unit, 29 PostgreSQL integration and 5 showcase tests, build, lint, format and real browser QA. Hosted QA of the earlier UI documented signed ingress, dedupe, failure/recovery, isolation, persistence, cold start and pending-job recovery. The Spanish presentation commit `ec93d2beda58d0678a8c2e9d81596fe69f5ea157` built successfully on Render and went Live on 2026-11-24; the owner approved proceeding with the main merge. The complete automated and browser suite was not rerun for that presentation-only revision.

- [V3 architecture](docs/PRODUCT_ARCHITECTURE_V3.md)
- [Implementation checkpoint](docs/IMPLEMENTATION_V3_CHECKPOINT.md)
- [Local browser QA](docs/qa/v3-visual-2026-11-24/README.md)
- [Spanish presentation](docs/qa/V3_PRESENTATION_ES_20261124.md)
- [Hosted QA and limitations](docs/hosting/NEON_RENDER_DEPLOYMENT_STATUS_2026-11-24.md)

## Run locally

To run it locally, first start the existing PostgreSQL service and install the lockfile dependencies. Set `DATABASE_URL`, `RECEIVER_DATABASE_URL`, `WEBHOOK_SIGNING_KEY_ID`, `WEBHOOK_SIGNING_SECRET` and `INTERNAL_DELIVERY_TOKEN` in `.env`; use only synthetic local secrets. Then apply the additive migrations and build/start the combined service:

```bash
docker compose up -d db
npm ci
npm run migrate
npm run migrate:receiver
npm run build
npm start
```

The API serves the UI at `http://localhost:3000`. For frontend iteration, run `npm run dev:web` in another terminal and `npm run dev` for the API. Local mode uses non-Secure cookies; public mode requires `WRL_PUBLIC_DEMO=true` and an HTTPS `PUBLIC_BASE_URL`, and disables the legacy unscoped webhook route. Do not expose local secrets or use the test databases as application storage.

## Preserved client-side showcase

The independent `showcase/` folder remains unchanged. It demonstrates signed ingress, duplicates, worker crash after receiver commit, lease recovery, bounded retry and replay through a synthetic JavaScript state model. No real HMAC verification, network request, Postgres process or API is run there. Run its tests via `cd showcase && npm test`. The underlying repository stays private unless its owner explicitly changes visibility.

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

See [docs/SECURITY_REVIEW.md](docs/SECURITY_REVIEW.md) for the explicit trust boundaries and the production-exposure gates. The review hardens the integration test database guard and adds an automated PostgreSQL rollback fault test. The original local-only mode must never be publicly deployed with demo keys. V3 uses a separate bounded synthetic public-demo mode; it is not certified for real customer traffic. A green CI run is not a vulnerability scan or production certification.

## Technical decisions

An inbox row and its job share one transaction; the HTTP handler never calls the downstream system. This deliberately avoids acknowledging an event that would be lost before persistence. A `409` on mismatched payload protects against accidentally reusing an event identity.

The worker is designed for **at-least-once attempts**, not exactly-once delivery to an external service. Recovery after a crash may require redelivery, and the receiver enforces idempotency with a stable `delivery_id` in its own database. This behavior is exercised by the real-DB integration tests, which passed in the local run above; the V3 Compose path was subsequently verified at the local checkpoint above.

Security boundaries: synthetic data, protected runtime credentials, no public administrative endpoints, no user-controlled destinations, and no secrets in logs. The hosted V3 sandbox disables legacy unscoped ingress.
