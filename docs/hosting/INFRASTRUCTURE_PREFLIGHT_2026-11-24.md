# Hosting preflight — V3 — 2026-11-24

Repository: `franciscovitar/webhook-recovery-lab`
Branch and reviewed head: `feat/webhook-operations-v3` at `c45a0148298b7519518043623027a99597eeed4f`.
Review date: 2026-11-24 (America/Argentina/Buenos_Aires).
Decision: **NO-GO for provisioning, migration, or deployment pending owner decision and a verifiable Aiven database-level preflight.**

## Scope and changes

The authenticated Render and Aiven consoles and the connected Neon account were inspected read-only. Official provider documentation was checked. No resource, configuration, permission, credential, repository visibility, deployment, migration, or Production setting was changed. No new service, database, role, or Neon project was created. Library Network and the prior showcase remain untouched.

## Render — authenticated workspace

Workspace: My Workspace (Hobby).

The billing page showed:

- Free instance hours: 10.08 / 750 for November.
- Included services: 2 / 25.
- Included bandwidth: 107 MB / 5 GB.
- Build pipeline: 4 / 500 minutes.
- Unbilled month-to-date and projected November total: USD 0.00.
- Payment method: no card on file.

The two listed services are the existing Library Network QA web and API Free services in Oregon; both have automatic deploy disabled. A further Free service is below the 25-service count, but Free instance hours, outbound bandwidth, and pipeline minutes are workspace-shared. Free services sleep after 15 minutes idle. Exhausted Free hours suspend Free services. Render documentation says that without a payment method, bandwidth exhaustion suspends Free services and pipeline-minute exhaustion pauses new builds; thus the current account state has no payment method through which those documented overages could be charged, but availability/builds can be suspended. Current spend is verified at USD 0.00, not a guarantee about future account settings or workload.

## Aiven — authenticated organization and existing PostgreSQL service

The organization/project currently has a 30-day USD 50 trial credit banner for non-Free plan services. The billing page showed **no cards added**. The only PostgreSQL service listed is `library-network-qa-db`, plan `Free-1-1gb`, PostgreSQL 18.7, one node, DigitalOcean SFO. The service UI showed 1 CPU, 1 GB RAM, 1 GB disk and max_connections 20. Aiven docs state the PostgreSQL Free tier has no service time limit, does not require a card, remains Free after trial expiry, and that only one service of each type can exist per organization. The project must remain on Free; no upgrade/payment action is authorized.

The one-hour metrics view showed roughly 20–25% CPU use, roughly 75% memory use (about 25% available), and roughly 12% disk use. These are dashboard chart readings, not long-term capacity evidence. Aiven reserves 3–6 connections from the 20 for management/monitoring, leaving at most 14–17 application connections before any other use.

**Isolation/headroom are not verified.** The SQL editor reported that access from the current client network was not allowed. This is an existing security boundary; it was not loosened. Therefore the current database list, role memberships, per-database grants, PUBLIC privileges, active connection count and actual database sizes could not be inspected. The cluster is also the existing Library Network service, so Webhook Recovery would share its CPU, memory, storage and connection ceiling even if logical databases were isolated. Adding two databases and new roles is not approved until least-privilege boundaries and live headroom are proven. We cannot safely confirm running migrations for free from the current path: the previously approved migration path depends on database connectivity, while changing Aiven's allowlist would alter an existing Library Network security setting and needs separate approval.

## Neon — read-only alternative assessment

The Neon account connection lists two organizations: the personal organization is on **Free**; the separate Vercel-managed organization is on **Launch** and was not used to inspect projects or provision anything. The personal Free organization currently lists two projects; no resources were created.

Neon's current official Free-plan announcement lists 100 projects, 1 GB storage per project, and 100 CU-hours per project per month (up to 2 CU). That makes a separate personal Free project a plausible architectural alternative without touching the Launch organization. Account-specific remaining compute usage was not available: the authenticated Neon web console redirected to sign-in, and the connected consumption endpoint only supports paid plans. The general Free plan limits therefore do not prove this account's exact remaining budget. No Neon resource creation is authorized in this preflight.

## Cost evidence and conclusion

- Render: current observed spend USD 0.00, no card on file; limits are shared and Free usage can be suspended when exhausted.
- Aiven: existing service is Free; no card on file; the trial applies to non-Free services. Adding data to the existing 1 GB instance does not create a second independent compute/storage budget.
- Neon: personal org plan is Free; a potential new project has Free plan limits, but current Free compute consumption is not exposed in the available account read path. The paid Vercel-managed Launch org was not used for project operations.
- No cost-generating change or provisioning occurred.

**Decision:** Render's Free workspace limits and current no-card state are verified, but the complete condition is not met because Aiven's isolation grants, active connections, database storage, and adequate capacity cannot be verified without crossing the Library Network IP allowlist boundary. The safer alternative (a separate personal Neon Free project) is plausible at the plan level but has not been authorized or provisioned. Consequently no Render service was created and no deployment or migration was attempted. The repository remains private and no Vercel Production setting was touched.

## Next action requiring owner decision

Choose one bounded path:

1. Authorize a temporary allowlist entry for the current client IP on the existing Aiven `library-network-qa-db` service for a read-only grant/capacity inspection, followed by immediate removal. This changes a Library Network network-access setting, can permit connections from that address while present, and is outside the current authorization. If inspection then proves sufficient isolation and capacity, the already-authorized conditional path can be resumed; if not, stop.
2. Keep Library Network unchanged and explicitly authorize assessment/provisioning of one separate project in the personal Neon Free organization only, with no use of the Vercel-managed Launch organization. This requires a separate zero-charge/quota gate before creation.
3. Leave hosting unprovisioned and retain the local runnable demo/showcase until a safe $0 path is available.

## Official references checked on 2026-11-24

- Render Free limits: https://render.com/docs/free
- Render billing behavior without payment method: https://render.com/docs/faq
- Aiven PostgreSQL Free tier: https://aiven.io/docs/products/postgresql/concepts/pg-free-tier
- Aiven PostgreSQL connection limits/reservations: https://aiven.io/docs/products/postgresql/reference/pg-connection-limits
- Aiven Free pricing and trial behavior: https://aiven.io/docs/platform/concepts/service-pricing
- Neon Free plan (1 GB/project, 100 CU-hours/project): https://neon.com/blog/neon-free-plan-1-gb-per-project

## Evidence limitations

Dashboard usage figures are point-in-time workspace/service readings. The Aiven CPU/memory/disk figures are approximate readings from the one-hour chart. No database rows, secrets, passwords, connection strings or credentials were copied into this record. Historical local test/QA results are summarized in the implementation checkpoint and were not rerun.
