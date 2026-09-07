# Built-in M365 Session Bridge

This directory contains the reproducible source for M365 Golem's built-in
SharePoint Online and OneDrive for Business MCP bridge.

The bridge uses the user's existing, visible Microsoft Edge session. It does
not request Microsoft passwords, MFA codes, browser cookies, or access tokens.
It is intentionally not a general Microsoft Graph, Outlook, Teams, Calendar,
or tenant-wide search connector. Operations require an exact supported
SharePoint or OneDrive URL.

## Distribution boundary

Git tracks source code, package lock files, manifest templates, and the
deny-first default policy only. The fresh-install policy permits non-destructive
write tools (create folder, upload without overwrite, copy, move, rename and
metadata/version operations) only after the target host/site is authorized.
Overwrite, recycle, permanent delete, sharing and permission changes remain
disabled by default. Installation creates the following per-user
state under `%LOCALAPPDATA%\M365-Golem\m365-session-bridge`:

- `policy.json`
- the local IPC secret
- action logs

Generated extension bundles, Native Messaging manifests, dependencies, and
per-machine M365 Golem MCP configuration are not committed.

Run `Install-M365-Golem.bat` from the repository root. The installer builds
this component, registers its Native Messaging host for the current Windows
user, and merges the built-in MCP entry into `data\mcp-servers.json` with the
Bridge and isolated `chrome-devtools` server enabled by default.

Edge requires one visible manual step after installation:

1. Open `edge://extensions`.
2. Turn on Developer mode.
3. Choose **Load unpacked**.
4. Select `integrations\m365-session-bridge\apps\edge-extension\dist`.

The fixed extension identity is used only to bind the checked-in extension
source to the registered Native Messaging host. It does not grant Microsoft
365 permissions. SharePoint authorization still comes from the user's active
Edge session and the local deny-first policy.

The Golem Dashboard exposes this policy under **更多工具 → M365 Bridge**. Its
backend talks only to the fixed loopback control API at `127.0.0.1:43240`; it
does not proxy arbitrary local addresses. The same page manages the narrow
local project folders from which uploads may be read. The managed Golem project
root is included at fresh install; if a project is linked to another folder,
add that specific folder before asking Golem to upload one of its files. Drive
roots are rejected as too broad.
