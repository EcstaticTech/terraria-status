# Builds TerraMap Web (MIT, github.com/TerraMap/terramap.github.io) into
# public/map/, patched to open the server's live world.
$ErrorActionPreference = "Stop"
$TERRAMAP_COMMIT = "e4b03f4ab8878fa2e9d98668e991090272d6826f"
$HERE = $PSScriptRoot
$targetMapDir = Join-Path $HERE "..\..\public\map"
if (-not (Test-Path $targetMapDir)) {
    New-Item -ItemType Directory -Path $targetMapDir -Force | Out-Null
}
$OUT = (Resolve-Path $targetMapDir).Path

$WORK = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $WORK -Force | Out-Null

try {
    Write-Host "Cloning TerraMap with LF..."
    git -c core.autocrlf=false clone --quiet https://github.com/TerraMap/terramap.github.io "$WORK\terramap"
    Set-Location "$WORK\terramap"
    Write-Host "Checking out commit $TERRAMAP_COMMIT..."
    git -c core.autocrlf=false checkout --quiet $TERRAMAP_COMMIT

    Write-Host "Applying patch..."
    $patchFile = (Resolve-Path "$HERE\serve-our-world.patch").Path
    git apply --ignore-whitespace --ignore-space-change $patchFile

    Write-Host "Running npm ci..."
    cmd.exe /c "npm ci --no-audit --no-fund"

    Write-Host "Building Vite project with BASE_PATH=/map/..."
    $env:BASE_PATH = "/map/"
    cmd.exe /c "npx vite build"

    Write-Host "Cleaning up extraneous files..."
    Remove-Item -Path "dist\resources\*.zip" -Force -ErrorAction SilentlyContinue
    Remove-Item -Path "dist\ads.txt" -Force -ErrorAction SilentlyContinue
    Remove-Item -Path "dist\native.html" -Force -ErrorAction SilentlyContinue
    Remove-Item -Path "dist\windows.html" -Force -ErrorAction SilentlyContinue
    Copy-Item "LICENSE" "dist\LICENSE.txt" -Force

    Write-Host "Copying to $OUT..."
    Remove-Item -Path "$OUT\*" -Recurse -Force -ErrorAction SilentlyContinue
    Copy-Item -Path "dist\*" -Destination $OUT -Recurse -Force
    Write-Host "TerraMap successfully built to $OUT!"
} finally {
    Set-Location $HERE
    Remove-Item -Path $WORK -Recurse -Force -ErrorAction SilentlyContinue
}
