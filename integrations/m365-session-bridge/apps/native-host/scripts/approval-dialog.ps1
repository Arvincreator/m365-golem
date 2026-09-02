param(
  [string]$Hostname,
  [string]$Url,
  [string]$Action,
  [string]$Detail
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$script:resultWritten = $false

function Complete([string]$Result) {
  if ($script:resultWritten) { return }
  $script:resultWritten = $true
  [Console]::Out.WriteLine("RESULT:$Result")
  if ($script:form) { $script:form.Close() }
}

$form = New-Object System.Windows.Forms.Form
$script:form = $form
$form.Text = "M365 Session Bridge - Approval required"
$form.TopMost = $true
$form.StartPosition = "CenterScreen"
$form.Width = 780
$form.Height = 520
$form.MinimizeBox = $false
$form.MaximizeBox = $false

$layout = New-Object System.Windows.Forms.TableLayoutPanel
$layout.Dock = "Fill"
$layout.Padding = New-Object System.Windows.Forms.Padding(16)
$layout.ColumnCount = 1
$layout.RowCount = 5
$layout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::AutoSize))) | Out-Null
$layout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::AutoSize))) | Out-Null
$layout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 100))) | Out-Null
$layout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::AutoSize))) | Out-Null
$layout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::AutoSize))) | Out-Null
$form.Controls.Add($layout)

$title = New-Object System.Windows.Forms.Label
$title.Text = "This SharePoint / OneDrive target is not on the allowlist"
$title.Font = New-Object System.Drawing.Font("Segoe UI", 14, [System.Drawing.FontStyle]::Bold)
$title.AutoSize = $true
$layout.Controls.Add($title, 0, 0)

$hostLabel = New-Object System.Windows.Forms.Label
$hostLabel.Text = "Host: $Hostname`nAction: $Action"
$hostLabel.AutoSize = $true
$hostLabel.Margin = New-Object System.Windows.Forms.Padding(0, 10, 0, 8)
$layout.Controls.Add($hostLabel, 0, 1)

$urlBox = New-Object System.Windows.Forms.RichTextBox
$urlBox.ReadOnly = $true
$urlBox.Multiline = $true
$urlBox.WordWrap = $true
$urlBox.ScrollBars = "Vertical"
$urlBox.Dock = "Fill"
$urlBox.Text = "Full target URL:`n$Url"
$layout.Controls.Add($urlBox, 0, 2)

$detailLabel = New-Object System.Windows.Forms.Label
$detailLabel.Text = if ($Detail) { $Detail } else { "Review the complete URL and confirm this target is intended." }
$detailLabel.AutoSize = $true
$detailLabel.Margin = New-Object System.Windows.Forms.Padding(0, 10, 0, 8)
$layout.Controls.Add($detailLabel, 0, 3)

$buttons = New-Object System.Windows.Forms.FlowLayoutPanel
$buttons.FlowDirection = "RightToLeft"
$buttons.Dock = "Fill"
$buttons.AutoSize = $true
$layout.Controls.Add($buttons, 0, 4)

$deny = New-Object System.Windows.Forms.Button
$deny.Text = "Deny"
$deny.Width = 100
$deny.Add_Click({ Complete "DENY" })
$buttons.Controls.Add($deny)

$always = New-Object System.Windows.Forms.Button
$always.Text = "Always allow"
$always.Width = 120
$always.Add_Click({ Complete "ALLOW_ALWAYS" })
$buttons.Controls.Add($always)

$once = New-Object System.Windows.Forms.Button
$once.Text = "Allow once"
$once.Width = 120
$once.Add_Click({ Complete "ALLOW_ONCE" })
$buttons.Controls.Add($once)

$form.Add_FormClosing({
  if (-not $script:resultWritten) {
    $script:resultWritten = $true
    [Console]::Out.WriteLine("RESULT:DENY")
  }
})

[void]$form.ShowDialog()
if (-not $script:resultWritten) {
  $script:resultWritten = $true
  [Console]::Out.WriteLine("RESULT:DENY")
}
