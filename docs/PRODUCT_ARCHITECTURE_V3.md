# Webhook Recovery — functional public portfolio V3

**Owner-approved product and technical direction.** 2026-11-24, Argentina.
Baseline repository main: cc99a57e3ef848d679d798932efd52d294a04990. PAS main: b14e7cf58c416572c54b0592e755d870b0dc889b; portfolio policy blob 1fe6af3e74e10f7c15adf50d8b11ac1067e1bd82. Apply Deep Research Standard, portfolio delivery policy, cost guardrail and execution policy. V3 supersedes V2's login requirement and enterprise deployment scope; V2 remains historical rationale. Preserve local Compose, tests, static showcase and engineering case study. Local implementation and disposable-database QA are authorized. No provisioning, repository visibility change, main merge or deployment is authorized.

## Product and finite scope

Real SaaS integration-operations console, not an explainer or browser simulator. No login or registration; temporary isolated synthetic workspace. English-first proposed interface. Technical architecture and evidence belong in View Case and repo docs. Keep Fastify, TypeScript, PostgreSQL, raw-byte HMAC, transactional inbox/job, dedupe, leases/fencing, retries, DEAD queue, replay and idempotent receiver. Current contract only supports sandbox order.created; do not fabricate other types or endpoints. One controlled Orders receiver. No arbitrary destinations, real customer data, billing, real provider integrations, enterprise roles/invites or infrastructure for their own sake.

Primary journey: open demo, inspect persisted events, send signed synthetic order, observe actual delivery, inspect failure, restore test receiver, replay DEAD job and verify one durable receiver receipt. Additional test scenarios: duplicate identical payload, transient 503, lost response after receiver commit, lease recovery. Fault choices belong in discreet test-event drawer, not normal navigation. Synthetic faults, real execution and persistence.

## Architecture and worker

React + TypeScript + Vite compiled assets served by same-origin Fastify API on one Node 24 web service (Render Free candidate). Real receiver HTTP listener bound only to loopback, fixed server-configured URL, no redirects, internal token; never expose receiver or administrative CLI via public routing. Separate gateway/receiver PostgreSQL logical databases and independent transactions. Small composition root supervises API, receiver and worker; preserve original multi-process Compose as local reference. Health/readiness check both DBs and migration versions; graceful shutdown releases pools. Same public origin avoids Library Network's independent frontend/backend cold starts; Render loading page itself remains possible.

Reuse WorkerRunner.runOnce and existing claim/finish logic. Wake on startup, accepted ingress and replay; coalesce kicks, one bounded drain loop per instance, schedule next due retry or expired lease from DB time; interrupt timer for new work and recheck after drain to avoid lost wakeup. A claim marking exhausted expired job DEAD then returning null is not proof no eligible work remains. Bounded backoff on DB errors, no idle 250ms polling, no external cron or permanent keepalive. Retain 15s leases, outbound timeout below TTL, max five attempts per generation, jitter and fencing. Processing pauses while instance sleeps, resumes from durable state on restart; no 24/7 promise. Small pools and bounded concurrency; no Redis/Kafka or separate paid worker.

## Isolation, persistence and safety

Add ordered migrations without rewriting applied 0001; the gateway and receiver runners use explicit version manifests under advisory lock. Guest credential random opaque server token (digest at rest), HttpOnly/Secure in HTTPS/SameSite cookie, expiry, Origin/CSRF checks on mutation. Scope every read and mutation from validated session, never client-supplied owner. Scope event uniqueness to workspace/provider/event ID preserving legacy behavior, constrain joins and indexes for jobs, attempts and replay. Trusted internal worker may claim across workspaces. Receiver records map to trusted workspace/delivery identity; no cross-DB FK or distributed transaction claim. Strict synthetic schema/body limit; no signing keys, internal tokens or raw secrets in UI/logs. Public mode cannot expose local-default signing/admin routes.

Server creates signed raw event bytes and submits through actual HMAC ingress. Stable per-workspace command idempotency and exact raw bytes on repeat. For fault scenarios preallocate delivery identity and prepare receiver plan BEFORE job eligible; idempotent preparation/acceptance, reconcile partial failures and clean orphans. Never insert fault after claim or fabricate failure. 202 only after gateway commit; identical event dedupes, changed payload conflicts. Replay locks scoped DEAD job, preserves stable delivery ID and historical attempts, bounded reason/generation and action idempotency. Restore receiver independently, idempotently; report partial restore/replay failure truthfully (no distributed transaction). Lost ACK must retain one receiver effect.

Initial proposed limits, not measured capacity: 24h guest TTL, 10 events/workspace including seed, two manual replay generations/job, 30 active workspaces, 10 new workspaces/hour globally, atomic admission and mutation quotas, bounded body/pagination (max 25), storage ceiling and short request limits. Tune downward to budget. Cleanup marks expired space closed, does not delete actively leased work, reconciles partial cross-DB deletion and removes orphan preparations; no unrelated data. No unlimited polling or generation.

## API and read models

Same origin /api/demo: POST session (resume/create); GET overview, events (search/status/date, pagination), event/:id, deliveries, endpoints, recovery, activity. POST test-events (bounded scenario enum + request ID), events/:id/duplicate, recovery/:id/restore, recovery/:id/replay (reason + request ID), session/new (explicit confirmation). Validate with Zod and scoped parameterized SQL. Consistent errors for expired/foreign sessions and IDs, no unscoped ops snapshot. No raw CLI/shell. Map PENDING initial vs retry based on attempts/next_attempt_at, LEASED processing, SUCCEEDED delivered, DEAD failed; actual persisted attempt states only. Signature verdict from actual ingress; receiver unavailable is unknown, not zero. Metrics derived from scoped DB rows, delivered/total with denominator labeled, latency from successful attempts, null without samples. Poll low-rate only while visible pending operations, stop when terminal/hidden/budget exhausted, manual refresh.

## UX

Dark navy sidebar #142335; light canvas #F4F6F9; white surfaces; teal #16836C; status colors with labels/icons (not color alone). Active navigation and breadcrumbs, desktop tables/mobile cards, keyboard focus and accessible drawers, loading/empty/error/expired states. Human-friendly names and order references, full UUID copyable in detail. No decorative animation or fake charts. Main navigation:

- Overview: scoped Received / Delivered / Pending retry / Failed counts, outcome distribution, recent activity and direct Send test event CTA.
- Events: search, status/date filters, event detail, sanitized payload, signature acceptance, identity and timeline.
- Endpoints: one real fixed Orders receiver, observed health, discreet test-event action. No fake configurable integrations.
- Deliveries: attempt history, HTTP code, latency, actual outcome, next retry and event links.
- Recovery: DEAD list, readable error, restore controlled receiver then replay with reason/confirmation; show processing until actual result.
- Activity: chronological records derived from persisted events/attempts/audit.
  Landing CTA enters sandbox directly without account; explain cold start concisely, bounded safe-read retries only, never require manual API wake or silently repeat mutations.

## Hosting preflight — conditional, not authorized

Observed 2026-11-24: Render My Workspace has exactly Library Network web/API Free in Oregon, automatic deploy disabled. Remaining hours/build/bandwidth and payment method not observable via available tools. Supabase organization Free with two active projects (football-intelligence and cauce-commerce-lab); no additional slot assumed. Neon personal Console organization Free, separate Vercel-managed Launch; no Neon creation or paid-org use without explicit approval and actual no-charge verification, given prior charges. Vercel showcase exists and repo-filtered listing found no connected project; preserve showcase and recheck before implementation.

Preferred candidate: one Render Free service + existing Aiven Free PostgreSQL, two NEW exclusive databases and distinct owners/migrators/runtime roles. No Library credentials or data. Aiven Free 1GB storage/RAM, max_connections 20, no managed pool; 3 or 6 reserved connections plus monitoring reduce capacity. Proposed max 2 per runtime pool, four total, migration separate. Before sharing check live disk, CPU, connections, role memberships, PUBLIC CONNECT/schema grants and access boundaries. New roles cannot access Library data or escalate; Library runtime cannot mutate new DBs. If requires changes to Library grants/settings, stop for separate approval. TLS verification, do not widen existing network allowlist. No Aiven connector available and no authenticated Aiven tab observed; real headroom/isolation not verified. Render 750 shared instance hours/month, 15 min idle sleep, finite bandwidth/build allowances and external DB traffic suspension risk; three continuously running services exceed allowance. Verify dashboard usage, payment/overage settings and safe budget before provisioning. No Free SSH/one-off jobs; migrations once via authorized local psql/Codex and temporary exact IP if needed, revoke after; never leave admin secrets in runtime. No provisioning in this checkpoint.

Fallback: if sharing Aiven unsafe, evaluate a separate project on personal Neon Free ONLY with explicit approval and verification of actual plan/quota/no charge; published Free limits have changed since prior incident. Never use managed Launch. Supabase new project not viable with existing active slots, Render Postgres Free expires after 30 days. Vercel functions and Cloudflare Queues require material runtime/semantics changes and potential complexity/cost; not selected. Full local Docker product is truthful fallback if no safe US$0 hosting. Do not pay to eliminate routine cold start.

Sources verified 2026-11-24:

- https://render.com/docs/free
- https://render.com/docs/deploy-rails-6-7
- https://aiven.io/docs/products/postgresql/concepts/pg-free-tier
- https://aiven.io/docs/products/postgresql/reference/pg-connection-limits
- https://aiven.io/docs/products/postgresql/howto/create-database
- https://aiven.io/docs/products/postgresql/howto/readonly-user
- https://supabase.com/docs/guides/platform/billing-on-supabase
- https://neon.com/blog/neon-free-plan-1-gb-per-project
- https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
- https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html

## Implementation order and acceptance

A: repository-aware local Codex/Work, run baseline on disposable gateway_test/receiver_test; additive migrations/scoped domain API. B: receiver/worker composition, bounded quotas/cleanup, signed generation and replay. C: React UI from actual read models. D: local integration and browser QA; coherent PR, not repeated private CI as diagnostic runner. E: only after hosting preflight and explicit authority, one bounded deploy and real idle browser test without manual API wake. F: secret/history review and owner approval before visibility change; README and View Case actual evidence; preserve old showcase until replacement approved.

Acceptance: original unit/integration/Compose checks, migration rerun, real signed 202+commit/duplicate/conflict/invalid signature, actual receiver success/503 retry/permanent failure/restored replay, lost ACK/expired lease/stale ACK, concurrent quotas and replay idempotency, separate guest cookies and cross-space GET/POST denial, expired session, fixed destination/redirect denial, CSRF and cleanup safe for active job, real scoped metrics, desktop/mobile keyboard and active nav, anonymous browser entry after real idle, resume after interrupted worker, verified free-plan spend and no unrelated changes. Historical tests are not new-product evidence. Stop when core journey passes; no billing, enterprise RBAC, arbitrary connectors, alerts, permanent polling or multi-server hosting.

## Implementation status

This file defines the intended product and acceptance boundary. The local implementation and evidence completed so far are tracked in [IMPLEMENTATION_V3_CHECKPOINT.md](IMPLEMENTATION_V3_CHECKPOINT.md). Hosting remains conditional and unverified; local completion does not claim a public or production service.
