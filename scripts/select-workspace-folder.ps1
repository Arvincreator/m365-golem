param(
    [string]$Description = "Select a workspace folder for M365 Golem",
    [string]$InitialPath = ""
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms

$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = $Description
$dialog.ShowNewFolderButton = $true
if ($InitialPath -and (Test-Path -LiteralPath $InitialPath -PathType Container)) {
    $dialog.SelectedPath = (Resolve-Path -LiteralPath $InitialPath).Path
}

$owner = New-Object System.Windows.Forms.Form
$owner.Text = "M365 Golem"
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Opacity = 0

try {
    $owner.Show()
    $owner.Activate()
    $result = $dialog.ShowDialog($owner)
    if ($result -ne [System.Windows.Forms.DialogResult]::OK -or -not $dialog.SelectedPath) {
        [Console]::Out.Write("CANCELLED")
        exit 0
    }

    $bytes = [System.Text.Encoding]::UTF8.GetBytes($dialog.SelectedPath)
    $encoded = [System.Convert]::ToBase64String($bytes)
    [Console]::Out.Write("SELECTED:$encoded")
} finally {
    $dialog.Dispose()
    $owner.Close()
    $owner.Dispose()
}
