# V3 implementation checkpoint — guest persistence foundation

2026-11-24. Parent main: 741e9bc751608eb28ad154d9b9983463bbd43b26.
PAS: b14e7cf58c416572c54b0592e755d870b0dc889b.
Canonical design: [PRODUCT_ARCHITECTURE_V3.md](PRODUCT_ARCHITECTURE_V3.md).
Owner authorized implementation on a separate branch. No provisioning, publication, main merge or deployment.

## Implemented in this checkpoint (source only)

- Ordered migration manifests for gateway and receiver, preserving prior 0001 migration IDs and content,
  existing commands and transaction/advisory-lock behavior.
- Additive gateway migration 0002 with durable guest workspace identity, credential digest, lifetime and closure.
- Cryptographically random 256-bit opaque credentials, canonical input validation and SHA-256 digest lookup.
- Serialized database admission, with the proposed initial limits: 30 active, 10 new/hour, 24h expiry.
- Unit and real-PostgreSQL integration test sources for token validation, migration replay, session lookup,
  expiration, closure and concurrent admission.

No public route or cookie has been added. Existing event/job/receiver ownership is NOT yet scoped; this is
not a complete isolation implementation and must not be exposed publicly. Cleanup and request-level abuse
limits are still needed; deleting recent guest records must not weaken the admission window. Do not
automatically create a new guest on an expired/invalid credential without a deliberate session-start flow.

## Verification and continuation

Source review and Git readback only; Node 24, dependencies, PostgreSQL and Docker are not available as a
repository-aware runtime in this chat. New tests have not been executed. Do not count them as passing.
No private hosted CI used as a debugging runner. Main and the existing static showcase remain unchanged.

Next in Codex: checkout this branch safely, preserve existing work, use Node 24 and the lockfile, run baseline
and changed tests against disposable loopback gateway_test/receiver_test. Verify old-schema upgrade and
migration reruns. Correct any type/lint/format issues. Then implement scoped inbox/event/recovery/receiver
contracts with real HMAC and HTTP delivery, cookie/Origin enforcement, quotas and cleanup, bounded worker
scheduler, same-origin React/Vite frontend. Add real browser tests. Read the V3 acceptance criteria; finish
the core journey rather than extending scope. Keep costs at US$0 additional. Do not modify Library Network,
create cloud resources, change repository visibility or deploy without separate authorization.
