# Downloads portable Node.js + Temurin JDK into tools/runtime/ for offline sharing.
param(
    [switch]$LauncherOnly
)

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RuntimeDir = Join-Path $ScriptDir 'runtime'
$NodeDir = Join-Path $RuntimeDir 'node'
$JavaDir = Join-Path $RuntimeDir 'java'

New-Item -ItemType Directory -Force -Path $RuntimeDir, $NodeDir, $JavaDir | Out-Null

function Write-Status([string]$Message) {
    Write-Host "  $Message"
}

function Find-NodeExe {
    $direct = Join-Path $NodeDir 'node.exe'
    if (Test-Path $direct) { return $direct }

    $nested = Get-ChildItem -Path $NodeDir -Filter 'node.exe' -Recurse -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending |
        Select-Object -First 1
    if ($nested) { return $nested.FullName }
    return $null
}

function Flatten-ExtractedFolder([string]$TargetDir, [string]$Pattern) {
    $folder = Get-ChildItem -Path $TargetDir -Directory -Filter $Pattern -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending |
        Select-Object -First 1
    if (-not $folder) { return }

    Get-ChildItem -Path $folder.FullName | ForEach-Object {
        $dest = Join-Path $TargetDir $_.Name
        if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
        Move-Item $_.FullName $dest
    }
    Remove-Item $folder.FullName -Recurse -Force
}

function Ensure-Node {
    if (Find-NodeExe) {
        Write-Status 'Node.js already bundled.'
        return
    }

    Write-Status 'Downloading portable Node.js (LTS)...'
    $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing
    $lts = $index | Where-Object { $_.lts -ne $false } | Select-Object -First 1
    if (-not $lts) {
        throw 'Could not find Node.js LTS release.'
    }

    $version = $lts.version
    $zipName = "node-$version-win-x64.zip"
    $url = "https://nodejs.org/dist/$version/$zipName"
    $zipPath = Join-Path $RuntimeDir $zipName

    Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing
    Expand-Archive -Path $zipPath -DestinationPath $NodeDir -Force
    Remove-Item $zipPath -Force
    Flatten-ExtractedFolder -TargetDir $NodeDir -Pattern 'node-v*-win-x64'

    if (-not (Find-NodeExe)) {
        throw 'Node.js download finished but node.exe was not found.'
    }
    Write-Status "Node.js $version ready."
}

function Find-BundledJava([int]$Major) {
    $patterns = @("jdk-$Major", "jdk-$Major.*", "jre-$Major*")
    foreach ($pattern in $patterns) {
        $dirs = Get-ChildItem -Path $JavaDir -Directory -Filter $pattern -ErrorAction SilentlyContinue
        foreach ($dir in $dirs) {
            $javaExe = Join-Path $dir.FullName 'bin\java.exe'
            if (Test-Path $javaExe) { return $dir.FullName }
        }
    }

    $nested = Get-ChildItem -Path $JavaDir -Directory -Recurse -ErrorAction SilentlyContinue |
        Where-Object { Test-Path (Join-Path $_.FullName 'bin\java.exe') } |
        Where-Object { $_.Name -match "jdk-$Major|jre-$Major" } |
        Sort-Object FullName -Descending |
        Select-Object -First 1
    if ($nested) { return $nested.FullName }
    return $null
}

function Ensure-Java([int]$Major) {
    $existing = Find-BundledJava -Major $Major
    if ($existing) {
        Write-Status "Java $Major already bundled."
        return
    }

    Write-Status "Downloading portable Java $Major (Temurin)..."
    $apiUrl = "https://api.adoptium.net/v3/assets/latest/$Major/hotspot?architecture=x64&image_type=jdk&os=windows&vendor=eclipse"
    $assets = Invoke-RestMethod -Uri $apiUrl -UseBasicParsing
    $asset = $assets | Select-Object -First 1
    if (-not $asset) {
        throw "Could not find Temurin JDK $Major download."
    }

    $url = $asset.binary.package.link
    $fileName = $asset.binary.package.name
    $zipPath = Join-Path $RuntimeDir $fileName
    $destDir = Join-Path $JavaDir "jdk-$Major"

    Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing
    New-Item -ItemType Directory -Force -Path $destDir | Out-Null
    Expand-Archive -Path $zipPath -DestinationPath $destDir -Force
    Remove-Item $zipPath -Force
    Flatten-ExtractedFolder -TargetDir $destDir -Pattern 'jdk*'

    if (-not (Find-BundledJava -Major $Major)) {
        throw "Java $Major download finished but java.exe was not found."
    }
    Write-Status "Java $Major ready."
}

Write-Host ''
Write-Host '  BloodPact runtime setup'
Write-Host '  ======================='
Write-Host ''

Ensure-Node
if ($LauncherOnly) {
    Write-Host ''
    Write-Host '  Node.js ready for launcher startup.'
    Write-Host '  Java downloads when you click Play (needs internet once).'
    Write-Host ''
    exit 0
}
Ensure-Java -Major 25
Ensure-Java -Major 21

Write-Host ''
Write-Host '  All runtimes ready in tools\runtime\'
Write-Host ''
