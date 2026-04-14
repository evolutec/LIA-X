# ==================== PRO IPEX-LLM · WSL2 Ubuntu · Intel Arc 140V ====================
# Stack déployée :
#   1. Ollama IPEX-LLM  → WSL2 Ubuntu-24.04  (GPU Arc via Level-Zero/DXCore)
#   2. AnythingLLM      → Docker  port 3001   (chat RAG)
#   3. Model Manager    → Docker  port 3002   (gestion modèles, même container)
#   4. Open WebUI       → Docker  port 3003   (UI Ollama alternative)
# ======================================================================================

$ErrorActionPreference = "Stop"

# ── Config ─────────────────────────────────────────────────────────────────────────────
$releaseTag       = "v2.3.0-nightly"
$defaultTarName   = "ollama-ipex-llm-2.3.0b20250725-ubuntu.tgz"
$tarUrl           = "https://github.com/ipex-llm/ipex-llm/releases/download/$releaseTag/$defaultTarName"
$ollamaUrl        = "http://host.docker.internal:11434"
$anythingllmImage = "anythingllm-ipex-custom:latest"
$owuImage         = "ghcr.io/open-webui/open-webui:main"

# ── Helpers ────────────────────────────────────────────────────────────────────────────
function Confirm-Command([string]$cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

function Step([string]$n, [string]$msg) {
    Write-Host "`n── [$n] $msg " -ForegroundColor Cyan
}

function OK([string]$msg)   { Write-Host "  ✅ $msg" -ForegroundColor Green }
function WARN([string]$msg) { Write-Host "  ⚠️  $msg" -ForegroundColor Yellow }
function FAIL([string]$msg) { Write-Host "  ❌ $msg" -ForegroundColor Red; exit 1 }
function INFO([string]$msg) { Write-Host "  ℹ️  $msg" -ForegroundColor DarkCyan }

function Open-Tabs([string[]]$urls) {
    $chromePaths = @(
        "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
    )
    $chrome = $chromePaths | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($chrome) {
        # Chrome : premier URL → nouvel onglet, les suivants s'ajoutent automatiquement
        Start-Process $chrome ($urls -join " ")
    } else {
        $urls | ForEach-Object { Start-Process $_ }
    }
}

function Test-OllamaLocal {
    try {
        Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/tags' -TimeoutSec 4 -UseBasicParsing -ErrorAction Stop | Out-Null
        return $true
    } catch { return $false }
}

function Wait-Ollama([int]$maxTries = 24, [int]$delay = 5) {
    for ($i = 1; $i -le $maxTries; $i++) {
        if (Test-OllamaLocal) { return $true }
        Write-Host "  ⏳ Tentative $i/$maxTries..." -ForegroundColor DarkGray
        if ($i -eq 8) {
            Write-Host "  📋 Logs Ollama :" -ForegroundColor Yellow
            wsl -d Ubuntu-24.04 -- bash -c 'tail -8 ~/ollama-ipex/serve.log 2>/dev/null || echo "(aucun log)"'
        }
        Start-Sleep $delay
    }
    return $false
}

# ── 0. Asset GitHub ─────────────────────────────────────────────────────────────────
try {
    $apiUrl  = "https://api.github.com/repos/ipex-llm/ipex-llm/releases/tags/$releaseTag"
    $release = Invoke-RestMethod -Uri $apiUrl -Headers @{ 'User-Agent' = 'PowerShell' } -UseBasicParsing
    $asset   = $release.assets |
               Where-Object { $_.name -match '^ollama-ipex-llm-.*-ubuntu\.tgz$' } |
               Sort-Object created_at | Select-Object -Last 1
    if ($asset) {
        $tarUrl         = $asset.browser_download_url
        $defaultTarName = $asset.name
        INFO "Asset Ollama Linux : $defaultTarName"
    }
} catch { WARN "GitHub API indisponible → URL de secours utilisée." }

# ── 1. WSL2 + Ubuntu-24.04 ───────────────────────────────────────────────────────────
Step "1/7" "WSL2 + Ubuntu-24.04"

if (-not (Confirm-Command 'wsl.exe')) {
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin) { FAIL "WSL2 introuvable. Relance ce script en tant qu'Administrateur pour l'install automatique." }
    Write-Host "  📥 Activation WSL2 + installation Ubuntu-24.04..." -ForegroundColor Cyan
    wsl --install -d Ubuntu-24.04
    FAIL "REDÉMARRAGE REQUIS. Relance ce script après le reboot."
}

$distros = (wsl --list --quiet 2>&1) | ForEach-Object { ($_ -replace '\x00','').Trim() } | Where-Object { $_ }
if (-not ($distros -contains 'Ubuntu-24.04')) {
    Write-Host "  📥 Installation Ubuntu-24.04..." -ForegroundColor Cyan
    wsl --install --no-launch -d Ubuntu-24.04
    if ($LASTEXITCODE -ne 0) { FAIL "Échec installation Ubuntu-24.04. Essaie : wsl --install -d Ubuntu-24.04" }
    wsl --terminate Ubuntu-24.04 2>$null
    $elapsed = 0
    do {
        Start-Sleep 5; $elapsed += 5
        $r = (wsl -d Ubuntu-24.04 -u root -- echo ready 2>$null) -join ''
    } while ($r -notmatch 'ready' -and $elapsed -lt 120)
    if ($elapsed -ge 120) { FAIL "Ubuntu-24.04 ne répond pas. Lance 'wsl -d Ubuntu-24.04' manuellement." }
    OK "Ubuntu-24.04 installée et opérationnelle."
} else {
    OK "WSL2 Ubuntu-24.04 disponible."
}

# ── 2. .wslconfig ────────────────────────────────────────────────────────────────────
Step "2/7" ".wslconfig (networkingMode=mirrored + hostAddressLoopback)"

$wslConfigPath    = "$env:USERPROFILE\.wslconfig"
$wslConfigContent = (Get-Content $wslConfigPath -Raw -ErrorAction SilentlyContinue) -as [string]
if (-not $wslConfigContent) { $wslConfigContent = "" }

$needsMirrored = $wslConfigContent -notmatch 'networkingMode\s*=\s*mirrored'
$needsLoopback  = $wslConfigContent -notmatch 'hostAddressLoopback\s*=\s*true'

if ($needsMirrored -or $needsLoopback) {
    Write-Host "  🔧 Mise à jour de $wslConfigPath..." -ForegroundColor Yellow
    if ($wslConfigContent -notmatch '\[experimental\]') { $wslConfigContent += "`n[experimental]`n" }
    if ($needsMirrored) { $wslConfigContent = $wslConfigContent -replace '(\[experimental\][^\[]*)', "`$1networkingMode=mirrored`n" }
    if ($needsLoopback)  { $wslConfigContent = $wslConfigContent -replace '(\[experimental\][^\[]*)', "`$1hostAddressLoopback=true`n" }
    Set-Content -Path $wslConfigPath -Value $wslConfigContent -Encoding UTF8
    Write-Host "`n  ⚠️  .wslconfig modifié → REDÉMARRAGE REQUIS" -ForegroundColor Red
    Write-Host "       1) Ferme et relance Docker Desktop" -ForegroundColor Yellow
    Write-Host "       2) Relance ce script" -ForegroundColor Yellow
    exit 0
}
OK ".wslconfig OK"

# ── 3. Docker ────────────────────────────────────────────────────────────────────────
Step "3/7" "Docker Desktop"

if (-not (Confirm-Command 'docker')) {
    Write-Host "  📥 Installation Docker Desktop via winget..." -ForegroundColor Cyan
    winget install --id Docker.DockerDesktop -e --silent --accept-source-agreements --accept-package-agreements
    FAIL "Docker installé. Redémarre Windows puis relance ce script."
}
try { docker info 2>&1 | Out-Null; if ($LASTEXITCODE -ne 0) { throw } }
catch { FAIL "Docker Desktop n'est pas démarré. Lance Docker Desktop puis réessaie." }
OK "Docker opérationnel."

# ── 4. Ollama IPEX dans WSL2 ─────────────────────────────────────────────────────────
Step "4/7" "Ollama IPEX-LLM (GPU Arc 140V)"

# Vérifier si Ollama répond déjà
$ollamaAlive = Test-OllamaLocal
if ($ollamaAlive) { INFO "Ollama déjà actif → réutilisation sans redémarrage." }

# Installer le binaire si absent
$wslCheck = (wsl -d Ubuntu-24.04 -- bash -c 'test -f ~/ollama-ipex/ollama && echo exists || echo missing') -join ''
if ($wslCheck -match 'missing') {
    Write-Host "  📥 Téléchargement Ollama IPEX dans WSL2..." -ForegroundColor Cyan
    $r = wsl -d Ubuntu-24.04 -- bash -c "mkdir -p ~/ollama-ipex && curl -sL '$tarUrl' | tar -xz --strip-components=1 -C ~/ollama-ipex && chmod +x ~/ollama-ipex/ollama ~/ollama-ipex/ollama-bin 2>/dev/null; echo DONE"
    if ($r -notmatch 'DONE') { FAIL "Échec installation Ollama dans WSL2. Vérifie la connexion internet." }
    OK "Ollama IPEX-LLM installé dans ~/ollama-ipex/"
    $ollamaAlive = $false
} else {
    OK "Ollama IPEX-LLM présent dans WSL2."
}

# Écrire le script de démarrage (mis à jour à chaque fois pour intégrer les nouvelles variables)
$startScript = @'
#!/bin/bash
rm -f ~/ollama-ipex/serve.log
cd ~/ollama-ipex
export OLLAMA_INTEL_GPU=true
export OLLAMA_NUM_GPU=999
export ZES_ENABLE_SYSMAN=1
export SYCL_CACHE_PERSISTENT=1
export ONEAPI_DEVICE_SELECTOR=level_zero:0
export OLLAMA_HOST=0.0.0.0:11434
export OLLAMA_NUM_PARALLEL=2
export OLLAMA_KEEP_ALIVE=60m
export LD_LIBRARY_PATH=$HOME/ollama-ipex:$LD_LIBRARY_PATH
export no_proxy=localhost,127.0.0.1
./ollama serve >> ~/ollama-ipex/serve.log 2>&1
'@
$startScript | wsl -d Ubuntu-24.04 -- bash -c 'tr -d "\r" > ~/ollama-ipex/start-ollama-wsl.sh && chmod +x ~/ollama-ipex/start-ollama-wsl.sh'
$wslHome = (wsl -d Ubuntu-24.04 -- bash -c 'echo $HOME').Trim()

if (-not $ollamaAlive) {
    # Nettoyer les éventuels résidus
    wsl -d Ubuntu-24.04 -- bash -c 'pkill -f "ollama serve" 2>/dev/null; pkill -f ollama-bin 2>/dev/null; sleep 1; true' 2>$null
    Write-Host "  🚀 Démarrage Ollama (GPU Arc via Level-Zero)..." -ForegroundColor Green
    Start-Process "wsl.exe" -ArgumentList @("-d","Ubuntu-24.04","--","bash","$wslHome/ollama-ipex/start-ollama-wsl.sh") -WindowStyle Minimized
    Start-Sleep 8
}

if (-not (Wait-Ollama)) {
    Write-Host "  📋 Logs Ollama complets :" -ForegroundColor Red
    wsl -d Ubuntu-24.04 -- bash -c 'cat ~/ollama-ipex/serve.log 2>/dev/null'
    FAIL "Ollama ne démarre pas. Voir les logs ci-dessus."
}
OK "Ollama répond sur localhost:11434"

# Détecter le modèle disponible (pour auto-config AnythingLLM)
$defaultModel = "qwen2.5:0.5b"
try {
    $models = (Invoke-RestMethod 'http://127.0.0.1:11434/api/tags' -TimeoutSec 5).models
    if ($models -and $models.Count -gt 0) {
        # Préférer un modèle 7B ou moins, sinon prendre le premier
        $preferred = $models | Where-Object { $_.name -notmatch '70b|72b|34b|30b|22b' } | Select-Object -First 1
        $defaultModel = if ($preferred) { $preferred.name } else { $models[0].name }
    }
} catch {}
INFO "Modèle Ollama sélectionné pour AnythingLLM : $defaultModel"

# ── 5. Build + démarrage AnythingLLM + Model Manager ─────────────────────────────────
Step "5/7" "AnythingLLM + Model Manager (ports 3001, 3002)"

docker stop anythingllm 2>$null; docker rm anythingllm 2>$null | Out-Null

Write-Host "  🔨 Build image Docker (cache activé)..." -ForegroundColor DarkCyan
docker build -t $anythingllmImage -f "$PWD\Dockerfile.anythingllm" . 2>&1 |
    Where-Object { $_ -match 'ERROR|error: ' } |
    ForEach-Object { Write-Host "  $_" -ForegroundColor Red }

if ($LASTEXITCODE -ne 0) { FAIL "Échec build image $anythingllmImage. Lance : docker build -f Dockerfile.anythingllm -t $anythingllmImage ." }
OK "Image $anythingllmImage prête."

$anythingllmArgs = @(
    'run', '-d',
    '--name', 'anythingllm',
    '-p', '3001:3001',
    '-p', '3002:3002',
    '--add-host', 'host.docker.internal:host-gateway',
    # Proxy bypass (évite que Docker redirige les appels internes vers un proxy)
    '-e', 'no_proxy=localhost,127.0.0.1,host.docker.internal',
    '-e', 'NO_PROXY=localhost,127.0.0.1,host.docker.internal',
    # Storage
    '-e', 'STORAGE_DIR=/app/server/storage',
    '-v', 'anythingllm-storage:/app/server/storage',
    # ── Auto-configuration LLM Provider → Ollama ──
    '-e', 'LLM_PROVIDER=ollama',
    '-e', "OLLAMA_BASE_PATH=$ollamaUrl",
    '-e', "OLLAMA_MODEL_PREF=$defaultModel",
    '-e', 'OLLAMA_MODEL_TOKEN_LIMIT=4096',
    '-e', 'EMBEDDING_ENGINE=native',
    # Model Manager bridge
    '-e', "OLLAMA_HOST=$ollamaUrl",
    $anythingllmImage
)
docker @anythingllmArgs | Out-Null
if ($LASTEXITCODE -ne 0) { FAIL "Impossible de démarrer le container AnythingLLM." }
OK "Container AnythingLLM démarré."

# ── 6. OpenWebUI ─────────────────────────────────────────────────────────────────────
Step "6/7" "Open WebUI (port 3003)"

docker stop open-webui 2>$null; docker rm open-webui 2>$null | Out-Null

$owuExists = ($null -ne (docker images -q $owuImage 2>$null) -and (docker images -q $owuImage 2>$null) -ne "")
if (-not $owuExists) {
    Write-Host "  📥 Téléchargement image Open WebUI (1ère fois — peut prendre quelques minutes)..." -ForegroundColor Yellow
    docker pull $owuImage 2>&1 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    $owuExists = ($LASTEXITCODE -eq 0)
    if (-not $owuExists) { WARN "Impossible de télécharger Open WebUI — cette interface sera ignorée." }
}

$owuRunning = $false
if ($owuExists) {
    $owuArgs = @(
        'run', '-d',
        '--name', 'open-webui',
        '-p', '3003:8080',
        '--add-host', 'host.docker.internal:host-gateway',
        # Connexion automatique à Ollama
        '-e', "OLLAMA_BASE_URL=$ollamaUrl",
        # Auth désactivée (usage local)
        '-e', 'WEBUI_AUTH=False',
        '-e', 'WEBUI_SECRET_KEY=local-dev-secret',
        # Proxy bypass
        '-e', 'no_proxy=localhost,127.0.0.1,host.docker.internal',
        '-e', 'NO_PROXY=localhost,127.0.0.1,host.docker.internal',
        # Persistence
        '-v', 'open-webui-data:/app/backend/data',
        $owuImage
    )
    docker @owuArgs | Out-Null
    $owuRunning = ($LASTEXITCODE -eq 0)
    if ($owuRunning) { OK "Container Open WebUI démarré (port 3003)." }
    else             { WARN "Échec démarrage Open WebUI — les autres services restent disponibles." }
}

# ── 7. Vérification connectivité + ouverture Chrome ─────────────────────────────────
Step "7/7" "Vérification connectivité + ouverture navigateur"

Write-Host "  ⌛ Attente initialisation des containers (12s)..." -ForegroundColor DarkGray
Start-Sleep 12

# Test : AnythingLLM → Ollama
$connOk = $false
try {
    $res = docker exec anythingllm node -e "fetch('$ollamaUrl/api/tags').then(r=>r.json()).then(d=>{console.log(d.models?.length+' models');process.exit(0)}).catch(e=>{console.error(e.message);process.exit(1)})" 2>&1
    if ($LASTEXITCODE -eq 0) { OK "AnythingLLM → Ollama : OK ($res)"; $connOk = $true }
    else { WARN "AnythingLLM ne joint pas encore Ollama ($res). Ça peut fonctionner quand même — vérifie dans l'UI." }
} catch { WARN "Test connectivité container impossible." }

# Ouvrir Chrome avec les onglets
$tabs = @("http://localhost:3001", "http://localhost:3002")
if ($owuRunning) { $tabs += "http://localhost:3003" }
Start-Sleep 2
Open-Tabs $tabs

# ── Récapitulatif ────────────────────────────────────────────────────────────────────
$sep = "═" * 64
Write-Host "`n  $sep" -ForegroundColor Cyan
Write-Host "  ✅  STACK PRÊTE" -ForegroundColor Green
Write-Host "  $sep" -ForegroundColor Cyan
Write-Host "  💬  AnythingLLM   → http://localhost:3001" -ForegroundColor White
Write-Host "  ⚡  Model Manager → http://localhost:3002" -ForegroundColor White
if ($owuRunning) {
Write-Host "  🌐  Open WebUI    → http://localhost:3003" -ForegroundColor White
}
Write-Host ""
Write-Host "  🤖  LLM auto-configuré : Ollama → $defaultModel" -ForegroundColor DarkCyan
Write-Host "  🎮  GPU : Intel Arc 140V via Level-Zero/DXCore (WSL2)" -ForegroundColor Magenta
Write-Host ""
Write-Host "  📋  Commandes utiles :" -ForegroundColor Cyan
Write-Host "       Logs Ollama  : wsl -d Ubuntu-24.04 -- bash -c 'tail -f ~/ollama-ipex/serve.log'" -ForegroundColor Gray
Write-Host "       Logs docker  : docker logs -f anythingllm" -ForegroundColor Gray
Write-Host "       Arrêt        : docker stop anythingllm open-webui; wsl -d Ubuntu-24.04 -- bash -c 'pkill -f ollama'" -ForegroundColor Gray
Write-Host "       Redémarrage  : .\pro-ipex.ps1" -ForegroundColor Gray
Write-Host "  $sep" -ForegroundColor Cyan
