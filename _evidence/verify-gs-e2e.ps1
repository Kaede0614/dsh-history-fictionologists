# DEPRECATED — use verify-gs-e2e.mjs instead.
#
# This PowerShell version was the first attempt at the reproducible end-to-end check.
# It fights Windows PowerShell 5.1 (no ternary operator, `$pid` is read-only,
# ReadToEndAsync never resolves for a long-lived child, Start-Process dies on
# duplicate NO_PROXY/no_proxy env keys) and one of its teardown drafts swept
# `Get-Process node` wholesale — which killed the user's LIVE dsh instance.
#
# The Node version (verify-gs-e2e.mjs) does the same four steps with no shell
# quirks and kills only its own child tree. Kept in the tree as a record of the
# mistake, not as a tool to run.
#
# Usage of the current harness: node _evidence/verify-gs-e2e.mjs

$ErrorActionPreference = 'Stop'

$PluginDir = "C:\Users\masha\Desktop\hsr-history-fictionologists"
$TestHome  = "C:\Users\masha\hsr-fictionologists-testhome"
$TestWs    = "C:\Users\masha\hsr-fictionologists-testws"
$Profile   = Join-Path $TestHome 'profiles\web'
$Port      = 3081

Write-Host "== 1. isolated home + web profile ==" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path (Join-Path $Profile 'node_modules'), $TestWs | Out-Null
if (-not (Test-Path (Join-Path $TestHome '.credentials.yaml'))) {
  Copy-Item "$env:USERPROFILE\.dsh\.credentials.yaml" (Join-Path $TestHome '.credentials.yaml')
}
$link = Join-Path $Profile 'node_modules\dsh-history-fictionologists'
if (Test-Path $link) { Remove-Item $link -Force -Recurse }
New-Item -ItemType Junction -Path $link -Target $PluginDir | Out-Null

$enc = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $Profile 'package.json'), @'
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": { "dsh-history-fictionologists": "link:C:/Users/masha/Desktop/hsr-history-fictionologists" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-history-fictionologists"], "patchReload": "live" } }
}
'@, $enc)
[System.IO.File]::WriteAllText((Join-Path $Profile 'cordis.patch.yml'), @"
- id: dsh-history-fictionologists
  config:
    workspace: $TestWs
    requestIntervalMs: 2000
"@, $enc)

$env:DSH_HOME = $TestHome
$env:NODE_PATH = "$env:APPDATA\npm\node_modules;$env:APPDATA\npm\node_modules\@deepseek-ai\dsh\node_modules"

Write-Host "== 2. boot isolated web instance on port $Port ==" -ForegroundColor Cyan
$log = Join-Path $TestWs 'test-instance.log'
# Windows PowerShell 5.1 Start-Process copies the parent environment into a
# dictionary and throws on case-insensitive duplicates (NO_PROXY / no_proxy).
# Launch through cmd.exe via .NET instead, which inherits normally.
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = "$env:APPDATA\npm\dsh.cmd"
$psi.Arguments = "--profile web --port $Port --no-open"
$psi.WorkingDirectory = $TestWs
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$proc = New-Object System.Diagnostics.Process
$proc.StartInfo = $psi
[void]$proc.Start()
# The instance keeps stdout open for its whole life, so a single ReadToEndAsync
# never resolves. Read line by line instead and append into a shared buffer.
$script:instanceOutput = New-Object System.Text.StringBuilder
$stdoutHandler = {
  if ($EventArgs.Data -ne $null) { [void]$script:instanceOutput.AppendLine($EventArgs.Data) }
}
$errHandler = {
  if ($EventArgs.Data -ne $null) { [void]$script:instanceOutput.AppendLine($EventArgs.Data) }
}
Register-ObjectEvent -InputObject $proc -EventName OutputDataReceived -Action $stdoutHandler | Out-Null
Register-ObjectEvent -InputObject $proc -EventName ErrorDataReceived -Action $errHandler | Out-Null
$proc.BeginOutputReadLine()
$proc.BeginErrorReadLine()

try {
  $token = $null
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 1000
    $captured = $script:instanceOutput.ToString()
    $m = [regex]::Match($captured, 'token=([A-Za-z0-9_\-]+)')
    if ($m.Success) { $token = $m.Groups[1].Value; break }
    if ($proc.HasExited) { break }
  }
  if (-not $token) {
    $tail = ($script:instanceOutput.ToString() -split "`r?`n" | Where-Object { $_ -ne '' } | Select-Object -Last 6) -join ' | '
    throw "the instance never printed a token. captured output: $tail"
  }
  Write-Host "   token acquired"

  Write-Host "== 3. authenticate (token -> signed cookie) ==" -ForegroundColor Cyan
  $jar = Join-Path $TestWs 'cookies.txt'
  Remove-Item $jar -ErrorAction SilentlyContinue
  & curl.exe -s -S -m 20 -c $jar -o NUL "http://127.0.0.1:$Port/?token=$token"

  function Invoke-Rpc([string]$method, [hashtable]$args, [string]$rpcId) {
    $body = @{ type = 'client-request'; rpcId = $rpcId; method = $method; payload = @{ args = $args } } | ConvertTo-Json -Depth 8 -Compress
    $file = Join-Path $TestWs "rpc-$($rpcId).json"
    [System.IO.File]::WriteAllText($file, $body, $enc)
    return (& curl.exe -s -S -m 120 -b $jar -X POST -H "Content-Type: application/json" --data-binary "@$file" "http://127.0.0.1:$Port/api/$method")
  }

  Write-Host "== 4. commands/list (is /gs registered and discoverable?) ==" -ForegroundColor Cyan
  $created = Invoke-Rpc 'session/create' @{ request = @{ cwd = $TestWs } } 'c1'
  $sid = ([regex]'"sessionId":"([^"]+)"').Match($created).Groups[1].Value
  if (-not $sid) { throw "session/create failed: $created" }
  Write-Host "   session: $sid"

  $listed = Invoke-Rpc 'commands/list' @{ agentId = $sid } 'l1'
  if ($listed -notmatch '"name":"gs"') { throw "commands/list does not expose /gs: $listed" }
  Write-Host "   /gs IS exposed by commands/list"
  Write-Host "   $listed"

  Write-Host "== 5. commands/execute '/gs' ==" -ForegroundColor Cyan
  $executed = Invoke-Rpc 'commands/execute' @{ agentId = $sid; line = '/gs'; submittedAttachments = @() } 'x1'
  Write-Host "   $executed"
  if ($executed -notmatch '"kind":"success"') { throw "/gs did not return a success result: $executed" }
  Write-Host "`nRESULT: PASS" -ForegroundColor Green
}
finally {
  Write-Host "== 6. teardown ==" -ForegroundColor Cyan
  # Kill ONLY this instance's own process tree, discovered by walking
  # ParentProcessId downward from the wrapper we started. Never sweep
  # "all node.exe": that is exactly how you kill somebody's live dsh instance.
  $root = if ($proc) { $proc.Id } else { 0 }
  $tree = New-Object System.Collections.Generic.List[int]
  if ($root -ne 0) { [void]$tree.Add([int]$root) }
  for ($depth = 0; $depth -lt 4; $depth++) {
    foreach ($parent in @($tree)) {
      Get-CimInstance Win32_Process -Filter "ParentProcessId=$parent" -ErrorAction SilentlyContinue |
        ForEach-Object { if (-not $tree.Contains([int]$_.ProcessId)) { [void]$tree.Add([int]$_.ProcessId) } }
    }
  }
  foreach ($pid in @($tree | Sort-Object -Descending)) {
    Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 2
  $stillListening = Test-NetConnection -ComputerName 127.0.0.1 -Port $Port -InformationLevel Quiet -WarningAction SilentlyContinue
  Write-Host ("   killed pids: " + (($tree | Sort-Object) -join ', '))
  Write-Host "   port $Port still listening: $stillListening"
  if ($stillListening) {
    # Last resort, still scoped: only the process that owns the TEST port.
    $owner = (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
    if ($owner) { Write-Host "   force-stopping test-port owner pid $owner"; Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue }
  }
}
