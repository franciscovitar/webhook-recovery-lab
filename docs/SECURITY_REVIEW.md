# Architecture and security review — 2026-11-19

**Scope:** source review of the feature branch and its executable tests,
focused on an **isolated, synthetic local/CI laboratory**. This is not a
penetration test, vulnerability scan, production readiness certificate,
or permission to deploy the API on the public internet.

## Trust boundaries

| Boundary                      | Implemented control                                                                                                                           | Evidence or limit                                                                                                                                                                  |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Synthetic sender → Fastify    | Raw-byte HMAC-SHA256, named key, ±5-minute timestamp window, constant-time digest comparison                                                  | Unit tests for valid, tampered, malformed and stale/future signatures; [GitHub webhook guidance](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries) |
| Untrusted payload → domain    | 64 KiB body limit, strict event schema and UUID/type validation                                                                               | Invalid JSON, extra fields and oversized-body tests                                                                                                                                |
| API → gateway PostgreSQL      | Parameterized queries, one transaction for inbox + job, unique event identity and immutable payload hash comparison                           | Concurrent dedupe, conflict and **job-insert fault/rollback** integration tests                                                                                                    |
| Gateway → worker              | Short `SKIP LOCKED` claim, finite retries, expiring lease and fencing token                                                                   | Multi-worker, final-attempt exhaustion, crash and stale-ACK integration tests                                                                                                      |
| Worker → fake receiver        | Internal token, fixed operator-configured destination and stable `delivery_id`                                                                | Receiver auth/contract tests and separate-DB idempotent receipt assertions                                                                                                         |
| Operator → replay / diagnosis | No public admin HTTP routes; local CLIs, audited replay generation, fixed-cardinality read-only snapshot                                      | Replay audit tests; no credentials or raw payload in snapshot                                                                                                                      |
| Container → host              | Dockerfile runs the app as non-root; API and PostgreSQL demo ports bind to loopback                                                           | Full Compose CI smoke; local-only default credentials, **not production secrets**                                                                                                  |
| PR → CI runner                | Read-only GitHub token permission, immutable action SHAs, locked npm install, PostgreSQL service, no-skips checks and scoped Compose teardown | Commit-linked green workflow runs in PR description                                                                                                                                |
| Test harness → database       | **Exact `gateway_test`/`receiver_test` name, loopback host and no URL query overrides**                                                       | Negative guard tests; refuses remote/lookalike/demo DBs before connecting                                                                                                          |

The two PostgreSQL databases **do not participate in a distributed
transaction**. The system promises at-least-once physical delivery and one
durable receiver receipt for the same `delivery_id`; it never claims
exactly-once HTTP transport.

## Concrete improvements from this review

1. Tightened the integration test URL guard. Prefix matching previously
   allowed a lookalike name or a remote host. Only the two exact local
   disposable database names now pass, without connection-string query
   overrides. Negative unit tests cover these cases.
2. Promoted the previously manual inbox/job atomicity fault injection into
   an automated PostgreSQL integration test. A trigger that rejects one
   synthetic job insert must produce a `503`, leave no inbox row and let a
   subsequent sender retry create exactly one event and job. The trigger is
   dropped in `finally`; it never runs against a demo/client database.

These changes should be considered _proposed_ until their commit's CI run
passes. Local static checks and unit tests alone are not evidence of
PostgreSQL rollback semantics.

## Open risks and deployment gates

| Finding                                                      | Consequence if publicly deployed                                        | Required before production exposure                                                                                                                                                    |
| ------------------------------------------------------------ | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Static synthetic signing token and receiver token in Compose | Anyone knowing a published demo key can forge accepted synthetic events | Secrets manager, per-environment keys, rotation and access controls                                                                                                                    |
| No ingress rate limiting or resource quotas                  | Authorized or unauthorized bursts could exhaust app/DB resources        | Reverse proxy/API gateway throttles, admission controls and capacity tests; OWASP [webhook security](https://cheatsheetseries.owasp.org/cheatsheets/Webhook_Security_Cheat_Sheet.html) |
| No transport security or public admin authentication design  | Unsafe to cross untrusted networks or expose operator workflows         | TLS, identity/authorization and network isolation                                                                                                                                      |
| No centralized metrics, traces, alerts or measured SLO       | Failures may go unnoticed; recovery targets are undefined               | Agree objectives, instrument and test alerts, operational ownership                                                                                                                    |
| Docker base images use moving tags                           | Builds may pull different underlying images over time                   | Reproducible image digest policy and vulnerability scanning; [Docker build guidance](https://docs.docker.com/build/building/best-practices/)                                           |
| Dependency/OS vulnerability scan not run in this review      | Known vulnerabilities are not ruled out                                 | Audit dependencies and scan built images in an authorized environment                                                                                                                  |
| No documented backup/restore or retention process            | Database loss and unlimited history may be unmanageable                 | Recovery drills, retention/deletion policy and schema-change procedure                                                                                                                 |
| No branch protection or release approval evidenced           | CI success alone does not enforce review/merge policy                   | Confirm required checks, protected main and deployment approval                                                                                                                        |

Current mitigations are **loopback-bound, synthetic-only configuration and no
cloud deployment**. Do not silently treat them as sufficient controls if the
project's purpose or exposure changes.

## Acceptance boundary

For this portfolio V1, a reasonable endpoint is: typed/linted code, reliable
PostgreSQL and Compose tests, automated security/rollback regressions,
reproducible synthetic demo, read-only operational diagnostics, and a case
study with verified evidence. Passing those checks validates the **lab**;
it does not resolve the production deployment gates above.
