# Neon Free + Render Free deployment status — 2026-11-24

Repository: `franciscovitar/webhook-recovery-lab` (private).
Target branch: `feat/webhook-operations-v3`; validated application commit: `c45a0148298b7519518043623027a99597eeed4f`.
Scope: V3 QA only. No change to Aiven, Library Network, Vercel Production, repository visibility, or `main`.

## Cost gate — passed for the currently observed account state

### Render

Authenticated Billing Information page, workspace **My Workspace** (`tea-dc2bqmuc6qcc73dgd1hg`), observed 2026-11-24:

- Plan: Hobby; payment method: **no card on file**.
- Free instance hours: 10.08 / 750.
- Services: 2 / 25.
- Outbound bandwidth: 107 MB / 5 GB (104 MB HTTP responses, 3 MB service-initiated).
- Build pipeline: 4 / 500 minutes.
- Unbilled and projected November totals: **US$0.00**.

Render's Free documentation says Free compute is US$0; it sleeps after 15 minutes without inbound traffic and wakes on the next request (about one minute). At the current no-card state, exhausting included bandwidth suspends Free services and exhausting pipeline minutes pauses new builds; Free-hour exhaustion suspends Free services. This bounds the current setup to no additional charge while accepting service/build suspension at quota. Review the account again if billing or workspace settings change.

Official references:
- https://render.com/docs/free
- https://render.com/docs/faq

### Neon

The Neon account lists:
- Personal console-managed organization: `org-bold-dew-82033174`, plan **Free**.
- Separate Vercel-managed organization: `org-tiny-silence-80406509`, plan **Launch**. It was not used for any project operation.

Neon's current Free-plan FAQ says US$0/month, no overage billing, and suspends compute when monthly CU-hour or network transfer limits are hit. Current documented limits: 100 CU-hours and 1 GB Postgres storage per project, 5 GB public network transfer per project, 10 branches, and scale-to-zero after 5 minutes idle. There are 2 existing projects in the personal organization before this task. Official references:
- https://github.com/neondatabase/website/blob/main/content/faqs/free-plan-limits-and-quotas.md
- https://neon.com/blog/neon-free-plan-1-gb-per-project

**Cost decision:** Render and Neon are on their Free plans, and the Render workspace has no payment method. At these observed settings, documented quota exhaustion suspends service/compute or pauses new builds instead of creating a payable overage. No plan, card, or paid resource was added. Budget spent: **US$0.00**.

## Neon project provisioned

Created only in the personal Free organization:

- Project: `webhook-recovery-lab-v3-qa`
- Project ID: `misty-dew-97178325`
- Region: `aws-us-east-2` (Ohio)
- PostgreSQL: 17
- Read-write compute min/max: 0.25 CU.
- Free autosuspend: platform default (5 idle minutes). An explicit timeout override was rejected before resource creation; the project was then created omitting that override. The project reports timeout value 0, the Free-plan default sentinel.
- Neon Free project cap: 1 GiB branch logical size, 100 CU-hours and 5 GiB public network transfer per month. Storage and compute are shared across the two logical databases within this project.

Two logical databases and app roles:

| Database | Migration manifest | Runtime role | Cross-database CONNECT |
| --- | --- | --- | --- |
| `wrl_gateway` | `0001_initial` through `0005_workspace_lifecycle` (5) | `wrl_gateway_app` | denied to `wrl_receiver` |
| `wrl_receiver` | `0001_receiver` through `0004_receiver_lifecycle` (4) | `wrl_receiver_app` | denied to `wrl_gateway` |

Both runtime roles are Neon `read_write`, scoped to their own database and `public` schema. `CONNECT` was revoked from `PUBLIC` in both databases and granted to the matching runtime role. As each role, SQL verified the complete expected migration list and `has_database_privilege(..., other_database, 'CONNECT') = false`. Credential values and connection strings are not recorded here.

Migrations were applied from the exact `migrations/*.sql` files in the V3 branch. The first receiver transaction rolled back because a comment contained a semicolon; a verification query confirmed `schema_migrations` was absent after rollback. The statements were then split after removing line comments and the receiver transaction applied successfully. The gateway manifest applied in one transaction. No local tests or development were repeated.

## Render service and deployment — pending

No Webhook Recovery Render service has been created yet.

The API create-service call rejected the private repository URL before creating anything. The authenticated Render dashboard shows a GitHub provider is not yet connected. GitHub's Render App setup page asks to install Render on the personal `franciscovitar` account and requests:

- Read access to repository code and metadata (plus Dependabot alerts).
- Read/write access to actions, checks, commit statuses, deployments, environments, issues, pull requests, repository hooks, and workflows.
- Read access to account email.

GitHub provides an **Only select repositories** scope, which can be limited to `franciscovitar/webhook-recovery-lab`. No app installation or repository access grant has been submitted. The owner was asked for explicit approval of this exact permission set. This approval is the next action; do not proceed with the GitHub App installation until the owner answers.

The sole Render workspace has been confirmed as **My Workspace**. Once the GitHub access is approved, the intended service is one Docker web service on Free, Ohio, branch `feat/webhook-operations-v3`, auto-deploy disabled, with the existing V3 API/worker/loopback receiver in the container and the two independent Neon URLs. Planned service name: `webhook-recovery-lab-v3-qa-franv-20261124`. Random app secrets are held only in Render configuration and are not stored in GitHub. No pings or external worker services are planned.

## Explicitly untouched

- Aiven and its allowlist.
- Library Network and both existing Render services.
- Neon Launch/Vercel organization.
- Vercel Production.
- Repository visibility and `main`.

## Next action

After approval of the scoped Render GitHub App permissions, install with **Only select repositories** and select only this repository. Then create/deploy the single Free service, verify its URL and runtime health, and run the requested online QA. Record deployment identifiers, online behavior, Neon usage, Render usage, and any real integration fixes in this branch.
