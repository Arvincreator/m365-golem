# Packages Layer

Reusable modules extracted from `src/` for product-scale boundaries.

Current packages:
1. `packages/security`
2. `packages/memory`
3. `packages/protocol`

Progress:
- `security`: concrete implementation migrated (source-of-truth in package).
- `protocol`: concrete implementation migrated (source-of-truth in package).
- `memory`: fully migrated (`LanceDBProDriver`, `SystemNativeDriver`, `ExperienceMemory`, `embeddings`).

Next recommended extraction:
1. `packages/skills-sdk`
2. `packages/core-runtime`
