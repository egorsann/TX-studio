# TX Studio installer -- per Windows user, no admin rights. Re-run to update.
# Copies the unzipped app to %LOCALAPPDATA%\Programs\TX Studio, adds Start Menu and
# Desktop shortcuts and an uninstaller, then starts the app.
$ErrorActionPreference = "Stop"
$exeName = "TX Studio.exe"
$src = Split-Path -Parent $PSScriptRoot                  # the folder holding "TX Studio.exe"
$dst = Join-Path $env:LOCALAPPDATA "Programs\TX Studio"
$cache = Join-Path $env:LOCALAPPDATA "TX Studio"            # WebView2 cache (settings live in %APPDATA%)

if (-not (Test-Path (Join-Path $src $exeName))) {
  throw "Run 'Install TX Studio.cmd' from the unzipped TX Studio folder (not from inside the zip)."
}

# close a running copy so its files can be replaced
Get-Process -Name "TX Studio" -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 300

if ((Resolve-Path $src).Path.TrimEnd("\") -ne $dst.TrimEnd("\")) {
  if (Test-Path $dst) { Remove-Item -LiteralPath $dst -Recurse -Force }
  New-Item -ItemType Directory -Force $dst | Out-Null
  Copy-Item -Path (Join-Path $src "*") -Destination $dst -Recurse -Force
}
# drop the "downloaded from the internet" mark so Windows doesn't ask on every start
Get-ChildItem -LiteralPath $dst -Recurse -File | Unblock-File

$exe = Join-Path $dst $exeName
$icon = Join-Path $dst "resources\app\src\icon.ico"
$shell = New-Object -ComObject WScript.Shell
$links = @((Join-Path ([Environment]::GetFolderPath("Programs")) "TX Studio.lnk"),
           (Join-Path ([Environment]::GetFolderPath("Desktop")) "TX Studio.lnk"))
foreach ($path in $links) {
  $lnk = $shell.CreateShortcut($path)
  $lnk.TargetPath = $exe
  $lnk.WorkingDirectory = $dst
  $lnk.IconLocation = "$icon,0"
  $lnk.Description = "Thermomagnetic curve viewer with automatic dry-run correction"
  $lnk.Save()
}

# uninstaller next to the app (settings in %APPDATA%\TX Studio are kept)
$un = @"
@echo off
echo Removing TX Studio ...
taskkill /im "TX Studio.exe" /f >nul 2>&1
del "$($links[0])" >nul 2>&1
del "$($links[1])" >nul 2>&1
cd /d "%TEMP%"
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep 2; Remove-Item -LiteralPath '$dst' -Recurse -Force; Remove-Item -LiteralPath '$cache' -Recurse -Force -ErrorAction SilentlyContinue"
echo TX Studio removed. Your settings in %%APPDATA%%\TX Studio were kept.
"@
Set-Content -LiteralPath (Join-Path $dst "Uninstall TX Studio.cmd") -Value $un -Encoding ASCII

Write-Host ""
Write-Host "TX Studio is installed:" -ForegroundColor Green
Write-Host "  $dst"
Write-Host "  Start Menu and Desktop shortcut 'TX Studio' created."
Write-Host "  To update later: download the new zip and run 'Install TX Studio.cmd' again."
Start-Process -FilePath $exe
