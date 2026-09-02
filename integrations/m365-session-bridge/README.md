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
deny-first default policy only. Installation creates the following per-user
state under `%LOCALAPPDATA%\M365-Golem\m365-session-bridge`:

- `policy.json`
- the local IPC secret
- action logs

Generated extension bundles, Native Messaging manifests, dependencies, and
per-machine M365 Golem MCP configuration are not committed.

Run `Install-M365-Golem.bat` from the repository root. The installer builds
this component, registers its Native Messaging host for the current Windows
user, and merges the built-in MCP entry into `data\mcp-servers.json`.

Edge requires one visible manual step after installation:

1. Open `edge://extensions`.
2. Turn on Developer mode.
3. Choose **Load unpacked**.
4. Select `integrations\m365-session-bridge\apps\edge-extension\dist`.

The fixed extension identity is used only to bind the checked-in extension
source to the registered Native Messaging host. It does not grant Microsoft
365 permissions. SharePoint authorization still comes from the user's active
Edge session and the local deny-first policy.
