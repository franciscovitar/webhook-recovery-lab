# Webhook Recovery Lab — public explanatory console

The original TypeScript/Fastify/PostgreSQL worker and receiver use separate durable databases and run locally or in CI. **This Vercel website is a fully synthetic, browser-only visual model**, not a hosted worker, cryptographic verifier or SQL integration.

- `model.js` models the documented invariants and failure scenarios deterministically without external I/O.
- A real HMAC check, transaction, delivery, server/worker crash or replay is **never** attempted from the visitor's browser.
- Browser-only data resets on reload. No client details, external dependencies or secrets.
- `node --test model.test.mjs` verifies the illustrative transitions.

## Deployment

Vercel project: Root Directory `showcase`, framework **Other**, output directory `.`. The original repository is private; deploying this static subdirectory does **not** make its source history public. Keep the persistent backend private and do not expose its unauthenticated/local endpoints on Vercel.
