[CmdletBinding()]
param(
  [switch]$SkipDependencies,
  [switch]$SkipDashboardBuild,
  [switch]$SkipBridgeBuild,
  [switch]$SkipBridgeRegistry,
  [switch]$PlanOnly
)

$installer = Join-Path $PSScriptRoot 'scripts\install-m365-golem.ps1'
try {
  & $installer @PSBoundParameters
  exit 0
} catch {
  Write-Error $_
  exit 1
}
