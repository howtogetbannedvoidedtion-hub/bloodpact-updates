# Shared path helpers for BloodPact repair/launcher scripts.
function Normalize-BloodpactRoot {
    param(
        [string]$Root = ''
    )

    if (-not $Root) {
        $Root = Split-Path -Parent $PSScriptRoot
    }

    $Root = $Root.Trim().Trim('"').TrimEnd('\', '/')
    if (-not $Root) {
        throw 'BloodPact folder path is empty.'
    }

    if (-not (Test-Path -LiteralPath $Root)) {
        throw "BloodPact folder not found:`n  $Root"
    }

    return (Get-Item -LiteralPath $Root).FullName
}

function Test-BloodpactLayout {
    param(
        [string]$Root
    )

    $launcherBootstrap = Join-Path $Root 'launcher\bootstrap.js'
    $openBat = Join-Path $Root '2-Open-BloodPact.bat'
    if (-not (Test-Path -LiteralPath $launcherBootstrap)) {
        throw @"
This folder is missing launcher\bootstrap.js:
  $Root

Copy the repair zip INTO your BloodPact folder (overwrite), or extract BloodPact-For-Friend.zip to Desktop first.
"@
    }

    $leaf = Split-Path $Root -Leaf
    $parentDir = Split-Path $Root -Parent
    $parentLeaf = Split-Path $parentDir -Leaf
    if ($leaf -eq 'BloodPact-For-Friend' -and $parentLeaf -like 'BloodPact-For-Friend*') {
        throw @"
Your BloodPact folder is nested one level too deep:
  $Root

Fix:
  1. Open: $parentDir
  2. Select everything INSIDE the inner BloodPact-For-Friend folder
  3. Move it UP into: $parentDir
  4. Delete the now-empty inner BloodPact-For-Friend folder
  5. Run FIX-BLOODPACT.bat from: $parentDir
"@
    }

    if ($Root -match '\.zip(\\|/)') {
        throw 'You are still inside a zip file. Right-click -> Extract All, then run FIX-BLOODPACT.bat from the extracted folder.'
    }

    $repairSubfolder = Join-Path $Root 'BloodPact-Repair'
    if (Test-Path -LiteralPath (Join-Path $repairSubfolder 'FIX-BLOODPACT.bat')) {
        throw @"
You extracted BloodPact-Repair.zip INSIDE your BloodPact folder as a subfolder:
  $repairSubfolder

Fix:
  1. Open: $repairSubfolder
  2. Select ALL files inside (launcher, tools, bundled-mods, FIX-BLOODPACT.bat)
  3. Cut/paste them UP into: $Root
  4. Delete the empty BloodPact-Repair folder
  5. Run FIX-BLOODPACT.bat from: $Root
"@
    }
}
