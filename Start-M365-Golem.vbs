Option Explicit

Dim fileSystem, shell, rootDirectory, launcherScript, commandLine
Set fileSystem = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

rootDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
launcherScript = fileSystem.BuildPath(rootDirectory, "scripts\start-m365-golem.ps1")

If Not fileSystem.FileExists(launcherScript) Then
    shell.Popup "M365 Golem launcher is missing. Run Install-M365-Golem.bat to repair the installation.", 0, "M365 Golem", 16
    WScript.Quit 1
End If

commandLine = "powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & launcherScript & """"
shell.Run commandLine, 0, False
