<#
.SYNOPSIS
  Builds a clean Windows installation ZIP from reviewed, tracked source files.
#>
[CmdletBinding()]
param(
  [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$PackageJsonPath = Join-Path $ProjectRoot 'package.json'
$PackageJson = Get-Content -LiteralPath $PackageJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($PackageJson.name -ne 'm365-golem') {
  throw "Refusing to package an unexpected project: $($PackageJson.name)"
}

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  $OutputDirectory = Join-Path $ProjectRoot 'release'
}
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null

$ReleaseName = "M365-Golem-v$($PackageJson.version)"
$ZipPath = Join-Path $OutputDirectory "$ReleaseName.zip"
$HashPath = Join-Path $OutputDirectory "$ReleaseName-SHA256.txt"
$StageRoot = Join-Path $OutputDirectory ".stage-$([Guid]::NewGuid().ToString('N'))"
$PackageRoot = Join-Path $StageRoot $ReleaseName

function Get-Sha256Hex([string]$Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  $algorithm = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = $algorithm.ComputeHash($stream)
    return ([System.BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
  } finally {
    $algorithm.Dispose()
    $stream.Dispose()
  }
}

$RootFiles = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
@(
  '.nvmrc',
  '00-安裝前請先閱讀.txt',
  'COMMERCIAL-LICENSE.md',
  'dashboard.js',
  'index.js',
  'Install-M365-Golem.bat',
  'LICENSE',
  'M365-POC.env.example',
  'package-lock.json',
  'package.json',
  'README.md',
  'Start-Golem.bat'
) | ForEach-Object { [void]$RootFiles.Add($_) }

$AllowedScriptFiles = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
@(
  'scripts/check-architecture-boundaries.js',
  'scripts/doctor.js',
  'scripts/ensure-m365-workspace-env.js',
  'scripts/install-m365-golem.ps1',
  'scripts/install-m365-session-bridge.ps1',
  'scripts/select-workspace-folder.ps1',
  'scripts/runtime-check.js'
) | ForEach-Object { [void]$AllowedScriptFiles.Add($_) }

$AllowedDocFiles = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
@(
  'docs/M365-COPILOT-WEB-POC.zh-TW.md',
  'docs/M365-ONLY-SOURCE-ANALYSIS.zh-TW.md',
  'docs/MCP-Guide.en.md',
  'docs/MCP-使用與開發指南.md'
) | ForEach-Object { [void]$AllowedDocFiles.Add($_) }

function Test-ReleaseFile([string]$RelativePath) {
  $normalized = $RelativePath.Replace('\', '/')
  if ($normalized -match '(^|/)(test|tests)(/|$)' -or $normalized -match '\.test\.[^/]+$') { return $false }
  if ($normalized -match '(^|/)(node_modules|\.next|dist|coverage|profiles?|data|logs|release)(/|$)') { return $false }
  if ($normalized -match '^assets/' -or $normalized -match '^tools/notebooklm-studio/docs/images/') { return $false }
  if ($normalized -match '(^|/)\.env(?:\.|$)' -or $normalized -match '\.(?:sqlite|db|log|tsbuildinfo)$') { return $false }
  if ($normalized -match 'manifest\.json$' -and $normalized -match 'm365-session-bridge/apps/(?:edge-extension|native-host)/') { return $false }
  if ($normalized -match 'm365-session-bridge/(?:config/policy\.json|runtime/|logs/)') { return $false }
  if ($RootFiles.Contains($normalized)) { return $true }
  if ($AllowedScriptFiles.Contains($normalized)) { return $true }
  if ($AllowedDocFiles.Contains($normalized)) { return $true }
  return $normalized -match '^(apps|integrations/m365-session-bridge|packages|personas|src|tools/notebooklm-studio|web-dashboard)/'
}

try {
  New-Item -ItemType Directory -Path $PackageRoot -Force | Out-Null
  $TrackedFiles = & git -C $ProjectRoot ls-files --cached --others --exclude-standard
  if ($LASTEXITCODE -ne 0) { throw 'Unable to read the tracked source inventory.' }

  $Copied = [System.Collections.Generic.List[string]]::new()
  foreach ($relative in $TrackedFiles) {
    $normalized = ([string]$relative).Replace('\', '/')
    if (-not (Test-ReleaseFile $normalized)) { continue }
    $source = Join-Path $ProjectRoot $normalized
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { continue }
    $destination = Join-Path $PackageRoot $normalized
    $destinationParent = Split-Path -Parent $destination
    New-Item -ItemType Directory -Path $destinationParent -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination
    $Copied.Add($normalized)
  }

  $Required = @(
    'Install-M365-Golem.bat',
    'Start-Golem.bat',
    'package.json',
    'package-lock.json',
    'scripts/select-workspace-folder.ps1',
    'src/services/M365AttachmentService.js',
    'web-dashboard/package.json',
    'web-dashboard/package-lock.json',
    'web-dashboard/src/lib/m365-attachments.ts',
    'integrations/m365-session-bridge/package.json',
    'integrations/m365-session-bridge/package-lock.json'
  )
  foreach ($relative in $Required) {
    if (-not (Test-Path -LiteralPath (Join-Path $PackageRoot $relative) -PathType Leaf)) {
      throw "Release package is missing required file: $relative"
    }
  }

  $ManifestFiles = foreach ($relative in ($Copied | Sort-Object)) {
    $file = Join-Path $PackageRoot $relative
    [ordered]@{
      path = $relative
      bytes = (Get-Item -LiteralPath $file).Length
      sha256 = Get-Sha256Hex $file
    }
  }
  $Manifest = [ordered]@{
    product = 'M365 Golem'
    version = [string]$PackageJson.version
    generatedAt = (Get-Date).ToUniversalTime().ToString('o')
    fileCount = $ManifestFiles.Count
    excludesRuntimeData = $true
    files = $ManifestFiles
  }
  $Manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $PackageRoot 'INSTALL-MANIFEST.json') -Encoding UTF8

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  if (Test-Path -LiteralPath $ZipPath) { Remove-Item -LiteralPath $ZipPath -Force }
  [System.IO.Compression.ZipFile]::CreateFromDirectory(
    $StageRoot,
    $ZipPath,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $false
  )

  $archive = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
  try {
    $entries = @($archive.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })
    $forbidden = @($entries | Where-Object {
      $_ -match '(^|/)(test|tests|node_modules|\.next|profiles?|data|logs)(/|$)' -or
      $_ -match '(^|/)\.env(?:\.|$)' -or
      $_ -match '\.(?:sqlite|db|log|tsbuildinfo)$' -or
      $_ -match '(crypto-dashboard|stock-dashboard|public/rpg|api\.rpg|api\.stocks|api\.crypto|api\.diary)'
    })
    if ($forbidden.Count -gt 0) {
      throw "Release validation found forbidden entries: $($forbidden -join ', ')"
    }
  } finally {
    $archive.Dispose()
  }

  $hash = Get-Sha256Hex $ZipPath
  "$hash  $ReleaseName.zip" | Set-Content -LiteralPath $HashPath -Encoding ASCII
  Write-Host "Created: $ZipPath" -ForegroundColor Green
  Write-Host "SHA256: $hash" -ForegroundColor Green
  Write-Host "Files: $($ManifestFiles.Count)" -ForegroundColor Green
} finally {
  if (Test-Path -LiteralPath $StageRoot) {
    Remove-Item -LiteralPath $StageRoot -Recurse -Force
  }
}
