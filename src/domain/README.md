# `src/domain`

Domain models and core business rules should live here.

Migration guidance:
- Move behavior-centric logic from `src/core` and `src/managers` gradually.
- Keep this layer framework-agnostic.
