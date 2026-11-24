# Neon Free + Render Free deployment status — 2026-11-24

Repository: `franciscovitar/webhook-recovery-lab` (private).
Branch: `feat/webhook-operations-v3`.
Validated application commit: `c45a0148298b7519518043623027a99597eeed4f`.
Deployed branch head: `da3e5096d31b01c6ed7232b2f9c6e4e737f42901` (documentation-only descendant; no V3 application code changed).
Scope: isolated V3 QA. Aiven, Library Network, Vercel Production, repository visibility, and `main` remain untouched.

## Cost gate and limits

### Render

Authenticated billing for **My Workspace** (`tea-dc2bqmuc6qcc73dgd1hg`) was checked before provisioning on 2026-11-24:

- Hobby workspace, no payment method/card.
- 10.08 / 750 free instance-hours; 107 MB / 5 GB egress; 4 / 500 build-pipeline minutes.
- Unbilled and projected November totals: **US$0.00**.
- The new service is explicitly reported as `plan=free`, one instance, Ohio, no disk, auto-deploy off.
- A second manual QA deploy reused the same commit and completed successfully. No new charge-capable service or paid feature was created.

Render's Free documentation: https://render.com/docs/free and https://render.com/docs/faq. The Free service sleeps after 15 minutes without inbound requests and wakes on the next request; free quota exhaustion suspends services or pauses builds. No post-deployment billing-counter refresh was available through the Render integration, so the exact counters above are the pre-provisioning snapshot; the live service plan and no-card workspace state were separately verified.

### Neon

Only the personal organization `org-bold-dew-82033174` was used; its plan is **Free**. The separate Vercel-managed Launch organization `org-tiny-silence-80406509` was not used. Project usage was inspected after QA:

- 0.25 CU min/max; Neon Free autosuspend after 5 idle minutes (platform default).
- 168 CU-seconds reported (about 0.047 CU-hours), 6,543 bytes network transfer at the recorded usage snapshot; no paid usage.
- Free caps documented by Neon: 100 CU-hours, 1 GiB logical storage and 5 GiB public transfer per project, with compute suspension at included limits.
- Free plan: no overage billing. Official references: https://github.com/neondatabase/website/blob/main/content/faqs/free-plan-limits-and-quotas.md and https://neon.com/blog/neon-free-plan-1-gb-per-project.

**Budget result: US$0.00 additional.** No card, upgrade, paid resource, or paid organization was used. Free quota exhaustion can suspend the service/database and is accepted as the limit behavior.

## Neon project and database isolation

Created only in the personal Neon Free organization:

- Project `webhook-recovery-lab-v3-qa`, ID `misty-dew-97178325`, Ohio (`aws-us-east-2`), PostgreSQL 17.
- Branch `br-proud-glade-bew6qhxa`.
- Two logical databases: `wrl_gateway` and `wrl_receiver`.
- Runtime roles: `wrl_gateway_app` and `wrl_receiver_app`.

Migration manifests applied from this branch:
- Gateway: `0001_initial` through `0005_workspace_lifecycle` (5).
- Receiver: `0001_receiver` through `0004_receiver_lifecycle` (4).

Each role is limited to its matching database and `public` schema. `CONNECT` was revoked from PUBLIC and granted to the matching runtime role; read-only permission checks as each app role confirmed cross-database CONNECT denied. No connection strings or credential values are stored in this report or GitHub.

The first receiver migration transaction rolled back due to a semicolon inside a SQL comment confusing statement splitting. A read-only check confirmed no migration ledger had been written; after stripping line comments before splitting, migrations 0001–0004 applied successfully. The gateway manifest applied transactionally. No local development or closed local QA was repeated.

## Render service and deploy

One service exists for this project:

- Name: `webhook-recovery-lab-v3-qa-franv-20261124`
- ID: `srv-dc2such7lnhs73fd3fp0`
- URL: https://webhook-recovery-lab-v3-qa-franv-20261124.onrender.com
- Free web service, Ohio, one instance, Dockerfile at repository root, branch `feat/webhook-operations-v3`, auto-deploy disabled, no disk.
- First deploy `dep-dc2sud97lnhs73fd3gng`; controlled redeploy `dep-dc2ti5m8bjmc738n05c0`; both succeeded.
- V3 code from validated commit `c45a0148298b7519518043623027a99597eeed4f` was unchanged by the documentation-only deployed descendant.
- Public entry works without sign-in. React/Vite, Fastify, same-process worker, and loopback receiver run in this one service.

The Render GitHub App is installed using **Only select repositories** with exactly one selected repository: `franciscovitar/webhook-recovery-lab`. The owner approved the exact app permission set. The initial install page's All repositories default was not submitted.

## Online QA evidence

All test content was synthetic and confined to browser workspaces. No external webhook destination was configured.

| Check | Result |
| --- | --- |
| Anonymous access | Pass. First visit opened a temporary browser-private workspace without registration, password, or login. |
| Signed ingress and worker delivery | Pass. Real HMAC-signed synthetic order entered the same-process HTTP receiver and worker; HTTP 200 delivery persisted. |
| Deduplication | Pass. Reposting the exact signed raw body returned duplicate and did not create another event/attempt. |
| Failure and recovery | Pass. Controlled receiver rejection produced HTTP 422 and DEAD; restore + replay produced generation 1, attempt 2 HTTP 200, SUCCEEDED, one durable receipt. |
| PostgreSQL persistence | Pass. Gateway events/jobs/attempts and receiver receipt were queried using the matching restricted app roles. |
| Visitor isolation | Pass. Separate browser contexts had different workspace IDs; Visitor B saw only its own records. Neon queries confirmed A's five and B's two test events were under distinct workspace IDs. |
| Render + Neon cold start | Pass. After >15 min Render idle and >5 min Neon idle, the first browser request showed Render's “Service waking up” screen. The service then started without manual dashboard action, served `/` and its API with 200, and restored Visitor B's persisted event. |
| Pending-job recovery after interruption | Pass. For a deterministic synthetic fixture, the restricted QA roles cleared the test receiver's permanent fault and changed only the new synthetic DEAD job to PENDING with a future due time. The free service was redeployed before that time. After it became due, the new worker claimed it, sent attempt 2, received HTTP 200, and acknowledged it. The database ended SUCCEEDED with two attempt rows (422 then 200), and Neon receiver had one durable receipt. This was a controlled database fixture, not live customer traffic. |
| Desktop/mobile layout | Desktop operations flow loaded in Chrome. A Chrome device-mode viewport was set to 390 × 844 and the app rendered its mobile navigation and overview. No design/code change was required. |
| Cold-start first-connection behavior | Non-blocking warning observed: one workspace-cleanup DB connection timed out during Neon wake and cleanup was deferred. The API then listened, root and API calls returned 200, the existing event loaded, and the worker subsequently recovered the pending job. No manual wake or ping was needed. |

Render logs confirm the cold-start sequence: process listening at 18:31:16Z, root HTTP 200 at 18:31:21Z, and API calls 200 at 18:31:22Z. The pending job was acknowledged by the worker at 18:38:36Z after the redeploy at 18:36:06Z. The Neon receipt was stored at 18:38:36Z.

The cold-start cleanup warning was transient and did not block readiness or visitor access. It did not justify a code change. The PG client emits a non-blocking warning that current `sslmode=require` alias semantics will change in a future major dependency release; current runtime uses verify-full behavior. No credentials appeared in logs.

## Explicitly untouched

- Aiven and its allowlist.
- Library Network, its Aiven data, and both existing Render services.
- Neon Launch/Vercel organization.
- Vercel Production.
- Showcase.
- Repository visibility and `main`.

## Outcome and next action

The controlled QA deployment is live at the URL above, with separate browser-private workspaces and isolated logical databases. No pings, cron jobs, external worker services, or other extra infrastructure were added. Keep the repository private and this work on the feature branch. Production promotion, repository visibility changes, and merge to `main` remain subject to owner approval.

