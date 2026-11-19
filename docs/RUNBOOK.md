# Local failure and recovery runbook

Status: **draft until PostgreSQL 17 integration and HTTP Compose demo are executed**. All examples require synthetic data and the local test databases.

## Read-only diagnosis

1. `GET /health` checks process liveness; `GET /ready` checks the API's DB dependency. Do not interpret `/health` as a successful delivery.
2. `npm run jobs:inspect -- <event-id>` prints the job state, lease, attempt history and last error class. `PENDING` means due later; `LEASED` means claimed until lease expiry; `DEAD` means no further automatic attempt.
3. For the fake receiver, query `receiver_attempt_counts` and `receiver_receipts` **in receiver_db**, independently of the gateway database. Receipt count is the effect oracle; attempts count is the physical HTTP delivery count.

## Simulate a transient failure

1. In a **fresh disposable test DB**, create a synthetic event and inspect its `delivery_id`.
2. Stop the worker so it cannot race configuration changes.
3. Configure `npm run receiver:fault-plan -- <delivery-id> --transient-fails 2`.
4. Start the worker. Expect two retryable 503 attempts, then a success. Inspect both DBs and timestamps.

## Dead-letter and operator replay

1. Stop the worker, then configure `npm run receiver:fault-plan -- <delivery-id> --permanent 422`.
2. Start the worker and observe `DEAD` with one attempt; do not claim the job is lost.
3. Repair the synthetic fault plan in receiver DB, then issue `npm run jobs:replay -- <job-id> --reason reviewed-and-repaired-test-fault`.
4. Verify a new replay generation, monotonic attempt numbering, an audit record and final `SUCCEEDED`. Replaying a `SUCCEEDED` job must be rejected.

## Worker restart and uncertain remote outcome

If a worker stops while its job is `LEASED`, the lease expires and another worker can retry. A remote receipt may already have committed. Confirm **the same stable `delivery_id`** was reused, the receiver saw repeated physical deliveries, and the receiver still has exactly one effect. Do not manually erase or reset job rows to "fix" a pending job.

## Safety

- Use only local Docker Compose and synthetic secrets.
- Never run integration tests against the demo `gateway_db` or any client DB; the suite explicitly accepts only `gateway_test*` and `receiver_test*` database names.
- Never delete named volumes or reset Docker Desktop to clear test data. `docker compose -f compose.test.yaml down` removes the disposable test container; do not use it against unrelated projects.
- This runbook is not incident-management certification, an SLO or a production SLA.
