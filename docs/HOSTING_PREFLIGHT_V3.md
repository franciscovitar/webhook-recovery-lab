# V3 hosting preflight — state and evidence

Date: 2026-11-24  
Repository branch: `feat/webhook-operations-v3`  
Validated implementation commit before this checkpoint: `c45a0148298b7519518043623027a99597eeed4f`  
Purpose: record the live infrastructure gate for the already-complete local V3 implementation. This document does not authorize or claim provisioning, migration, or deployment.

## Decision

**STOP before cloud provisioning.** The candidate stack remains technically plausible, but zero-cost exposure and safe Aiven isolation are not yet verified from the authenticated provider consoles. Do not create a Render service, databases, roles, or Neon resources until the remaining read-only checks are complete.

## Live account checks completed

### Render — `My Workspace`

- Workspace ID: `tea-dc2bqmuc6qcc73dgd1hg`.
- Read-only Render account inventory showed exactly two services: `library-network-qa-web` and `library-network-qa-api`; both are Free, in Oregon, and use the Library Network repository. No Render Postgres instances are present.
- This inventory does not expose billing-page included usage, current Free instance hours, outbound bandwidth, build-pipeline minutes, payment-method state, spend limits, or actual billed charges. These values remain **unverified**.
- No Render resources or settings were changed; no deploy was triggered. Additional spend incurred in this preflight: **US$0**. Actual account invoice / payment exposure was not visible and is not claimed as verified.

Current official constraints:
- Render Free includes 750 shared instance hours per workspace per calendar month. Free web services sleep after 15 minutes without inbound traffic and typically take about one minute to wake.
- Outbound bandwidth and build pipeline minutes are shared workspace allowances. If exceeded, charges may apply when a payment method exists; without one, services may be suspended or new builds disabled.
- Render Free services may be suspended for unusually high service-initiated public traffic, including external database access. The amount of account headroom and the consequence for the existing Library Network services cannot be assessed without the dashboard usage and billing controls.
- Free web services do not offer SSH or one-off jobs, so a migration would need an explicitly verified external/local migration path.

Sources (official, checked 2026-11-24):
- https://render.com/docs/free
- https://render.com/docs/faq

### Aiven — existing Free PostgreSQL

- No Aiven-specific authenticated connector was available in this execution, and the authenticated browser surface became unavailable while opening provider consoles.
- The existing Aiven service was **not inspected**. Its actual plan, disk/RAM headroom, CPU, active connections, current database and role inventory, grants/default privileges, network allowlist, and billing state are all **unverified**.
- No Aiven database, role, grant, credential, allowlist, or service configuration was changed.
- Official Free-tier documentation states a ceiling of one CPU, 1 GB RAM, 1 GB disk and `max_connections=20`; Aiven reserves three to six connections, so documentation recommends sizing application pools against at most 14 connections. This does not establish available capacity on the user's instance.
- The architecture's two new logical databases and independent gateway/receiver owners appear compatible with PostgreSQL's database/role model, but safe isolation cannot be asserted without inspecting the live grants and memberships. Do not modify Library Network grants, credentials, settings, databases, or roles to make this work.
- Migration execution is **not yet verified as free**. No migration was run and no network allowlist was changed.

Sources (official, checked 2026-11-24):
- https://aiven.io/docs/products/postgresql/concepts/pg-free-tier
- https://aiven.io/docs/products/postgresql/reference/pg-connection-limits
- https://aiven.io/docs/products/postgresql/howto/create-database
- https://aiven.io/docs/products/postgresql/howto/readonly-user

## Neon Free alternative — read-only evaluation

- Neon organization inventory showed the personal console-managed organization on plan `free` and a separate Vercel-managed organization on plan `launch`. The Vercel-managed organization was not used or inspected further.
- The personal Free organization currently lists two projects. No Neon project, branch, endpoint, role, credential, or database was created or changed.
- Neon announced 100 projects, 100 CU-hours/month per project, and 1 GB database storage per project on Free in October 2026. This makes a separate Free project a plausible alternative for storage/cost isolation, but remaining account quota/usage and deployment access were not confirmed. No resource creation is authorized by this evaluation.
- Neon does not solve Render workspace quota/billing uncertainty, and the deployment architecture would still need a secure same-origin Render service and verified database credentials.

Sources (official, checked 2026-11-24):
- https://neon.com/blog/neon-free-plan-1-gb-per-project

## Requested checks to unblock

1. Render Billing → Monthly Included Usage: capture current month Free instance hours, outbound bandwidth, and build pipeline minutes, plus the workspace's current plan and any applicable hard spend limit. Confirm whether a payment method is attached and whether any overage can bill. Redact account/card details.
2. Aiven service overview and metrics: confirm exact service plan, used/available disk, RAM and CPU, max/active connections, and service/billing state.
3. Aiven access boundary (read-only): list logical databases, roles, role memberships, database CONNECT grants, schema/table privileges and network allowlist. Names and privileges are sufficient; redact all secrets and connection strings. Confirm the Library Network application role has no rights in the two future databases, and that new roles can be confined to only their own database.
4. Confirm a migration route that does not require a paid runner and does not require changing existing Library Network permissions or credentials. If a temporary allowlist entry is necessary, stop for a separate review before adding it.
5. Only if the above proves no additional charge exposure and least-privilege isolation: continue with the already-authorized single Free Render QA service, the two new Aiven logical databases and independent roles, one migration pass, then one controlled deployment.

## Current state and next action

- Local functionality and local desktop/mobile QA: complete at `c45a0148298b7519518043623027a99597eeed4f`.
- Branch head was verified to equal `c45a0148298b7519518043623027a99597eeed4f` before this record.
- Hosting: **blocked at read-only preflight**; no service, database, role, or migration exists for Webhook Recovery.
- Repository remains private. Vercel Production and the previous showcase were not touched.
- Next action: restore authenticated browser access to Render Billing and the existing Aiven service, complete checks 1–4, then reassess the explicit provisioning condition. Do not merge to `main` or change repository visibility.
