# Reinstalls launcher node_modules when Electron is missing or broken.
param(
    [string]$RepairRoot = ''
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'bloodpact-paths.ps1')

if (-not $RepairRoot) {
    $RepairRoot = Split-Path -Parent $PSScriptRoot
}
$RepairRoot = Normalize-BloodpactRoot -Root $RepairRoot
Test-BloodpactLayout -Root $RepairRoot
$LauncherDir = Join-Path $RepairRoot 'launcher'

function Find-NodeExe {
    $direct = Join-Path $RepairRoot 'tools\runtime\node\node.exe'
    if (Test-Path $direct) { return $direct }
    $nested = Get-ChildItem -Path (Join-Path $RepairRoot 'tools\runtime\node') -Filter 'node.exe' -Recurse -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($nested) { return $nested.FullName }
    return $null
}

function Find-NpmCli {
    $nodeExe = Find-NodeExe
    if (-not $nodeExe) { return $null }
    $direct = Join-Path (Split-Path $nodeExe) 'node_modules\npm\bin\npm-cli.js'
    if (Test-Path $direct) { return $direct }
    $nested = Get-ChildItem -Path (Join-Path $RepairRoot 'tools\runtime\node') -Filter 'npm-cli.js' -Recurse -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($nested) { return $nested.FullName }
    return $null
}

Write-Host ''
Write-Host '  BloodPact launcher repair'
Write-Host '  ========================='
Write-Host ''

if (-not (Test-Path (Join-Path $LauncherDir 'package.json'))) {
    throw 'launcher\package.json is missing. Extract the full BloodPact folder first.'
}

$electronCli = Join-Path $LauncherDir 'node_modules\electron\cli.js'
if (-not (Test-Path $electronCli)) {
    Write-Host '  Electron missing — reinstalling launcher dependencies...'
    $broken = Join-Path $LauncherDir 'node_modules'
    if (Test-Path $broken) {
        Remove-Item $broken -Recurse -Force
        Write-Host '     removed broken launcher\node_modules'
    }
} else {
    Write-Host '  Launcher dependencies look OK.'
    return
}

$nodeExe = Find-NodeExe
$npmCli = Find-NpmCli
if (-not $nodeExe -or -not $npmCli) {
    Write-Host '  Bundled Node.js missing — downloading...'
    & (Join-Path $PSScriptRoot 'ensure-runtime.ps1') -LauncherOnly
    $nodeExe = Find-NodeExe
    $npmCli = Find-NpmCli
}

if (-not $nodeExe -or -not $npmCli) {
    throw 'Node.js is not available. Run 2-Open-BloodPact.bat with internet, or install Node from https://nodejs.org'
}

Write-Host "  Using Node: $nodeExe"
Write-Host '  npm install (may take 1-3 minutes)...'
Push-Location $LauncherDir
& $nodeExe $npmCli install --no-audit --no-fund
$code = $LASTEXITCODE
Pop-Location

if ($code -ne 0 -or -not (Test-Path $electronCli)) {
    throw "Launcher install failed. Open launcher\bloodpact-launcher.log for details."
}

Write-Host '  Launcher dependencies installed.'
Write-Host ''
