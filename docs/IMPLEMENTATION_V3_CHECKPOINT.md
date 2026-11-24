# V3 implementation checkpoint — isolated operations flow

2026-11-24. Development branch: `feat/webhook-operations-v3`.
Parent checkpoint: `d4164bce8ca40a68affb24c0701cf53fd77b1b2d`.
PAS `main` verified: `b14e7cf58c416572c54b0592e755d870b0dc889b`.
Portfolio policy: `AI/governance/PORTFOLIO_DELIVERY_POLICY.md`.
Cost policy: `AI/governance/INFRASTRUCTURE_COST_GUARDRAIL.md`.
Architecture: [PRODUCT_ARCHITECTURE_V3.md](PRODUCT_ARCHITECTURE_V3.md).

The owner authorized local code changes and disposable local PostgreSQL tests. Additional spend: US$0. No cloud resources, hosted CI diagnostics, deployment, main merge, repository visibility change, or Library Network modification were performed.

## Implemented in this checkpoint

- Additive gateway migrations `0003_scope_events_to_workspaces` and `0004_workspace_replay_idempotency`, and receiver migrations `0002_receiver_workspace_identity` and `0003_receiver_workspace_fault_plans`. Existing `0001` files remain unchanged. Migration manifests retain the transaction and advisory-lock runner.
- Workspace-scoped event identity and dedupe; legacy rows retain their separate unscoped uniqueness rule. Per-workspace event admission is serialized and capped at 10. The original global 10-start/hour and 30-active-workspace limits remain in effect.
- Cookie-backed guest session start/resume, SHA-256 digest lookup, same-origin mutation checks, configurable Secure/HttpOnly/SameSite cookie, and private-mode rejection of the legacy unscoped webhook ingress.
- Scoped overview, event list/detail, deliveries, activity, recovery, restore and replay read/write paths. Replay actions keep their reason and generation in PostgreSQL, accept an idempotency request ID, and stop after two manual generations.
- A permanent-rejection test scenario is prepared at the fixed receiver before its job is made eligible. The worker passes trusted workspace identity to the separately persisted receiver receipt. Restore clears only that workspace's matching receiver fault plan.
- Same-process Fastify composition for API, loopback-only receiver and bounded event-driven worker scheduler. The worker wakes on accepted ingress/replay and schedules against database due times; idle instances do not poll continuously. Gateway/receiver runtime pools reserve four connections total.
- React/TypeScript/Vite operations console served from the API origin. It uses persisted read models, shows actual worker states and attempts, supports keyboard-accessible event detail and responsive navigation, and includes the controlled reject/restore/replay flow. The previous `showcase/` is preserved.

## Verification actually executed

Runtime observed: Node `v24.22.3`, npm `11.19.1`, Docker `29.9.2`, PostgreSQL `17.12`. Disposable loopback databases: `gateway_test`, `receiver_test` on port `5437`.

- `npm run test:unit` — 32 passed, 0 failed.
- `npm run test:integration` — 24 passed, 0 failed, 0 skipped across both disposable databases.
- `npm run typecheck`, `npm run typecheck:web`, and `npm run lint` — passed.
- `npm run build` — TypeScript backend and Vite production bundle built successfully.
- Prettier check on changed source, tests, UI, package files, and README — passed.
- Applied and reran both migration manifests against PostgreSQL; the second run reported existing migrations without reapplying DDL.
- Ran the compiled one-process service locally with the test databases. `GET /` served the Vite app, `GET /ready` checked both databases, and a cookie-scoped signed event traversed ingress → worker → receiver. The controlled 422 appeared in recovery; restore and replay completed; the final persisted job was `SUCCEEDED` with two historical attempts (422, 200), and SQL readback showed exactly one receiver receipt with the correct workspace ID.
- `git diff --check` — passed.

The repository-wide `npm run format:check` has not been claimed as passing; the untouched baseline files `src/bin/migrate.ts`, `src/db/postgres-guest-workspaces.ts`, and the architecture document initially had existing Prettier differences. Changed implementation files were checked directly.

## Remaining work and limits

- No browser-driven keyboard/mobile QA, no test for expiry cleanup, and no safe bounded cleanup/reconciliation for expired guest data and cross-database orphan fault plans yet. Do not expose the public mode until cleanup, quotas, and browser QA are completed.
- Date filtering, finer request quotas, full migration-version readiness reporting, and workspace cleanup for active leases remain incomplete.
- Hosting preflight (provider allowance, billing/overage controls, and exclusive database roles/headroom) remains unverified. Do not provision or deploy under this checkpoint.
- `showcase/` remains its original browser-only model. The repository remains private; this checkpoint does not claim the V3 UI is published.

## Next action

Continue locally with safe expiry/orphan cleanup and bounded operation quotas, add migration-version readiness, then run browser keyboard/mobile QA and the exact workspace-isolation/expired-cookie cases. Recheck hosting only through read-only account data; stop at a local truthful fallback if US$0 isolation is not demonstrable. Commit and push this coherent checkpoint on the existing feature branch; do not merge, change visibility, provision, or deploy.
