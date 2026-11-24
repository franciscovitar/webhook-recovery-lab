# V3 implementation checkpoint — isolated operations flow

2026-11-24. Development branch: `feat/webhook-operations-v3`.
Continued from: `e1ecc5dc4c0066faf46bd449f8f39667b50da56c` (earlier checkpoint ancestry: `d4164bce8ca40a68affb24c0701cf53fd77b1b2d`).
PAS `main` verified: `b14e7cf58c416572c54b0592e755d870b0dc889b`.
Portfolio policy: `AI/governance/PORTFOLIO_DELIVERY_POLICY.md`.
Cost policy: `AI/governance/INFRASTRUCTURE_COST_GUARDRAIL.md`.
Architecture: [PRODUCT_ARCHITECTURE_V3.md](PRODUCT_ARCHITECTURE_V3.md).

The owner authorized a Free-only QA deployment using the personal Neon Free organization and Render Free, with maximum additional spend US$0. The deployment and online QA are complete on this feature branch. No Aiven or Library Network changes, Vercel Production changes, main merge, or repository visibility change were performed.

## Implemented in this checkpoint

- Additive gateway migrations `0003_scope_events_to_workspaces` and `0004_workspace_replay_idempotency`, and receiver migrations `0002_receiver_workspace_identity` and `0003_receiver_workspace_fault_plans`. Existing `0001` files remain unchanged. Migration manifests retain the transaction and advisory-lock runner.
- Additive lifecycle migrations `0005_workspace_lifecycle` and `0004_receiver_lifecycle` persist raw ingress bytes/signature verdicts, bounded workspace mutation budgets, cross-database cleanup progress, scoped receiver attempt counts, fault-plan preparation time and receiver cleanup tombstones. A late request after receiver purge returns 410 without recreating counts.
- Workspace-scoped event identity and dedupe; legacy rows retain their separate unscoped uniqueness rule. Per-workspace event admission is serialized and capped at 10. The original global 10-start/hour and 30-active-workspace limits remain in effect.
- A 20-mutation/hour atomic workspace budget covers new test events, duplicate sends, restore and new replay requests. Idempotent event/replay repeats do not consume a second replay action; reusing a replay request ID with a different job or reason returns a conflict.
- Bounded cleanup closes expired workspaces under the same advisory lock used by ingress and worker claims. A live lease defers deletion. Gateway rows are purged transactionally into a durable cleanup queue; receiver records are deleted idempotently before workspace finalization. Receiver tombstones reject late deliveries and are pruned after 24 hours. Stale receiver preparations older than one hour are removed only if no matching gateway delivery exists. Worker scheduling ignores jobs in closed or expired workspaces.
- `/ready` now checks every gateway and receiver migration version expected by the running binary in addition to both database connections.
- Cookie-backed guest session start/resume, SHA-256 digest lookup, same-origin mutation checks, configurable Secure/HttpOnly/SameSite cookie, and private-mode rejection of the legacy unscoped webhook ingress.
- Scoped overview, event list/detail, deliveries, activity, endpoints, recovery, restore and replay read/write paths. Event search supports status, date range and 25-row pagination. Event detail can resend the exact persisted raw bytes through HMAC ingress to verify real dedupe.
- A permanent-rejection test scenario is prepared at the fixed receiver before its job is made eligible. The worker passes trusted workspace identity to the separately persisted receiver receipt. Restore clears only that workspace's matching receiver fault plan.
- Same-process Fastify composition for API, loopback-only receiver and bounded event-driven worker scheduler. The worker wakes on accepted ingress/replay and schedules against database due times; idle instances do not poll continuously. Gateway/receiver runtime pools reserve four connections total.
- React/TypeScript/Vite operations console served from the API origin. It uses persisted read models and real receiver health, provides status/date/search filters and pagination, responsive event/delivery cards, scoped event links, keyboard focus/escape/return behavior for event detail, and discreet recovery test options. The previous `showcase/` is preserved.
- Mobile navigation wraps all six sections into two visible rows with 44 px targets. Success messages auto-dismiss after six seconds; failures clear stale success notices and show plain-language messages instead of internal error codes.
- Docker build now includes the Vite source and readable migration assets. Compose waits for both logical databases and supplies the receiver credentials required by the composed API.

## Verification actually executed

Runtime observed: Node `v24.22.3`, npm `11.19.1`, Docker `29.9.2`, PostgreSQL `17.12`. Disposable loopback databases: `gateway_test`, `receiver_test` on port `5437`.

- `npm run test:unit` — 32 passed, 0 failed.
- `npm run test:integration` — 29 passed, 0 failed, 0 skipped across both disposable databases. New PostgreSQL cases cover active-lease cleanup deferral, eventual purge, partial receiver-cleanup retry, orphan plan cleanup, atomic mutation/event quotas, migration readiness, receiver workspace identity and exact-payload dedupe/date filtering.
- `npm run typecheck`, `npm run typecheck:web`, and `npm run lint` — passed.
- `npm run format:check` — passed repository-wide.
- `npm run build` — TypeScript backend and Vite production bundle built successfully.
- `node --test showcase/model.test.mjs` — 5 passed, 0 failed.
- `npm run demo:scenario -- --run-id local-v3-final2-20261124` — real HTTP scenario passed: duplicate/conflict, bounded 503 retries, lost ACK with one receipt, DEAD/replay to success.
- Applied and reran both migration manifests against PostgreSQL; reapplication is idempotent.
- Rebuilt and ran the composed Docker stack locally. The real no-login API path created a cookie workspace, accepted a signed synthetic event, persisted the controlled DEAD state, restored and replayed it to `SUCCEEDED` with two attempts and exactly one receiver receipt. Docker `/ready` and `/` returned 200. Both Docker stacks and their disposable volumes were removed after verification.
- Local Playwright `1.62.0` with Chromium `156.0.8078.79` exercised the compiled app against disposable PostgreSQL: successful event creation, event inspection, duplicate signed ingress, durable receiver rejection, restore/replay, HTTP 422/200 attempt history, active navigation, filters, loading/error states and independent visitor isolation all passed. Keyboard order, skip link, visible focus, dialog focus containment/Escape/return, and page errors passed. At 390 px and 320 px all six mobile navigation items fit without horizontal page overflow and provide 44 px targets. Browser captures and detailed results are in [the V3 visual QA evidence](qa/v3-visual-2026-11-24/README.md). The integrated browser surface could not initialize (`the gaas-browser node_repl sandbox cannot be disabled`); local Playwright was used with no external service.
- `git diff --check` — passed.

## Hosting and online QA status

The Free-only infrastructure preflight, deployment and online QA are complete. Full evidence, usage snapshot, resource identifiers, migration results and test outcomes are in [the hosting deployment status](hosting/NEON_RENDER_DEPLOYMENT_STATUS_2026-11-24.md).

- One Render Free service runs V3 on `feat/webhook-operations-v3`; auto-deploy is off. A documentation-only descendant of the validated code commit was deployed.
- One personal Neon Free project hosts the two logical databases. Runtime roles are restricted to their matching databases; cross-database CONNECT was denied in SQL checks.
- Online checks passed for no-login access, signed ingress and worker delivery, exact-payload dedupe, durable failure/replay, PostgreSQL persistence, independent visitor workspaces, Render+Neon cold start and recovery of a persisted pending job after a controlled redeploy.
- The 390 × 844 device-mode layout rendered. No application code change was needed.
- Render's first cold Neon connection produced one deferred cleanup warning; API startup, subsequent requests and worker recovery succeeded automatically. No ping or scheduled service was added.
- Current deployment and resource costs remain within Free plans; budget spent is US$0.00. No post-deployment billing-counter refresh was available through Render's integration; the verified no-card/free-plan gate and the pre-provisioning billing snapshot are recorded in the hosting report.
- Aiven, Library Network, Vercel Production, showcase, repository privacy, and `main` remain untouched.

## Next action

The QA URL is available at https://webhook-recovery-lab-v3-qa-franv-20261124.onrender.com. Review the linked hosting report. Do not change repository visibility, merge into `main`, promote to Production, or change other infrastructure without owner approval.