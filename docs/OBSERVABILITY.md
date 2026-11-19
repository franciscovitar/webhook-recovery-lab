# Operations signals and diagnostic boundaries

This is a **local-only reliability laboratory**, not a monitored production service.
The data source for operational snapshots is PostgreSQL, because in-memory worker
counters would disappear during the very crashes this project is meant to study.

## Read-only snapshot

With `DATABASE_URL` configured, run `npm run ops:snapshot`. Set
`RECEIVER_DATABASE_URL` as well to include the independent receiver's counters.
The command runs only `SELECT` queries and prints JSON. It exposes no HTTP admin
endpoint and does not include event payloads, order IDs, signing keys or tokens.

| Signal                                     | Definition                                                             | Why it matters                  |
| ------------------------------------------ | ---------------------------------------------------------------------- | ------------------------------- |
| `jobs.pending`                             | Jobs waiting for a claim or a retry                                    | Backlog size                    |
| `jobs.due_pending`                         | Pending jobs whose scheduled time has passed                           | Work currently eligible         |
| `jobs.leased`                              | Jobs claimed by a worker                                               | Work in progress                |
| `jobs.expired_leases`                      | Leased jobs whose lease deadline passed                                | Crash/stall recovery candidates |
| `jobs.dead`                                | Jobs with no automatic retries remaining                               | Operator intervention backlog   |
| `jobs.oldest_due_age_seconds`              | Age of oldest due pending job; `null` when none                        | Queue delay diagnostic          |
| `last_hour.ingested`                       | Inbox events committed during the past hour                            | Input volume                    |
| `last_hour.attempts_*`                     | Delivery attempt records started in the past hour, by final result     | Retry and failure diagnostics   |
| `last_hour.delivery_latency_p50_ms/p95_ms` | Receiver HTTP latency for successful attempts started in the past hour | A narrow delivery-latency view  |
| `receiver.receipts_*`                      | Durable receipts in the separate receiver database                     | Effects, not just sends         |
| `receiver.deliveries_observed_total`       | Sum of physical sends seen by the receiver                             | At-least-once amplification     |

The `receiver` field is **null** if that database was not queried. It must not be
interpreted as zero receipts. The gateway query is one PostgreSQL statement;
the receiver query is separate. There is no transaction or atomic snapshot
spanning the two databases, and `collected_at` is the CLI sampling time.

Counts are lifetime totals unless marked `last_hour`; this is a read-only
diagnostic, not an optimized time-series exporter. Full-table aggregates can
become expensive on a large database, so this implementation is intentionally
not a public or high-frequency polling endpoint. No alert rules or SLOs are
configured or claimed.

## Log correlation

The worker emits structured JSON with `job_id`, `event_id`, `delivery_id`,
attempt ordinal, replay generation, downstream HTTP result and whether the
fencing-token ACK succeeded. These are synthetic identifiers. Do not add raw
webhook bodies, credentials or personal data to logs. The API exposes separate
`/health` (process alive) and `/ready` (database dependency) endpoints.

## Suggested investigation order

1. Check `/ready`, then take a snapshot and inspect `due_pending`,
   `oldest_due_age_seconds`, `expired_leases` and `dead`.
2. Use `npm run jobs:inspect -- <event-uuid>` for one synthetic event and
   correlate its job/delivery ID with the worker's structured logs.
3. Check receiver receipts **separately**: two HTTP sends with one durable
   receipt are expected after some failures, not duplicate side effects.
4. For a `DEAD` job, identify and repair the synthetic fault before operator
   replay. Do not reset counters or overwrite history.

No numeric alert thresholds are prescribed: setting useful ones requires
measured traffic, service objectives and an actual deployment. For broader
telemetry in a production design, use an authenticated exporter and
centralized logs/traces with retention and privacy controls.

References: [PostgreSQL aggregates](https://www.postgresql.org/docs/17/functions-aggregate.html),
[Prometheus instrumentation guidance](https://prometheus.io/docs/practices/instrumentation/),
[OpenTelemetry observability primer](https://opentelemetry.io/docs/concepts/observability-primer/).
