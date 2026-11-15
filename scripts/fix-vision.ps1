# Installs ONLY the missing screen-capture packages into FIDEX's own backend\.venv (nothing is reinstalled or duplicated).
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$py = Join-Path $root "backend\.venv\Scripts\python.exe"
if (-not (Test-Path $py)) { Write-Host "backend\.venv not found at $py" -ForegroundColor Red; exit 1 }
Write-Host "Using $py"
$check = @'
import importlib.util as u
m = {"numpy": "numpy", "PIL": "pillow", "cv2": "opencv-python-headless", "dxcam": "dxcam", "comtypes": "comtypes"}
print(" ".join(p for k, p in m.items() if u.find_spec(k) is None))
'@
$missing = (& $py -I -c $check).Trim()
if ($missing) {
  Write-Host "Missing: $missing"
  & $py -m pip install --disable-pip-version-check $missing.Split(" ")
} else { Write-Host "All screen-capture packages are already installed." }
& $py -I -c "import cv2, numpy, PIL, dxcam, comtypes; print('Vision packages OK: cv2', cv2.__version__, '| numpy', numpy.__version__, '| Pillow', PIL.__version__)"
if ($LASTEXITCODE -ne 0) { Write-Host "Some package still fails to import (see the message above)." -ForegroundColor Red; exit 1 }
