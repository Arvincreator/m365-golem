<#
.SYNOPSIS
  Reproducible Windows installer for a clean M365 Golem checkout.
#>
[CmdletBinding()]
param(
  [switch]$SkipDependencies,
  [switch]$SkipDashboardBuild,
  [switch]$SkipBridgeBuild,
  [switch]$SkipBridgeRegistry,
  [switch]$PlanOnly
)

$ErrorActionPreference = 'Stop'
$GolemRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location $GolemRoot

function Write-Step([string]$Message) {
  Write-Host "`n==> $Message" -ForegroundColor Cyan
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

$requiredFiles = @(
  'package.json',
  'package-lock.json',
  'web-dashboard\package.json',
  'web-dashboard\package-lock.json',
  'M365-POC.env.example',
  'Start-M365-Golem.vbs',
  'Start-Golem.bat',
  'integrations\m365-session-bridge\package.json'
)
foreach ($requiredFile in $requiredFiles) {
  if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
    throw "Clean checkout is incomplete: $requiredFile"
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

if ($PlanOnly) {
  Write-Step 'Validating clean-checkout installation plan'
  & (Join-Path $PSScriptRoot 'install-m365-session-bridge.ps1') -PlanOnly -SkipRegistry:$SkipBridgeRegistry -SkipBuild:$SkipBridgeBuild
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  Write-Host "`nM365 Golem clean-checkout plan is ready. No files or registry keys were changed." -ForegroundColor Green
  return
}

Write-Step 'Preparing the local M365 Golem configuration'
if (-not (Test-Path -LiteralPath '.env' -PathType Leaf)) {
  Copy-Item -LiteralPath 'M365-POC.env.example' -Destination '.env'
  Write-Host '    Created .env from the M365-safe template.' -ForegroundColor Green
} else {
  $backendLine = Select-String -LiteralPath '.env' -Pattern '^GOLEM_BACKEND=m365-web\s*$' -Quiet
  if (-not $backendLine) {
    throw 'Existing .env is not configured for GOLEM_BACKEND=m365-web. It was not overwritten.'
  }
  Write-Host '    Preserved existing M365 .env.' -ForegroundColor Green
}

if (-not $SkipDependencies) {
  Write-Step 'Installing locked M365 Golem dependencies'
  & $npm.Source ci --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) {
    throw "Root npm ci failed with exit code $LASTEXITCODE."
  }

  Push-Location 'web-dashboard'
  try {
    & $npm.Source ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) {
      throw "Dashboard npm ci failed with exit code $LASTEXITCODE."
    }
  } finally {
    Pop-Location
  }
}

if (-not $SkipDashboardBuild) {
  Write-Step 'Building the M365 Golem Dashboard'
  & $npm.Source run build
  if ($LASTEXITCODE -ne 0) {
    throw "Dashboard build failed with exit code $LASTEXITCODE."
  }
}

Write-Step 'Installing the built-in M365 Session Bridge'
& (Join-Path $PSScriptRoot 'install-m365-session-bridge.ps1') -SkipBuild:$SkipBridgeBuild -SkipRegistry:$SkipBridgeRegistry
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Step 'Initializing encrypted project workspace settings'
& $node.Source 'scripts\ensure-m365-workspace-env.js'
if ($LASTEXITCODE -ne 0) {
  throw "Encrypted workspace initialization failed with exit code $LASTEXITCODE."
}

Write-Step 'Creating the M365 Golem desktop shortcut'
try {
  $desktopDirectory = [Environment]::GetFolderPath('Desktop')
  if ([string]::IsNullOrWhiteSpace($desktopDirectory)) {
    throw 'Windows did not return the current user desktop folder.'
  }
  $wscriptPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
  $launcherPath = Join-Path $GolemRoot 'Start-M365-Golem.vbs'
  $shortcutPath = Join-Path $desktopDirectory 'M365 Golem.lnk'
  $shortcutShell = New-Object -ComObject WScript.Shell
  $shortcut = $shortcutShell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $wscriptPath
  $shortcut.Arguments = "`"$launcherPath`""
  $shortcut.WorkingDirectory = $GolemRoot
  $shortcut.Description = 'Start M365 Golem'
  $shortcut.Save()
  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($shortcut)
  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($shortcutShell)
  Write-Host "    Created shortcut: $shortcutPath" -ForegroundColor Green
} catch {
  Write-Warning "Desktop shortcut could not be created: $($_.Exception.Message)"
  Write-Warning 'You can still double-click Start-M365-Golem.vbs in the installation folder.'
}

Write-Host @"

=======================================================
  M365 Golem installation complete
=======================================================

Before the first SharePoint/OneDrive Bridge test, complete the visible Edge
extension step printed above. Then open the M365 Golem desktop shortcut or
double-click Start-M365-Golem.vbs.

Login, MFA, tenant consent, and SharePoint authorization always remain visible
user actions. No Copilot Chat API is used.
"@ -ForegroundColor Green
