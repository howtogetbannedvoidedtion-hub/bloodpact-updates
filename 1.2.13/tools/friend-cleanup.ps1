# Cleans stale BloodPact caches and reinstalls the mod jar. Keeps worlds/saves.
param(
    [string]$RepairRoot = ''
)

$ErrorActionPreference = 'Stop'
$ModJarName = 'bloodpact-26.1.2-1.0.0.jar'

function Write-Step([string]$Message) {
    Write-Host ''
    Write-Host "  >> $Message"
}

. (Join-Path $PSScriptRoot 'bloodpact-paths.ps1')

if (-not $RepairRoot) {
    $RepairRoot = Split-Path -Parent $PSScriptRoot
}

$RepairRoot = Normalize-BloodpactRoot -Root $RepairRoot
Test-BloodpactLayout -Root $RepairRoot

Write-Host ''
Write-Host '  BloodPact repair'
Write-Host '  ==============='
Write-Host ''
Write-Host "  Folder: $RepairRoot"
Write-Host '  (Your worlds and username are kept.)'
Write-Host ''

Write-Step 'Removing old cache and staging files...'
$removePaths = @(
    'mod-cache',
    'instance-staging',
    'quarantine',
    (Join-Path 'launcher' 'crash-logs')
)
foreach ($rel in $removePaths) {
    $target = Join-Path $RepairRoot $rel
    if (Test-Path $target) {
        Remove-Item $target -Recurse -Force
        Write-Host "     removed $rel"
    }
}

Write-Step 'Removing old BloodPact mod copies (launcher will re-sync)...'
$instancesRoot = Join-Path $RepairRoot 'instances'
if (Test-Path $instancesRoot) {
    Get-ChildItem -Path $instancesRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        $modsDir = Join-Path $_.FullName 'mods'
        if (-not (Test-Path $modsDir)) { return }
        Get-ChildItem -Path $modsDir -Filter '*.jar' -ErrorAction SilentlyContinue | ForEach-Object {
            if ($_.Name -like 'bloodpact*') {
                Remove-Item $_.FullName -Force
                Write-Host "     removed $($_.Name) from $($_.Directory.Parent.Name)"
            }
        }
    }
}

Write-Step 'Installing BloodPact mod jar...'
$jarSources = @(
    (Join-Path $RepairRoot "bundled-mods\$ModJarName"),
    (Join-Path $RepairRoot "launcher\bundled-mods\$ModJarName")
)
$sourceJar = $null
foreach ($candidate in $jarSources) {
    if ((Test-Path $candidate) -and ((Get-Item $candidate).Length -gt 1000)) {
        $sourceJar = $candidate
        break
    }
}

if (-not $sourceJar) {
    $ensureScript = Join-Path $PSScriptRoot 'ensure-mod-jar.ps1'
    if (Test-Path $ensureScript) {
        try {
            $sourceJar = & $ensureScript -Quiet
        } catch {
            # Friend PC may not be able to build — fall through to error below.
        }
    }
}

if (-not $sourceJar -or -not (Test-Path $sourceJar)) {
    throw "BloodPact mod jar is missing. Extract the full repair zip into your BloodPact folder, then run FIX-BLOODPACT.bat again."
}

$jarTargets = @(
    (Join-Path $RepairRoot "bundled-mods\$ModJarName"),
    (Join-Path $RepairRoot "launcher\bundled-mods\$ModJarName")
)
foreach ($dest in $jarTargets) {
    $dir = Split-Path $dest
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
    }
    $sourceFull = (Get-Item -LiteralPath $sourceJar).FullName
    $destItem = Get-Item -LiteralPath $dest -ErrorAction SilentlyContinue
    $destFull = if ($destItem) { $destItem.FullName } else { $null }
    if ($destFull -and $sourceFull -eq $destFull) {
        Write-Host "     already installed $dest"
        continue
    }
    Copy-Item -LiteralPath $sourceJar -Destination $dest -Force
    Write-Host "     installed $dest"
}

Write-Step 'Checking launcher config...'
$configPath = Join-Path $RepairRoot 'launcher\config.json'
if (Test-Path $configPath) {
    $config = Get-Content $configPath -Raw | ConvertFrom-Json
    if ($config.minecraftDir -and ($config.minecraftDir -match '\.zip(\\|/)')) {
        $fixed = [ordered]@{}
        foreach ($prop in $config.PSObject.Properties) {
            if ($prop.Name -eq 'minecraftDir') { continue }
            $fixed[$prop.Name] = $prop.Value
        }
        $fixed['portableMode'] = $true
        $fixed | ConvertTo-Json -Depth 20 | Set-Content -Path $configPath -Encoding UTF8
        Write-Host '     fixed minecraftDir (was pointing inside a zip)'
    }
}

Write-Step 'Repairing launcher (Electron / npm)...'
& (Join-Path $PSScriptRoot 'repair-launcher.ps1') -RepairRoot $RepairRoot

$marker = Join-Path $RepairRoot '.bloodpact-repaired'
Set-Content -Path $marker -Value (Get-Date).ToUniversalTime().ToString('o') -Encoding UTF8

Write-Host ''
Write-Host '  Repair finished. You can click Play in the launcher.'
Write-Host ''
