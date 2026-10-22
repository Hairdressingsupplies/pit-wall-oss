# Restart Pit Wall safely, then check it answers.
# A server that runs chats under relays (it writes data\relays\supported.txt with its PID) restarts at once: its
# chats keep running and the new server picks them up. An older server's chats would be cut off, so for one of
# those this waits until no chat is mid-reply. Idle chats are unaffected either way.
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$node = 'C:\Program Files\nodejs\node.exe'
$query = "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1],{readOnly:true});" +
         "console.log(db.prepare('SELECT COUNT(*) n FROM session_meta WHERE interrupted=1 AND hidden=0').get().n)"

function Get-Busy { [int](& $node -e $query (Join-Path $root 'data\pitwall.db')) }

$supported = Join-Path $root 'data\relays\supported.txt'
$running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*server.mjs*' }
$relays = (Test-Path $supported) -and ($running | Where-Object { [string]$_.ProcessId -eq (Get-Content $supported -Raw).Trim() })
if ($relays) { Write-Host 'Chats run under relays: restarting now - they keep running and are picked up again.' }

$waited = 0
while (-not $relays) {
    $busy = Get-Busy
    if ($busy -eq 0) { Start-Sleep -Seconds 3; if ((Get-Busy) -eq 0) { break } }   # still idle 3 s later
    if ($waited -eq 0) { Write-Host "Waiting: $busy chat(s) are mid-reply or still running agents. Pit Wall restarts as soon as they finish..." }
    Start-Sleep -Seconds 3
    $waited += 3
    if ($waited -ge 1800) { Write-Host 'Still busy after 30 minutes - not restarting. Run this again later.'; exit 1 }
}

Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*server.mjs*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Seconds 1
Start-Process wscript.exe -ArgumentList ('"' + (Join-Path $root 'start-hidden.vbs') + '"')

foreach ($i in 1..15) {
    Start-Sleep -Seconds 1
    try {
        $ok = (Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:4040/' -TimeoutSec 3).StatusCode -eq 200
        # Ready once it has picked up the running chats (it then writes its PID to supported.txt).
        $new = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*server.mjs*' }
        if ($ok -and (Test-Path $supported) -and -not ($new | Where-Object { [string]$_.ProcessId -eq (Get-Content $supported -Raw).Trim() })) { $ok = $false }
        if ($ok) {
            Write-Host 'Pit Wall restarted. Refresh the page.'
            exit 0
        }
    } catch { }
}
Write-Host 'Pit Wall did not come back. Look at data\server.log, or double-click "Pit Wall.cmd".'
exit 1
