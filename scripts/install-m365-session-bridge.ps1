<#
.SYNOPSIS
  Installs M365 Golem's built-in SharePoint/OneDrive Session Bridge.

.DESCRIPTION
  Builds the vendored bridge source, creates per-user deny-first state under
  LOCALAPPDATA, registers the Edge Native Messaging host for the current user,
  and merges the built-in MCP server into M365 Golem's local MCP config.

  This script never installs the Edge extension silently. Edge requires the
  user to load the unpacked extension once from edge://extensions.
#>
[CmdletBinding()]
param(
  [switch]$SkipBuild,
  [switch]$SkipRegistry,
  [switch]$PlanOnly,
  [string]$ConfigPath,
  [string]$StateRoot
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$Message) {
  Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Write-Ok([string]$Message) {
  Write-Host "    OK: $Message" -ForegroundColor Green
}

function Write-Utf8NoBom([string]$Path, [string]$Content) {
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Get-RequiredCommand([string]$Primary, [string]$Fallback = '') {
  $command = Get-Command $Primary -ErrorAction SilentlyContinue
  if (-not $command -and $Fallback) {
    $command = Get-Command $Fallback -ErrorAction SilentlyContinue
  }
  if (-not $command) {
    throw "$Primary was not found. Install Node.js 20 or newer and try again."
  }
  return $command
}

function Get-PropertyValue($Object, [string]$Name, $DefaultValue = $null) {
  if ($null -ne $Object -and $Object.PSObject.Properties.Name -contains $Name) {
    return $Object.$Name
  }
  return $DefaultValue
}

$GolemRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$BridgeRoot = Join-Path $GolemRoot 'integrations\m365-session-bridge'
$PolicyTemplatePath = Join-Path $BridgeRoot 'config\policy.default.json'
$McpEntryPath = Join-Path $BridgeRoot 'apps\mcp-server\dist\index.js'
$ExtensionDistPath = Join-Path $BridgeRoot 'apps\edge-extension\dist'
$NativeHostDir = Join-Path $BridgeRoot 'apps\native-host'
$NativeHostRunner = Join-Path $NativeHostDir 'run-native-host.cmd'
$NativeHostNodePath = Join-Path $NativeHostDir 'node-path.local.txt'
$NativeManifestTemplate = Join-Path $NativeHostDir 'native-host-manifest.template.json'
$NativeManifestPath = Join-Path $NativeHostDir 'native-host-manifest.json'
$FixedExtensionId = 'kfhagpcophihiigloppibgodojmgcajd'

if (-not $ConfigPath) {
  $ConfigPath = Join-Path $GolemRoot 'data\mcp-servers.json'
}
$ConfigPath = [System.IO.Path]::GetFullPath($ConfigPath)

if (-not $StateRoot) {
  if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    throw 'LOCALAPPDATA is unavailable. The bridge refuses to place secrets inside the Git working tree.'
  }
  $StateRoot = Join-Path $env:LOCALAPPDATA 'M365-Golem\m365-session-bridge'
}
$StateRoot = [System.IO.Path]::GetFullPath($StateRoot)
$PolicyPath = Join-Path $StateRoot 'policy.json'
$ActionLogPath = Join-Path $StateRoot 'logs\actions.jsonl'
$SecretPath = Join-Path $StateRoot 'runtime\ipc-secret.json'

Write-Step 'Checking the built-in bridge source and Node.js runtime'
$requiredFiles = @(
  (Join-Path $BridgeRoot 'package.json'),
  (Join-Path $BridgeRoot 'package-lock.json'),
  $PolicyTemplatePath,
  $NativeHostRunner,
  $NativeManifestTemplate
)
foreach ($requiredFile in $requiredFiles) {
  if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
    throw "Built-in bridge source is incomplete: $requiredFile"
  }
}

$node = Get-RequiredCommand 'node.exe' 'node'
$npm = Get-RequiredCommand 'npm.cmd' 'npm'
$nodeVersion = (& $node.Source --version).Trim()
if ($nodeVersion -notmatch '^v(\d+)') {
  throw "Unable to parse Node.js version: $nodeVersion"
}
$nodeMajor = [int]$Matches[1]
if ($nodeMajor -lt 20) {
  throw "M365 Golem requires Node.js 20 or newer. Found $nodeVersion."
}

$defaultPolicy = Get-Content -LiteralPath $PolicyTemplatePath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($defaultPolicy.writeEnabled -ne $true -or
    $defaultPolicy.allowOverwrite -ne $false -or
    $defaultPolicy.allowRecycle -ne $false -or
    $defaultPolicy.allowPermanentDelete -ne $false -or
    $defaultPolicy.allowArbitraryHttp -ne $false -or
    @($defaultPolicy.allowedHosts).Count -ne 0 -or
    @($defaultPolicy.allowedSites).Count -ne 0) {
  throw 'The built-in bridge policy template is not deny-first; refusing installation.'
}
Write-Ok "Node.js $nodeVersion"
Write-Ok 'Deny-first target policy validated; non-destructive writes are available after target approval'

if ($PlanOnly) {
  [PSCustomObject]@{
    Ready = $true
    GolemRoot = $GolemRoot
    BridgeRoot = $BridgeRoot
    StateRoot = $StateRoot
    ConfigPath = $ConfigPath
    ExtensionPath = $ExtensionDistPath
    RegistryWillChange = -not $SkipRegistry
    BuildWillRun = -not $SkipBuild
  }
  return
}

Write-Step 'Preparing per-user bridge state outside the repository'
New-Item -ItemType Directory -Force -Path $StateRoot | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ActionLogPath) | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $SecretPath) | Out-Null
if (-not (Test-Path -LiteralPath $PolicyPath -PathType Leaf)) {
  $policyJson = $defaultPolicy | ConvertTo-Json -Depth 20
  Write-Utf8NoBom -Path $PolicyPath -Content $policyJson
  Write-Ok "Created deny-first policy: $PolicyPath"
} else {
  $null = Get-Content -LiteralPath $PolicyPath -Raw -Encoding UTF8 | ConvertFrom-Json
  Write-Ok "Preserved existing local policy: $PolicyPath"
}

if (-not $SkipBuild) {
  Write-Step 'Installing locked bridge dependencies'
  Push-Location $BridgeRoot
  try {
    & $npm.Source ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) {
      throw "Bridge npm ci failed with exit code $LASTEXITCODE."
    }
    & $npm.Source run build
    if ($LASTEXITCODE -ne 0) {
      throw "Bridge build failed with exit code $LASTEXITCODE."
    }
  } finally {
    Pop-Location
  }
  Write-Ok 'Bridge MCP server, Native Messaging host, and Edge extension built'
}

if (-not (Test-Path -LiteralPath $McpEntryPath -PathType Leaf)) {
  throw "Bridge MCP entry is missing after build: $McpEntryPath"
}
if (-not (Test-Path -LiteralPath $ExtensionDistPath -PathType Container)) {
  throw "Edge extension output is missing after build: $ExtensionDistPath"
}

Write-Step 'Generating the current-machine Native Messaging manifest'
Write-Utf8NoBom -Path $NativeHostNodePath -Content $node.Source
$nativeManifest = Get-Content -LiteralPath $NativeManifestTemplate -Raw -Encoding UTF8 | ConvertFrom-Json
$nativeManifest.path = $NativeHostRunner
$nativeManifestJson = $nativeManifest | ConvertTo-Json -Depth 20
$null = $nativeManifestJson | ConvertFrom-Json
Write-Utf8NoBom -Path $NativeManifestPath -Content $nativeManifestJson
Write-Ok "Pinned Native Host Node.js runtime: $($node.Source)"
Write-Ok "Generated: $NativeManifestPath"

if (-not $SkipRegistry) {
  Write-Step 'Registering the Native Messaging host for the current Windows user'
  $registryPath = 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\m365_session_bridge'
  New-Item -Path $registryPath -Force | Out-Null
  Set-Item -Path $registryPath -Value $NativeManifestPath
  Write-Ok "Registered $registryPath"
} else {
  Write-Host '    SKIP: Registry registration was explicitly disabled.' -ForegroundColor Yellow
}

Write-Step 'Merging the built-in MCP server into M365 Golem local configuration'
$configDirectory = Split-Path -Parent $ConfigPath
New-Item -ItemType Directory -Force -Path $configDirectory | Out-Null
$servers = @()
if (Test-Path -LiteralPath $ConfigPath -PathType Leaf) {
  $rawConfig = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8
  try {
    $parsedConfig = $rawConfig | ConvertFrom-Json
  } catch {
    throw "Existing MCP config is invalid JSON; refusing to overwrite it: $ConfigPath. $($_.Exception.Message)"
  }
  if ($null -ne $parsedConfig) {
    $servers = @($parsedConfig)
  }
  $backupPath = "$ConfigPath.bak-$(Get-Date -Format yyyyMMddHHmmss)"
  Copy-Item -LiteralPath $ConfigPath -Destination $backupPath
  Write-Ok "Backed up existing local MCP config: $backupPath"
}

$existingIndex = -1
for ($index = 0; $index -lt $servers.Count; $index += 1) {
  if ((Get-PropertyValue $servers[$index] 'name' '') -eq 'm365-session-bridge') {
    $existingIndex = $index
    break
  }
}
$existing = if ($existingIndex -ge 0) { $servers[$existingIndex] } else { $null }
# Installer-owned built-ins must be immediately usable after install/update.
# A user may still toggle them later in the running dashboard, but rerunning
# setup restores the supported clean-install baseline.
$enabled = $true

$bridgeEntry = [ordered]@{
  name = 'm365-session-bridge'
  command = $node.Source
  args = @($McpEntryPath)
  env = [ordered]@{
    M365_GOLEM_ROOT = $GolemRoot
    M365_BRIDGE_POLICY_PATH = $PolicyPath
    M365_BRIDGE_LOG_PATH = $ActionLogPath
    M365_BRIDGE_SECRET_PATH = $SecretPath
    M365_BRIDGE_CONTROL_PORT = '43241'
  }
  timeout = 180000
  enabled = $enabled
  description = 'Built-in exact-URL SharePoint Online and OneDrive for Business bridge for approved folder creation, upload, copy, move, rename, metadata and read operations using the current user Edge session.'
  builtIn = $true
  managedBy = 'm365-golem'
}

$cachedTools = Get-PropertyValue $existing 'cachedTools' $null
if ($null -ne $cachedTools) {
  $bridgeEntry.cachedTools = @($cachedTools)
}

if ($existingIndex -ge 0) {
  $servers[$existingIndex] = [PSCustomObject]$bridgeEntry
} else {
  $servers += [PSCustomObject]$bridgeEntry
}

$chromePackagePath = Join-Path $GolemRoot 'node_modules\chrome-devtools-mcp\package.json'
if (-not (Test-Path -LiteralPath $chromePackagePath -PathType Leaf)) {
  throw "Built-in chrome-devtools dependency is missing. Run npm install in $GolemRoot before setup."
}
$chromePackage = Get-Content -LiteralPath $chromePackagePath -Raw -Encoding UTF8 | ConvertFrom-Json
$chromeRelativeEntry = if ($chromePackage.bin -is [string]) {
  $chromePackage.bin
} else {
  Get-PropertyValue $chromePackage.bin 'chrome-devtools-mcp' ''
}
if (-not $chromeRelativeEntry) {
  throw "chrome-devtools-mcp package does not declare its CLI entry: $chromePackagePath"
}
$chromeEntryPath = [System.IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $chromePackagePath) $chromeRelativeEntry))
if (-not (Test-Path -LiteralPath $chromeEntryPath -PathType Leaf)) {
  throw "chrome-devtools-mcp CLI entry was not found: $chromeEntryPath"
}

$edgeCandidates = @(
  (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
  (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
  (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) }
$chromeArgs = @(
  $chromeEntryPath,
  '--headless=true',
  '--isolated=true',
  '--no-usage-statistics',
  '--no-performance-crux'
)
if ($edgeCandidates.Count -gt 0) {
  $chromeArgs += "--executablePath=$($edgeCandidates[0])"
}

$chromeExistingIndex = -1
for ($index = 0; $index -lt $servers.Count; $index += 1) {
  if ((Get-PropertyValue $servers[$index] 'name' '') -eq 'chrome-devtools') {
    $chromeExistingIndex = $index
    break
  }
}
$chromeExisting = if ($chromeExistingIndex -ge 0) { $servers[$chromeExistingIndex] } else { $null }
$chromeEnabled = $true
$chromeEntry = [ordered]@{
  name = 'chrome-devtools'
  command = $node.Source
  args = $chromeArgs
  env = [ordered]@{
    CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS = '1'
  }
  timeout = 120000
  enabled = $chromeEnabled
  description = 'Built-in isolated browser inspection and automation. It does not reuse the signed-in M365 Edge session.'
  builtIn = $true
  managedBy = 'm365-golem'
}
$chromeCachedTools = Get-PropertyValue $chromeExisting 'cachedTools' $null
if ($null -ne $chromeCachedTools) {
  $chromeEntry.cachedTools = @($chromeCachedTools)
}
if ($chromeExistingIndex -ge 0) {
  $servers[$chromeExistingIndex] = [PSCustomObject]$chromeEntry
} else {
  $servers += [PSCustomObject]$chromeEntry
}

$serverArray = [object[]]@($servers)
$configJson = ConvertTo-Json -InputObject $serverArray -Depth 100
$null = $configJson | ConvertFrom-Json
Write-Utf8NoBom -Path $ConfigPath -Content $configJson
Write-Ok "Configured built-in MCP servers: m365-session-bridge, chrome-devtools"

Write-Step 'Built-in M365 Session Bridge installation complete'
Write-Host @"

One visible Edge step remains (browsers do not permit silent extension installs):

  1. Open edge://extensions in Microsoft Edge
  2. Turn on Developer mode
  3. Select Load unpacked
  4. Choose:
       $ExtensionDistPath

The extension ID should be $FixedExtensionId.
M365 permissions still come only from the user's signed-in Edge session.
"@ -ForegroundColor White
