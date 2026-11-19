# Decision log — Webhook Recovery Lab

Status: **implementation under review**, not production. Sources and constraints follow [the PAS architecture draft](https://github.com/franciscovitar/personal-ai-system/pull/668).

## ADR-001 — PostgreSQL queue in V1

The inbox event and delivery job are committed atomically in the **same PostgreSQL transaction**. The worker polls and claims due rows using `FOR UPDATE ... SKIP LOCKED`, with a separate lease to survive process termination. This avoids a second persistence system and makes transaction semantics testable.

Tradeoff: PostgreSQL queues are not an equivalent replacement for Kafka/SQS at arbitrary throughput. `SKIP LOCKED` deliberately returns an inconsistent queue-like view and does not promise fairness or global delivery order. We will only claim the bounded V1 guarantees that tests prove.

Source: https://www.postgresql.org/docs/17/sql-select.html

## ADR-002 — Acknowledge after durable commit

Signature verification and schema validation happen **before** persistence. The API returns HTTP 202 only once both inbox and job are committed. Database outage returns 503, allowing the sender to retry. Unique `(provider,event_id)` prevents simultaneous duplicate inserts; a changed payload with the same ID returns 409.

Tradeoff: a sender may lose the HTTP response after the DB commits. That is why redelivery must be safe and expected.

References: https://docs.stripe.com/webhooks ; https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries

## ADR-003 — At-least-once attempts, receiver-side idempotency

After claiming a job in a short transaction, the worker performs HTTP **without holding the row lock**. Every claim has a lease token. The worker's later ACK only applies if the token still matches the job; expired claims can be reclaimed.

The receiver is a separate service with a **different logical database**, not part of the originating transaction. If it commits a receipt but the worker dies before its local ACK, delivery happens again. The stable `delivery_id` and receiver's uniqueness constraint ensure one logical effect within this fake receiver. We **do not** claim exactly-once end-to-end behavior with arbitrary third parties.

Reference: https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/

## ADR-004 — Finite retries, dead-letter and replay generations

Automatic retries are restricted to 408, 429, 500, 502, 503, 504 and network failures. Retry delay uses capped exponential backoff with injected jitter. A generation has a budget of five attempts; permanent HTTP failures or exhaustion move a job to `DEAD`.

Operator replay is a **CLI-only** action with a reason and audit row. It increments `replay_generation`, resets only the per-generation budget, and preserves the monotonic attempt sequence. This avoids silent resets and makes recovery inspectable.

Tradeoff: no automatic alerting, long-term retention policy, backpressure circuit breaker or multi-tenant rate control in V1.

Reference: https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/retry-backoff.html

## ADR-005 — Scope and trust boundary

Events, secrets and receiver faults are **synthetic**. The sender's HMAC and a replay window protect the ingress; the internal receiver requires a distinct bearer token and cannot be targeted by a URL from the webhook body. Docker demo ports bind only to loopback, and receiver/worker only communicate on Compose's private network.

This is a local laboratory, not a deployable payment-webhook gateway. Before public exposure it would need actual authentication/authorization for ops, key rotation, TLS termination, rate limits, secret management, retention policy and an operational security review.
