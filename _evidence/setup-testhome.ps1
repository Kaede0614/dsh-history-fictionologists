# Build an ISOLATED dsh test instance that loads dsh-history-fictionologists.
# Hard rule: never modify the user's daily instance under ~/.dsh.
$ErrorActionPreference = 'Stop'

$DshRoot   = "$env:APPDATA\npm\node_modules\@deepseek-ai\dsh"
$GlobalNM  = "$env:APPDATA\npm\node_modules"
$TestHome  = "C:\Users\masha\hsr-fictionologists-testhome"
$Profiles  = Join-Path $TestHome 'profiles'
$Profile   = Join-Path $Profiles 'headless'
$PluginDir = "C:\Users\masha\Desktop\hsr-history-fictionologists"
$TestWs    = "C:\Users\masha\hsr-fictionologists-testws"

Write-Host "== 1. prepare isolated home ==" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $Profile | Out-Null
New-Item -ItemType Directory -Force -Path $TestWs  | Out-Null

# credentials: reuse the user's own key so the model calls actually work
if (-not (Test-Path (Join-Path $TestHome '.credentials.yaml'))) {
  Copy-Item "$env:USERPROFILE\.dsh\.credentials.yaml" (Join-Path $TestHome '.credentials.yaml')
  Write-Host "  copied credentials.yaml"
}

Write-Host "== 2. junction the plugin into the test profile ==" -ForegroundColor Cyan
$nm = Join-Path $Profile 'node_modules'
New-Item -ItemType Directory -Force -Path $nm | Out-Null
$link = Join-Path $nm 'dsh-history-fictionologists'
if (Test-Path $link) { Remove-Item $link -Force -Recurse }
New-Item -ItemType Junction -Path $link -Target $PluginDir | Out-Null
Write-Host "  $link -> $PluginDir"

Write-Host "== 3. profile package.json (bundles stack, plugin last) ==" -ForegroundColor Cyan
$pkgPath = Join-Path $Profile 'package.json'
$pkg = [ordered]@{
  name    = 'dsh-profile-headless'
  private = $true
  dependencies = [ordered]@{ 'dsh-history-fictionologists' = 'link:' + ($PluginDir -replace '\\','/') }
  dsh = [ordered]@{ profile = [ordered]@{ bundles = @('@deepseek-ai/dsh-base','@deepseek-ai/dsh-headless','dsh-history-fictionologists'); patchReload = 'live' } }
}
$pkg | ConvertTo-Json -Depth 8 | Set-Content $pkgPath -Encoding UTF8
Get-Content $pkgPath

Write-Host "== 4. profile patch layer (plugin config) ==" -ForegroundColor Cyan
$patch = @'
# Test-instance patch layer for dsh-history-fictionologists.
- id: dsh-history-fictionologists
  config:
    workspace: C:\Users\masha\hsr-fictionologists-testws
    requestIntervalMs: 2000
    staleAfterDays: 7
    saveOutputs: true
'@
Set-Content (Join-Path $Profile 'cordis.patch.yml') $patch -Encoding UTF8

Write-Host "== 5. dump-config ==" -ForegroundColor Cyan
$env:DSH_HOME = $TestHome
$env:NODE_PATH = "$GlobalNM;$DshRoot\node_modules"
& "$env:APPDATA\npm\dsh.cmd" --profile headless --dump-config 2>&1 |
  Select-String -Pattern 'history-fictionologists' -Context 0,8
Write-Host "dump exit: $LASTEXITCODE"
