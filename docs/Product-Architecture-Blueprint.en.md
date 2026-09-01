# Product Architecture Blueprint (Project Golem)

## Goal

Evolve the current single-repo runtime into a long-term maintainable product architecture with:

- clear module boundaries
- parallel team development
- consistent startup/deployment behavior
- low-risk incremental migration

## Current Layering

```text
project-golem/
├── apps/
│   ├── runtime/
│   │   └── index.js
│   └── dashboard/
│       └── plugin.js
├── src/
├── web-dashboard/
├── packages/
├── infra/
├── index.js
└── dashboard.js
```

### Boundary Definition

- `apps/`: composition and startup orchestration only.
- `src/`: core domain logic (brain/memory/skills/managers).
- `web-dashboard/`: web UI and API adapter layer.
- `packages/`: reusable modules that can be tested and versioned independently.
- `infra/`: deployment, operations, observability, and environment governance.

## Incremental Migration Roadmap

### Phase 1 (Completed)

- Added `apps/`, `packages/`, and `infra/`.
- Moved runtime entrypoints:
  - `index.js` -> `apps/runtime/index.js`
  - `dashboard.js` -> `apps/dashboard/plugin.js`
- Kept root compatibility shims to avoid breaking existing scripts/tests.

### Phase 2 (Initial Extraction Completed)

- Added facade packages:
  - `packages/security`
  - `packages/memory`
  - `packages/protocol`
- Integrated first consumers:
  - `apps/runtime/index.js` now uses `packages/security` and `packages/protocol`
  - `web-dashboard/routes/api.skills.js` and `web-dashboard/routes/api.persona.js` now use `packages/protocol`
- Added `tests/PackageFacades.test.js` to validate package export contracts.
- ✅ Completed "Concrete Migration Wave 1":
  - `SecurityManager` and `CommandSafeguard` implementations were moved into `packages/security/`
  - legacy shim files in `src/` have been removed
- ✅ Completed "Concrete Migration Wave 2":
  - `ProtocolFormatter`, `ResponseExtractor`, and `NeuroShunter` implementations were moved into `packages/protocol/`
  - legacy shim files in `src/` have been removed
- ✅ Completed "Concrete Migration Wave 3":
  - `LanceDBProDriver`, `SystemNativeDriver`, and `ExperienceMemory` implementations were moved into `packages/memory/`
  - legacy shim files in `src/` have been removed
- ✅ Completed "Concrete Migration Wave 4":
  - `src/memory/embeddings/*` implementations were moved into `packages/memory/embeddings/`
  - legacy shim files in `src/` have been removed

### Phase 3 (Productization)

- Treat `apps/runtime` and `web-dashboard` as independent release units.
- Add deploy templates, health checks, rollback, and recovery playbooks in `infra/`.
- Add CI quality gates:
  - tests
  - security scans
  - dependency checks

### Phase 3 Preflight (Completed)

- Added architecture boundary checker: `scripts/check-architecture-boundaries.js`
- Added npm command: `npm run arch:check`
- CI now includes Architecture Boundary Check
- Added layering skeleton in `src/`:
  - `src/domain`
  - `src/application`
  - `src/infrastructure`

## Dependency Direction Rules (Mandatory)

Allowed:

- `apps/* -> src/*`
- `apps/* -> packages/*`
- `web-dashboard/* -> src/*` (gradually migrate to `packages/*`)

Forbidden:

- `src/* -> apps/*`
- `packages/* -> apps/*`
- circular dependencies between packages

## Naming and Responsibility Guidance

- `apps/runtime`: orchestration only
- `src/core`: domain orchestration
- `src/managers`: policy/coordination
- `src/services`: integration helpers
- `src/utils`: pure shared utilities

## Acceptance Criteria

- Existing startup commands continue to work unchanged
- Core tests keep passing
- Documentation is updated in sync
- New features are added in the correct layer (not pushed back into giant entry files)
