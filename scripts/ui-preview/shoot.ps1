# Screenshots of the UI preview (start it first: npx vite --config scripts/ui-preview/vite.config.ts)
#   powershell -File scripts/ui-preview/shoot.ps1 -Out <folder> -Prefix after
param([string]$Out = "$PSScriptRoot\shots", [string]$Prefix = 'shot', [int]$Height = 2200)
New-Item -ItemType Directory -Force $Out | Out-Null
$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if (-not (Test-Path $edge)) { $edge = "C:\Program Files\Google\Chrome\Application\chrome.exe" }
foreach ($s in 'session', 'idle', 'settings') {
  & $edge --headless=new --disable-gpu --hide-scrollbars --virtual-time-budget=6000 --window-size=600,$Height --screenshot="$Out\$Prefix-$s.png" "http://localhost:5180/?scenario=$s" 2>$null | Out-Null
  Start-Sleep -Milliseconds 800
}
Get-ChildItem $Out -Filter "$Prefix-*.png" | Select-Object Name, Length
