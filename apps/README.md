# Apps Layer

This directory contains runnable applications and entrypoints.

- `runtime/`: core runtime application (main process)
- `dashboard/`: dashboard plugin/application layer

Compatibility note:
- Root `index.js` and `dashboard.js` are compatibility shims.
- New code should prefer app-level entrypoints in `apps/`.
