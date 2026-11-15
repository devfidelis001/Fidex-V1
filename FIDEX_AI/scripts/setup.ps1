# FIDEX AI - Phase 1, Step 1: environment setup (Windows PowerShell)
# Safe to re-run. Never deletes or overwrites existing files.
# Usage (from the project folder):  powershell -ExecutionPolicy Bypass -File scripts\setup.ps1

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
Write-Host "FIDEX AI setup in: $root" -ForegroundColor Cyan

function Has($cmd) { return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

# 1. Node.js + npm
if (-not (Has "node") -or -not (Has "npm")) {
    if (Has "winget") {
        Write-Host "Node.js missing - installing LTS with winget..." -ForegroundColor Yellow
        winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
    }
}
if (-not (Has "node")) { throw "Node.js is not available. Install Node.js LTS from https://nodejs.org then re-run." }
Write-Host ("Node " + (node --version) + " / npm " + (npm --version))

# 2. Python
$py = $null
if (Has "py") { $py = "py -3" } elseif (Has "python") { $py = "python" }
if (-not $py -and (Has "winget")) {
    Write-Host "Python missing - installing with winget..." -ForegroundColor Yellow
    winget install -e --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
    if (Has "py") { $py = "py -3" } elseif (Has "python") { $py = "python" }
}
if (-not $py) { throw "Python is not available. Install Python 3.10+ from https://python.org (tick 'Add to PATH') then re-run." }
Invoke-Expression "$py --version"

# 3. Folder structure (only creates what is missing)
$dirs = "src\main","src\preload","src\renderer\assets","backend\app","backend\tests","data\db","data\logs","docs","scripts","assets\icons","config","tests"
foreach ($d in $dirs) { New-Item -ItemType Directory -Force -Path (Join-Path $root $d) | Out-Null }

# 4. Node dependencies (Electron only)
if (-not (Test-Path (Join-Path $root "node_modules\electron"))) {
    npm install --save-dev electron
} else { Write-Host "Electron already installed." }

# 5. Python virtual environment
$venv = Join-Path $root "backend\.venv"
if (-not (Test-Path $venv)) { Invoke-Expression "$py -m venv `"$venv`"" } else { Write-Host "Virtual environment already exists." }
$venvPy = Join-Path $venv "Scripts\python.exe"
& $venvPy -m pip install --upgrade pip
if ((Get-Content backend\requirements.txt | Where-Object { $_ -and -not $_.StartsWith("#") }).Count -gt 0) {
    & $venvPy -m pip install -r backend\requirements.txt
}

# 6. Verify
Write-Host "`n--- Verification ---" -ForegroundColor Cyan
& $venvPy scripts\verify_env.py
node scripts\verify-env.js
if ($LASTEXITCODE -eq 0) { Write-Host "`nPhase 1, Step 1 foundation is ready." -ForegroundColor Green }
else { Write-Host "`nSome checks failed - see above." -ForegroundColor Red }
