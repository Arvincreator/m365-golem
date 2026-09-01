# Architecture Governance

Automated architecture checks:

- `npm run arch:check`

Current enforced rules:
- `src/*` cannot import from `apps/*`
- `packages/*` cannot import from `apps/*`
- cross-package imports are blocked (`packages/A` -> `packages/B`)

Script location:
- `scripts/check-architecture-boundaries.js`
