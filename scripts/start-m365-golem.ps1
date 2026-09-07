<#
.SYNOPSIS
  Starts M365 Golem without a visible console and opens its dashboard as an
  independent Microsoft Edge app window.
#>
[CmdletBinding()]
param(
  [switch]$CheckOnly,
  [switch]$SkipAppWindow,
  [ValidateRange(10, 180)]
  [int]$ReadyTimeoutSeconds = 60
)

$ErrorActionPreference = 'Stop'
$GolemRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$LauncherTitle = 'M365 Golem'

function Show-LauncherMessage([string]$Message, [int]$Icon = 48) {
  try {
    $shell = New-Object -ComObject WScript.Shell
    [void]$shell.Popup($Message, 0, $LauncherTitle, $Icon)
    [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($shell)
  } catch {
    Write-Error $Message
  }
}

function Get-NodeExecutable {
  $command = Get-Command 'node.exe' -ErrorAction SilentlyContinue
  if (-not $command) { $command = Get-Command 'node' -ErrorAction SilentlyContinue }
  if (-not $command) {
    throw 'Node.js 20 or newer was not found. Run Install-M365-Golem.bat first.'
  }
  return $command.Source
}

function Get-PreferredPort {
  $port = 3000
  $envPath = Join-Path $GolemRoot '.env'
  if (Test-Path -LiteralPath $envPath -PathType Leaf) {
    $match = Select-String -LiteralPath $envPath -Pattern '^\s*DASHBOARD_PORT\s*=\s*(\d+)\s*$' | Select-Object -First 1
    if ($match -and [int]::TryParse($match.Matches[0].Groups[1].Value, [ref]$port)) {
      return $port
    }
  }
  return $port
}

function Find-GolemInstance([int]$PreferredPort) {
  foreach ($offset in 0..9) {
    $port = $PreferredPort + $offset
    $baseUrl = "http://127.0.0.1:$port"
    try {
      $health = Invoke-RestMethod -Uri "$baseUrl/api/health" -Method Get -TimeoutSec 1
      if ($health.app -eq 'm365-golem' -and $health.status -eq 'ok') {
        return $baseUrl
      }

      # Compatibility with a Golem process started before the app identity field
      # was introduced. This prevents an update from starting a duplicate server.
      if (-not $health.app -and $health.status -eq 'ok') {
        $legacyStatus = Invoke-RestMethod -Uri "$baseUrl/api/system/status" -Method Get -TimeoutSec 1
        if ($legacyStatus.health.core -eq $true -and $legacyStatus.dashboardPort) {
          return $baseUrl
        }
      }
    } catch {
      continue
    }
  }
  return $null
}

function Get-EdgeExecutable {
  $candidates = @()
  foreach ($basePath in @(${env:ProgramFiles(x86)}, $env:ProgramFiles, $env:LOCALAPPDATA)) {
    if (-not [string]::IsNullOrWhiteSpace($basePath)) {
      $candidates += Join-Path $basePath 'Microsoft\Edge\Application\msedge.exe'
    }
  }

  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
  }

  $edgeCommand = Get-Command 'msedge.exe' -ErrorAction SilentlyContinue
  if ($edgeCommand) { return $edgeCommand.Source }
  throw 'Microsoft Edge was not found. Install or repair Edge, then try again.'
}

try {
  Set-Location $GolemRoot

  $requiredPaths = @(
    'package.json',
    'node_modules',
    'web-dashboard\node_modules',
    'web-dashboard\.next',
    'integrations\m365-session-bridge\apps\mcp-server\dist\index.js',
    'data\mcp-servers.json'
  )
  $missing = @($requiredPaths | Where-Object { -not (Test-Path -LiteralPath (Join-Path $GolemRoot $_)) })
  if ($missing.Count -gt 0) {
    throw "Installation is incomplete. Run Install-M365-Golem.bat first.`n`nMissing: $($missing -join ', ')"
  }

  $node = Get-NodeExecutable
  $envPath = Join-Path $GolemRoot '.env'
  if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) {
    Copy-Item -LiteralPath (Join-Path $GolemRoot 'M365-POC.env.example') -Destination $envPath
  }
  if (-not (Select-String -LiteralPath $envPath -Pattern '^\s*GOLEM_BACKEND\s*=\s*m365-web\s*$' -Quiet)) {
    throw '.env is not configured for GOLEM_BACKEND=m365-web. It was not overwritten.'
  }

  & $node (Join-Path $GolemRoot 'scripts\ensure-m365-workspace-env.js') | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Workspace initialization failed with exit code $LASTEXITCODE."
  }

  if ($CheckOnly) { exit 0 }

  $preferredPort = Get-PreferredPort
  $baseUrl = Find-GolemInstance $preferredPort
  if (-not $baseUrl) {
    $previousSkipBrowser = [Environment]::GetEnvironmentVariable('SKIP_BROWSER', 'Process')
    $previousDisableTui = [Environment]::GetEnvironmentVariable('DISABLE_TUI', 'Process')
    try {
      [Environment]::SetEnvironmentVariable('SKIP_BROWSER', '1', 'Process')
      [Environment]::SetEnvironmentVariable('DISABLE_TUI', 'true', 'Process')
      $golemProcess = Start-Process -FilePath $node `
        -ArgumentList @('--expose-gc', 'apps/runtime/index.js', 'dashboard') `
        -WorkingDirectory $GolemRoot `
        -WindowStyle Hidden `
        -PassThru
    } finally {
      [Environment]::SetEnvironmentVariable('SKIP_BROWSER', $previousSkipBrowser, 'Process')
      [Environment]::SetEnvironmentVariable('DISABLE_TUI', $previousDisableTui, 'Process')
    }

    $deadline = [DateTime]::UtcNow.AddSeconds($ReadyTimeoutSeconds)
    do {
      Start-Sleep -Milliseconds 500
      if ($golemProcess.HasExited) {
        throw "M365 Golem stopped during startup (exit code $($golemProcess.ExitCode))."
      }
      $baseUrl = Find-GolemInstance $preferredPort
      if ($baseUrl) { break }
    } while ([DateTime]::UtcNow -lt $deadline)

    if (-not $baseUrl) {
      throw "M365 Golem did not become ready within $ReadyTimeoutSeconds seconds."
    }
  }

  if (-not $SkipAppWindow) {
    $edge = Get-EdgeExecutable
    $appUrl = "$baseUrl/dashboard/chat"
    Start-Process -FilePath $edge -ArgumentList @("--app=$appUrl", '--new-window') | Out-Null
  }
} catch {
  Show-LauncherMessage $_.Exception.Message 16
  exit 1
}
