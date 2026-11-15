# powershell -ExecutionPolicy Bypass -File build-installer.ps1   (needs Node 18+ and internet for Python/pip only; NO system Python needed; Ollama + Qwen are reused from your PC)
$ErrorActionPreference = "Stop"
$App  = "C:\Users\FIDELIS\Desktop\FIDEX AI V1"
$Site = "C:\Users\FIDELIS\Desktop\FAI"
$Kit  = $PSScriptRoot
Set-Location $App

# Persistent download caches (Electron + electron-builder tools are downloaded ONCE and reused on every run)
$env:ELECTRON_CACHE         = "$env:LOCALAPPDATA\electron\Cache"
$env:ELECTRON_BUILDER_CACHE = "$env:LOCALAPPDATA\electron-builder\Cache"
$env:DEBUG = "electron-builder"      # logs the exact URL of every download to build-log.txt
# The packaging step downloads winCodeSign / nsis / nsis-resources from GitHub releases (electron-builder-binaries).
# A slow/blocked GitHub gives: "Timeout awaiting 'request' for 600000ms". Probe it; fall back to a mirror automatically.
$UseMirror = $false
try { Invoke-WebRequest "https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-2.6.0/winCodeSign-2.6.0.7z" -Method Head -TimeoutSec 20 -UseBasicParsing | Out-Null } catch { $UseMirror = $true }
function Set-Mirror { $env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"; $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"; Write-Host "Using download mirror (GitHub too slow/unreachable)" }
if ($UseMirror) { Set-Mirror }

# 0. Remove stale duplicate startup files from older ZIPs and verify the wiring (fails the build if anything conflicts)
foreach ($f in @("main.js","chat-direct.js","python-bridge.js","bridge.js","responder.js","chat.js","renderer.js","first-run.js","index.html","intro-3d.js","intro-font.js","intro-image.js")) { Remove-Item "$App\$f" -Force -ErrorAction SilentlyContinue }
Remove-Item "$App\backend\src" -Recurse -Force -ErrorAction SilentlyContinue
$mj = Get-Content "$App\src\main\main.js" -Raw
if ($mj -notmatch "ollama-engine" -or $mj -notmatch "brain:status") { throw "src/main/main.js is not the corrected one (needs ollama-engine + brain:status)" }
if ((Get-Content "$App\src\main\ollama-engine.js" -Raw) -notmatch "importModels") { throw "src/main/ollama-engine.js is not the corrected one" }
if ((Get-Content "$App\src\preload\preload.js" -Raw) -notmatch "brainStatus") { throw "src/preload/preload.js is missing brainStatus" }
if ((Get-Content "$App\backend\app\ai.py" -Raw) -notmatch "127.0.0.1:11435") { throw "backend/app/ai.py still points to the wrong Ollama port" }

# Optional speed benchmark after install: node "$App\tools\bench-brain.js"
# 1. Clean dev junk
Remove-Item -Recurse -Force .git, tests, "backend\tests", "backend\.venv", "node_modules\.cache" -ErrorAction SilentlyContinue
# only scan app sources (never node_modules / build-res / dist: that is what made earlier runs slow)
$Scan = @("src","backend","assets","scripts") | Where-Object { Test-Path $_ }
Get-ChildItem $Scan -Recurse -Include __pycache__ -Directory -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Get-ChildItem $Scan -Recurse -Include *.db,*.sqlite,*.log,*.backup,*-backup,*.previous -File -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force build-res\ollama, build-res\models, build-res\python | Out-Null

# 2. Python 3.11 Embeddable -> build-res\python (shipped to resources\python)
$Py = "$App\build-res\python\python.exe"
$PyCheck = "import pyautogui,PIL,numpy,cv2,dxcam,comtypes,uiautomation,sqlite3,ctypes"
$pyReady = $false
if (Test-Path $Py) { try { & $Py -c $PyCheck 2>&1 | Out-Null; $pyReady = ($LASTEXITCODE -eq 0) } catch { $pyReady = $false } }
if ($pyReady) { Write-Host "Embedded Python already built and verified - skipping" } else {
$PyVer = "3.11.9"
Invoke-WebRequest "https://www.python.org/ftp/python/$PyVer/python-$PyVer-embed-amd64.zip" -OutFile build-res\py.zip
Expand-Archive build-res\py.zip build-res\python -Force; Remove-Item build-res\py.zip
# enable site-packages + let `-m app.main` import the backend (embeddable ignores cwd). Paths are relative to the _pth file:
# ..\..\backend = FIDEX AI V1\backend from build-res\python; ..\backend = resources\backend in the installed app
@("python311.zip", ".", "Lib\site-packages", "..\..\backend", "..\backend", "import site") | Set-Content build-res\python\python311._pth -Encoding ASCII
Invoke-WebRequest https://bootstrap.pypa.io/get-pip.py -OutFile build-res\get-pip.py
& $Py build-res\get-pip.py --no-warn-script-location
# setuptools+wheel are needed to build source-only packages (PyAutoGUI, pymsgbox, pytweening, ...); isolated builds do not work in embeddable Python
& $Py -m pip install --no-warn-script-location setuptools wheel
if ($LASTEXITCODE -ne 0) { throw "setuptools/wheel install failed" }
# wheels preferred (numpy, opencv, pillow...); sdists allowed and built in-place for the rest
& $Py -m pip install --no-warn-script-location --prefer-binary --no-build-isolation -r "$Kit\requirements-bundle.txt"
if ($LASTEXITCODE -ne 0) { throw "Backend package install failed" }
Remove-Item build-res\get-pip.py
# verify every backend dependency loads from the embedded Python
& $Py -c "import pyautogui,PIL,numpy,cv2,dxcam,comtypes,uiautomation,sqlite3,ctypes;print('PY DEPS OK')"
if ($LASTEXITCODE -ne 0) { throw "Embedded Python dependency check failed" }
}

# 3. Reuse existing Ollama + qwen3.5:4b (NO download / pull)
# Models: same location the app uses (FIDEX_MODELS_DIR, else <app>\models). Ollama: inside the app folder if present,
# else the locations ollama-engine.js itself checks (OLLAMA_EXE, %LOCALAPPDATA%\Programs\Ollama, Program Files).
$ModelsSrc = if ($env:FIDEX_MODELS_DIR) { $env:FIDEX_MODELS_DIR } else { Join-Path $App "models" }
$Manifest  = Join-Path $ModelsSrc "manifests\registry.ollama.ai\library\qwen3.5\4b"
if (-not (Test-Path $Manifest)) { throw "qwen3.5:4b not found. Expected manifest: $Manifest  (set FIDEX_MODELS_DIR to the real models folder)" }
if (-not (Test-Path (Join-Path $ModelsSrc "blobs"))) { throw "No blobs folder in $ModelsSrc" }

$OllamaExe = $null
$inApp = Get-ChildItem $App -Directory | Where-Object { $_.Name -notin @("node_modules","build-res","dist",".git") } |
  ForEach-Object { Get-ChildItem $_.FullName -Recurse -Filter ollama.exe -File -ErrorAction SilentlyContinue } | Select-Object -First 1
if ($inApp) { $OllamaExe = $inApp.FullName }
else {
  foreach ($c in @($env:OLLAMA_EXE, "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe", "C:\Program Files\Ollama\ollama.exe")) {
    if ($c -and (Test-Path $c)) { $OllamaExe = $c; break }
  }
}
if (-not $OllamaExe) { throw "ollama.exe not found in $App or the standard install locations. Set OLLAMA_EXE." }
Write-Host "Ollama: $OllamaExe"; Write-Host "Models: $ModelsSrc"
# --- Size budget. ROOT CAUSE of "installer may be incomplete": NSIS (makensis) cannot embed more than 2 GB.
# The app archive was 5,264,622,993 bytes; 5,264,622,993 - 2^32 = 969.7 MB = the 970 MB installer produced (32-bit overflow).
# So the payload is trimmed/de-duplicated, and the model (uncompressible, >2 GB limit on its own) is shipped as a separate model pack if it would not fit.
function SizeMB($p) { [math]::Round(((Get-ChildItem $p -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum) / 1MB) }
$m = Get-Content $Manifest -Raw | ConvertFrom-Json
$digests = @($m.config.digest) + @($m.layers | ForEach-Object { $_.digest })
$ModelBytes = 0
foreach ($d in $digests) { $b = Join-Path $ModelsSrc ("blobs\" + ($d -replace ":", "-")); if (-not (Test-Path $b)) { throw "Missing model blob: $b" }; $ModelBytes += (Get-Item $b).Length }
$ModelMB = [math]::Round($ModelBytes / 1MB)
$BundleModel = ($ModelBytes -lt 1.2GB)   # model + everything else must stay well under NSIS's 2 GB limit
$ModelStage  = if ($BundleModel) { "$App\build-res\models" } else { "$App\build-res\model-pack" }
Write-Host "Model qwen3.5:4b = $ModelMB MB -> " -NoNewline; Write-Host $(if ($BundleModel) { "bundled in installer" } else { "too big for NSIS (2 GB): shipped as separate model pack" })

# Ollama: copy folder, then drop GPU runtimes that are not needed (keep CPU + cuda_v12). Big saver; GPU still works on NVIDIA.
robocopy (Split-Path $OllamaExe) "$App\build-res\ollama" /MIR /XD rocm vulkan cuda_v13 cuda_v11 /NFL /NDL /NJH /NJS | Out-Null   # incremental: unchanged files are skipped
if ($LASTEXITCODE -ge 8) { throw "Copying Ollama failed" }
$lib = "$App\build-res\ollama\lib\ollama"
if (Test-Path $lib) {
  Get-ChildItem $lib -Directory | ForEach-Object { Write-Host ("  ollama runtime {0}: {1} MB" -f $_.Name, (SizeMB $_.FullName)) }
  Get-ChildItem $lib -Directory | Where-Object { $_.Name -match "^(rocm|vulkan|cuda_v13|cuda_v11)" } | ForEach-Object { Remove-Item $_.FullName -Recurse -Force }
}
Get-ChildItem "$App\build-res\ollama" -Recurse -Include *.log,*.pdb -File | Remove-Item -Force -ErrorAction SilentlyContinue

# Model (only qwen3.5:4b manifest + its blobs)
New-Item -ItemType Directory -Force "$ModelStage\blobs" | Out-Null
Copy-Item (Join-Path $ModelsSrc "manifests") "$ModelStage\manifests" -Recurse -Force
Get-ChildItem "$ModelStage\manifests" -Recurse -File | Where-Object { $_.FullName -notlike "*\qwen3.5\4b" } | Remove-Item -Force
foreach ($d in $digests) {
  $n = $d -replace ":", "-"; $src = Join-Path $ModelsSrc "blobs\$n"; $dst = "$ModelStage\blobs\$n"
  if (-not ((Test-Path $dst) -and ((Get-Item $dst).Length -eq (Get-Item $src).Length))) { Copy-Item $src $dst -Force } }   # unchanged blobs are not recopied
if (-not $BundleModel) {
  New-Item -ItemType Directory -Force "$Site\downloads" | Out-Null
  $pack = "$Site\downloads\FIDEX-SI-Model-qwen3.5-4b.zip"
  $stamp = "$pack.stamp"; $want = ($digests -join ",")
  if ((Test-Path $pack) -and (Test-Path $stamp) -and ((Get-Content $stamp -Raw).Trim() -eq $want)) { Write-Host "Model pack unchanged - skipping zip" } else {
    Remove-Item $pack -Force -ErrorAction SilentlyContinue
    tar -a -c -f $pack -C $ModelStage manifests blobs     # bsdtar zip64 (Compress-Archive fails above 2 GB)
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $pack)) { throw "Model pack zip failed" }
    Set-Content $stamp $want
  }
  Write-Host "Model pack: $pack"
}

# Payload report + hard budget (NOT disabling electron-builder's check)
$Parts = @{ python = (SizeMB "$App\build-res\python"); ollama = (SizeMB "$App\build-res\ollama"); model_in_installer = $(if ($BundleModel) { SizeMB "$App\build-res\models" } else { 0 }); backend = (SizeMB "$App\backend"); whisper = (SizeMB "$App\assets\whisper"); tts = (SizeMB "$App\assets\tts"); src = (SizeMB "$App\src") }
$Parts.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object { Write-Host ("  payload {0,-20} {1,7} MB" -f $_.Key, $_.Value) }
$PayloadMB = ($Parts.Values | Measure-Object -Sum).Sum
Write-Host "Payload total (uncompressed): $PayloadMB MB"
if ($PayloadMB -gt 3800) { throw "Payload $PayloadMB MB is too large; compressed it would exceed NSIS's 2 GB limit. Check the list above for the largest parts." }

# 4. package.json for installer
$p = Get-Content package.json -Raw | ConvertFrom-Json
$p.version = "1.0.0"
$b = $p.build
$b.productName = "FIDEX SI"
$b.win = @{ icon="assets/icons/icon.ico"; target=@("nsis") }
# Fixed exe name (no space) so shortcuts always target the real app exe; shortcuts named "FIDEX SI"
Add-Member -InputObject $b -MemberType NoteProperty -Name executableName -Value "FIDEXSI" -Force
Add-Member -InputObject $b -MemberType NoteProperty -Name nsis -Force -Value ([pscustomobject]@{
  oneClick=$false; perMachine=$false; allowElevation=$true; allowToChangeInstallationDirectory=$true;
  createDesktopShortcut="always"; createStartMenuShortcut=$true; shortcutName="FIDEX SI"; menuCategory=$false;
  installerIcon="assets/icons/icon.ico"; uninstallerIcon="assets/icons/icon.ico"; installerHeaderIcon="assets/icons/icon.ico";
  uninstallDisplayName="FIDEX SI"; runAfterFinish=$true; deleteAppDataOnUninstall=$false;
  artifactName="FIDEX-SI-Setup-V1.exe" })
$b.files = @("src/**/*","assets/**/*","package.json","!assets/whisper/**","!**/*.backup","!**/*-backup")   # whisper ships once, via extraResources
$b.extraResources = @(
  @{ from="backend"; to="backend"; filter=@("**/*","!tests/**","!**/__pycache__/**","!**/*.db","!**/*backup*","!.venv/**") },
  @{ from="assets/whisper"; to="assets/whisper" },
  @{ from="assets/tts"; to="assets/tts" },
  @{ from="build-res/python"; to="python" },
  @{ from="build-res/ollama"; to="ollama" }
)
if ($BundleModel) { $b.extraResources += @{ from="build-res/models"; to="ollama-models-seed" } }
# UTF-8 WITHOUT BOM (electron-builder cannot parse a BOM)
[System.IO.File]::WriteAllText((Join-Path $App "package.json"), ($p | ConvertTo-Json -Depth 20), (New-Object System.Text.UTF8Encoding($false)))

# 5. Build + ship
Remove-Item -Recurse -Force dist -ErrorAction SilentlyContinue
# npm: install only when something is missing (no repeated downloads). electron-builder is installed locally, not fetched by npx each run.
if (-not (Test-Path node_modules\electron\package.json)) { npm install --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { throw "npm install failed" } }
if (-not (Test-Path node_modules\.bin\electron-builder.cmd)) { npm install -D electron-builder --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { throw "electron-builder install failed" } }
$EB = "$App\node_modules\.bin\electron-builder.cmd"
$ebOk = $false
$ErrorActionPreference = "Continue"   # electron-builder writes progress to stderr; do not abort on it
foreach ($try in 1..3) {
  Write-Host "electron-builder attempt $try (cached downloads are reused)"
  & $EB --win nsis 2>&1 | Tee-Object -Variable ebOut | Tee-Object -FilePath "$App\build-log.txt" | ForEach-Object { $_ }
  if ($LASTEXITCODE -eq 0) { $ebOk = $true; break }
  if (($ebOut | Out-String) -match "(?i)Timeout awaiting|ETIMEDOUT|ECONNRESET|download") { if (-not $env:ELECTRON_BUILDER_BINARIES_MIRROR) { Set-Mirror } }
  Start-Sleep 5
}
$ErrorActionPreference = "Stop"
if (-not $ebOk) { throw "electron-builder failed after 3 attempts. The URL that timed out is in $App\build-log.txt (search for http)." }
if (($ebOut | Out-String) -match "(?i)incomplete|size mismatch") { throw "electron-builder reports the installer may be incomplete (NSIS 2 GB limit). Do not ship it." }
# Verify packaged app: real exe present, icon embedded source present, bundled parts present
$U = "dist\win-unpacked"
foreach ($req in @("FIDEXSI.exe","resources\python\python.exe","resources\ollama\ollama.exe","resources\backend\app\main.py")) {
  if (-not (Test-Path "$U\$req")) { throw "Packaged app is missing: $U\$req" }
}
if ($BundleModel -and -not (Test-Path "$U\resources\ollama-models-seed")) { throw "Model seed missing from package" }
# Smoke test of the PACKAGED engine: real ollama.exe from win-unpacked, real port 11435, real model manifest
$env:OLLAMA_HOST = "127.0.0.1:11435"; $env:OLLAMA_MODELS = (Join-Path $env:TEMP "fidex-smoke-models")
New-Item -ItemType Directory -Force $env:OLLAMA_MODELS | Out-Null
if (Test-Path "$App\build-res\models\manifests") { Copy-Item "$App\build-res\models\*" $env:OLLAMA_MODELS -Recurse -Force }
elseif (Test-Path "$ModelStage\manifests") { Copy-Item "$ModelStage\*" $env:OLLAMA_MODELS -Recurse -Force }
$sp = Start-Process "$U\resources\ollama\ollama.exe" -ArgumentList "serve" -WindowStyle Hidden -PassThru
$up = $false; foreach ($i in 1..60) { try { Invoke-RestMethod "http://127.0.0.1:11435/api/version" -TimeoutSec 2 | Out-Null; $up = $true; break } catch { Start-Sleep 1 } }
$tags = $null; if ($up) { $tags = (Invoke-RestMethod "http://127.0.0.1:11435/api/tags").models.name }
Stop-Process -Id $sp.Id -Force -ErrorAction SilentlyContinue
if (-not $up) { throw "SMOKE TEST FAILED: packaged ollama.exe did not listen on 127.0.0.1:11435" }
if (-not ($tags -match "qwen3.5")) { throw "SMOKE TEST FAILED: packaged engine sees no qwen3.5 model (found: $tags)" }
Write-Host "SMOKE TEST OK: engine on 11435, models: $tags"
Write-Host "Shortcut target will be: <install dir>\FIDEXSI.exe"
if (-not (Test-Path dist\FIDEX-SI-Setup-V1.exe)) { throw "dist\FIDEX-SI-Setup-V1.exe was not created" }
if ((Get-Item dist\FIDEX-SI-Setup-V1.exe).Length -ge 2GB) { throw "Installer is >= 2 GB (NSIS limit)" }
New-Item -ItemType Directory -Force "$Site\downloads" | Out-Null
Copy-Item dist\FIDEX-SI-Setup-V1.exe "$Site\downloads\FIDEX-SI-Setup-V1.exe" -Force
(Get-FileHash "$Site\downloads\FIDEX-SI-Setup-V1.exe" -Algorithm SHA256).Hash | Set-Content "$Site\downloads\FIDEX-SI-Setup-V1.sha256.txt"
Write-Host "DONE -> $Site\downloads\FIDEX-SI-Setup-V1.exe"
