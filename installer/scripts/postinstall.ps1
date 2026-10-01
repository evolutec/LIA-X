<#
  LIA-X Post-Install Setup
  Exécuté par Inno Setup après la copie des fichiers.
  Paramètres attendus :
    -InstallDir          : dossier d'installation de LIA-X
    -ModelsDir           : dossier des modèles GGUF
    -ControllerPort      : port du contrôleur (défaut 13579)
    -LlamaPort           : port llama-server par défaut (défaut 12434)
    -LoaderPort          : port du Model Loader (défaut 3005)
    -SkipBuild           : si présent, ne fait pas npm install/build
    -SkipServiceInstall  : si présent, n'installe pas les services Windows
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallDir,

    [Parameter(Mandatory = $true)]
    [string]$ModelsDir,

    [int]$ControllerPort = 13579,
    [int]$LlamaPort = 12434,
    [int]$LoaderPort = 3005,
    [switch]$SkipBuild,
    [switch]$SkipServiceInstall,
    [bool]$InstallLibreChat = $false,
    [bool]$InstallOpenWebUI = $false,
    [bool]$InstallAnythingLLM = $false
)

$ErrorActionPreference = 'Stop'

function Write-Info($msg) {
    Write-Host "==> $msg" -ForegroundColor Cyan
}
function Write-Ok($msg) {
    Write-Host "    OK: $msg" -ForegroundColor Green
}
function Write-Fail($msg) {
    Write-Host "    ERREUR: $msg" -ForegroundColor Red
}

# ------------------------------------------------------------------------------
# 1. Vérifications de base
# ------------------------------------------------------------------------------
if (-not (Test-Path -LiteralPath $InstallDir)) {
    throw "Répertoire d'installation introuvable : $InstallDir"
}

# Emplacement canonique des modèles GGUF : C:\Users\<utilisateur>\Documents\LIA-X\Models
# (identique à l'installateur Inno : {userdocs}\LIA-X\Models).
$canonicalModelsDir = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'LIA-X\Models'
if ([string]::IsNullOrWhiteSpace($ModelsDir)) { $ModelsDir = $canonicalModelsDir }
if ($ModelsDir -like "$InstallDir\*") {
    Write-Warning "Dossier des modèles situé dans le dossier d'installation ($ModelsDir) : utilisation de $canonicalModelsDir."
    $ModelsDir = $canonicalModelsDir
}
$rootDir = $InstallDir
$runtimeDir = Join-Path $rootDir 'runtime'
$modelsTargetDir = $ModelsDir
$logsDir = Join-Path $rootDir 'logs'
$logsControllerDir = Join-Path $logsDir 'controller'
$logsRuntimeDir = Join-Path $logsDir 'runtime'

# Création des dossiers nécessaires
foreach ($dir in @($modelsTargetDir, $logsDir, $logsControllerDir, $logsRuntimeDir)) {
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        Write-Ok "Dossier créé : $dir"
    }
}

# ------------------------------------------------------------------------------
# 2. NSSM
# ------------------------------------------------------------------------------
Write-Info 'Vérification de NSSM...'
$nssm = $null
# Emplacement installe ({app}\tools\nssm, cree par l'ISS), puis emplacement du
# depot pour une execution depuis les sources (installer\nssm\win64\).
$nssmCandidates = @(
    (Join-Path $rootDir 'tools\nssm\nssm.exe'),
    (Join-Path $rootDir 'installer\nssm\win64\nssm.exe')
)
$embeddedNssm = $nssmCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

if ($embeddedNssm) {
    $nssm = $embeddedNssm
    Write-Ok "NSSM embarqué trouvé : $nssm"
}

if (-not $nssm) {
    try {
        $nssm = (Get-Command nssm.exe -ErrorAction Stop).Source
        Write-Ok "NSSM trouvé dans le PATH : $nssm"
    } catch {
        Write-Host '    NSSM introuvable, tentative d''installation via winget...' -ForegroundColor Yellow
        try {
            winget install --id NSSM.NSSM --accept-package-agreements --accept-source-agreements --silent | Out-Null
            $nssm = (Get-Command nssm.exe -ErrorAction Stop).Source
            Write-Ok "NSSM installé : $nssm"
        } catch {
            Write-Fail "Impossible d'installer NSSM automatiquement. Installez-le manuellement puis relancez ce script."
            throw "NSSM requis pour les services Windows."
        }
    }
}

# ------------------------------------------------------------------------------
# 2b. Vérification Docker Desktop
# ------------------------------------------------------------------------------
Write-Info 'Vérification de Docker Desktop...'
$dockerOk = $false
try {
    $null = docker info 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { $dockerOk = $true }
} catch {}

if (-not $dockerOk) {
    Write-Host '    Docker Desktop ne semble pas démarré ou absent.' -ForegroundColor Yellow
    Write-Host '    LIA-X nécessite Docker Desktop pour les interfaces (Open WebUI / AnythingLLM / LibreChat).' -ForegroundColor.Yellow
    Write-Host '    Téléchargement : https://www.docker.com/products/docker-desktop/' -ForegroundColor Cyan
    $response = Read-Host 'Voulez-vous ouvrir la page de téléchargement de Docker Desktop maintenant ? (O/N)'
    if ($response -eq 'O' -or $response -eq 'o') {
        Start-Process 'https://www.docker.com/products/docker-desktop/'
        Write-Host '    Veuillez installer Docker Desktop, puis redémarrer votre ordinateur.' -ForegroundColor.Yellow
        Write-Host '    Après installation, relancez ce script avec l''option -SkipDockerCheck.' -ForegroundColor.Yellow
        throw 'Docker Desktop requis. Installation reportée.'
    }
}

# ------------------------------------------------------------------------------
# ------------------------------------------------------------------------------
# 3. runtime/host-runtime-config.json
# ------------------------------------------------------------------------------
# Le profil doit être calculé par la même source que l'installation PowerShell.
# Ne jamais reconstruire ici un backend/gpu_layers arbitraire : cela ferait
# diverger le .exe et le script sur une machine NVIDIA, AMD, Intel ou CPU-only.
$runtimeConfigPath = Join-Path $runtimeDir 'host-runtime-config.json'
$hardwareProfilePath = Join-Path $runtimeDir 'hardware-profile.json'
$detectHardwareScript = Join-Path $rootDir 'installer\scripts\detect-hardware.ps1'
if (-not (Test-Path -LiteralPath $detectHardwareScript)) {
    # Repli : version anterieure a son deplacement dans installer\scripts\.
    $legacyDetector = Join-Path $rootDir 'detect-hardware.ps1'
    if (Test-Path -LiteralPath $legacyDetector) {
        $detectHardwareScript = $legacyDetector
    } else {
        throw "Détecteur matériel introuvable : $detectHardwareScript"
    }
}

$pwshPath = (Get-Command pwsh.exe -ErrorAction SilentlyContinue).Source
if (-not $pwshPath) { $pwshPath = (Get-Command powershell.exe -ErrorAction Stop).Source }
& $pwshPath -NoProfile -ExecutionPolicy Bypass -File $detectHardwareScript `
    -RootDir $rootDir `
    -ModelsDir $modelsTargetDir `
    -ControllerPort $ControllerPort `
    -LlamaPort $LlamaPort
if ($LASTEXITCODE -ne 0) {
    throw "La détection matérielle et la configuration runtime ont échoué (code $LASTEXITCODE)."
}
if (-not (Test-Path -LiteralPath $runtimeConfigPath)) {
    throw "Le détecteur n'a pas créé la configuration runtime : $runtimeConfigPath"
}
try {
    $runtimeConfig = Get-Content -LiteralPath $runtimeConfigPath -Raw | ConvertFrom-Json
    if (-not $runtimeConfig.backend -or -not $runtimeConfig.binary_path) {
        throw "La configuration runtime détectée est incomplète."
    }
} catch {
    throw "La configuration runtime détectée est invalide : $($_.Exception.Message)"
}
Write-Ok ("Configuration runtime détectée : backend={0}, gpu_layers={1}" -f $runtimeConfig.backend, $runtimeConfig.default_gpu_layers)
Write-Ok "host-runtime-config.json écrit : $runtimeConfigPath"

# ------------------------------------------------------------------------------
# 3b. Validation post-installation (binaire + capacites backend)
# ------------------------------------------------------------------------------
# Le detecteur a deja valide le binaire retenu (llama-server.exe --version).
# On le revalide ici pour detecter toute regression entre la detection et la fin
# de l'installation (antivirus, fichier supprime, droits), et on affiche un
# diagnostic clair des backends disponibles.
Write-Info 'Validation post-installation du runtime...'
$hardwareModule = Join-Path $rootDir 'installer\scripts\hardware.ps1'
if (-not (Test-Path -LiteralPath $hardwareModule)) {
    # Repli : version anterieure a son deplacement dans installer\scripts\.
    $legacyHardwareModule = Join-Path $rootDir 'modules\hardware.ps1'
    if (Test-Path -LiteralPath $legacyHardwareModule) {
        $hardwareModule = $legacyHardwareModule
    }
}
$binaryValidatedOk = $null
if (Test-Path -LiteralPath $hardwareModule) {
    . $hardwareModule
    $binaryCheck = Test-LlamaBinary -BinaryPath $runtimeConfig.binary_path
    $binaryValidatedOk = [bool]$binaryCheck.ok
    if ($binaryCheck.ok) {
        Write-Ok ("Binaire verifie : {0} (version : {1})" -f $runtimeConfig.backend, $(if ($binaryCheck.version) { $binaryCheck.version } else { 'inconnue' }))
    } else {
        Write-Host ("    Binaire NON verifie ({0}) : {1}" -f $runtimeConfig.backend, $binaryCheck.error) -ForegroundColor Red
    }
} else {
    Write-Host ("    hardware.ps1 introuvable, validation binaire ignoree : {0}" -f $hardwareModule) -ForegroundColor Yellow
}

if ($runtimeConfig.capabilities) {
    Write-Info 'Capacites backend detectees :'
    foreach ($capName in @('cuda', 'rocm', 'vulkan', 'cpu')) {
        $cap = $runtimeConfig.capabilities.$capName
        if ($cap) {
            $state = if ($cap.available) { 'disponible  ' } else { 'indisponible' }
            Write-Host ("      {0,-7} : {1} - {2}" -f $capName, $state, $cap.detail)
        }
    }
    if ($runtimeConfig.plan_fallback_reason) {
        Write-Host ("      repli applique : {0}" -f $runtimeConfig.plan_fallback_reason) -ForegroundColor Yellow
    }
}
if ($runtimeConfig.gpu_memory) {
    $GBv = 1024 * 1024 * 1024
    Write-Host ("      memoire GPU : dediee {0:N2} Go / unifiee {1:N2} Go / utilisable {2:N2} Go" -f ($runtimeConfig.gpu_memory.dedicated_bytes / $GBv), ($runtimeConfig.gpu_memory.unified_bytes / $GBv), ($runtimeConfig.gpu_memory.usable_bytes / $GBv))
}

# Le binaire doit au minimum exister : sinon le runtime est inutilisable.
if (-not (Test-Path -LiteralPath $runtimeConfig.binary_path)) {
    throw "Le binaire llama-server.exe est introuvable apres installation : $($runtimeConfig.binary_path)"
}
if ($binaryValidatedOk -eq $false) {
    Write-Host '    Le binaire existe mais ne repond pas a --version : verifiez les DLL du backend.' -ForegroundColor Yellow
}

# ------------------------------------------------------------------------------
# 4. runtime/host-runtime-state.json (vide)
# ------------------------------------------------------------------------------
$runtimeStatePath = Join-Path $runtimeDir 'host-runtime-state.json'
if (-not (Test-Path -LiteralPath $runtimeStatePath)) {
    '{}' | Set-Content -Path $runtimeStatePath -Encoding UTF8
    Write-Ok "host-runtime-state.json initialisé."
}

# ------------------------------------------------------------------------------
# 5. Build du frontend model-manager
# ------------------------------------------------------------------------------
if (-not $SkipBuild) {
    Write-Info 'Build du frontend model-manager...'
    $modelManagerDir = Join-Path $rootDir 'model-manager'
    if (-not (Test-Path -LiteralPath (Join-Path $modelManagerDir 'package.json'))) {
        Write-Fail "package.json introuvable dans $modelManagerDir"
    } else {
        Push-Location -LiteralPath $modelManagerDir
        try {
            # npm ci installe exactement ce que package-lock.json decrit, et
            # echoue si le lock est incoherent avec package.json. C'est le
            # comportement voulu sur une machine vierge : npm install pourrait
            # resoudre une version majeure differente, et decouvrir une
            # incompatibilite (tesseract.js, pdf-parse) au moment ou
            # l'utilisateur a le moins de marge pour la contourner.
            # Repli sur npm install si npm ci n'est pas disponible.
            npm ci --no-audit --no-fund 2>&1 | Out-Null
            if ($LASTEXITCODE -ne 0) {
                Write-Info 'npm ci a échoué, repli sur npm install...'
                npm install --no-audit --no-fund | Out-Null
            }
            $env:VITE_API_BASE_URL = ''
            npm run build | Out-Null
            Write-Ok "Build model-manager terminé."
        } catch {
            Write-Fail "Échec du build model-manager : $($_.Exception.Message)"
        } finally {
            Pop-Location
        }
    }
} else {
    Write-Info 'Build model-manager ignoré (-SkipBuild).'
}

# ------------------------------------------------------------------------------
# 6. Services Windows (NSSM)
# ------------------------------------------------------------------------------
if (-not $SkipServiceInstall) {
    Write-Info 'Installation des services Windows...'

    $controllerScript = Join-Path $rootDir 'services\controller\llama-host-controller.ps1'
    $gpuMetricsScript = Join-Path $rootDir 'services\gpu-metrics\service.ps1'
    $hostLauncherScript = Join-Path $rootDir 'services\host-launcher\host-launcher.ps1'

    # LIA Controller
    if (Test-Path -LiteralPath $controllerScript) {
        $controllerLogDir = Join-Path $logsControllerDir 'lia-controller'
        if (-not (Test-Path -LiteralPath $controllerLogDir)) {
            New-Item -ItemType Directory -Path $controllerLogDir -Force | Out-Null
        }

        $pwsh = if (Get-Command pwsh -ErrorAction SilentlyContinue) { 'pwsh' } else { 'powershell.exe' }
        $nssmArgs = @(
            'install', 'LIA Controller',
            $pwsh,
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $controllerScript,
            '-Port', $ControllerPort,
            '-ConfigPath', $runtimeConfigPath,
            '-StatePath', $runtimeStatePath
        )
        & $nssm @nssmArgs 2>&1 | Out-Null

        & $nssm set 'LIA Controller' DisplayName 'LIA Controller' 2>&1 | Out-Null
        & $nssm set 'LIA Controller' Description 'Service de controle hote LIA' 2>&1 | Out-Null
        & $nssm set 'LIA Controller' AppDirectory $rootDir 2>&1 | Out-Null
        & $nssm set 'LIA Controller' AppStdout (Join-Path $controllerLogDir 'nssm-stdout.log') 2>&1 | Out-Null
        & $nssm set 'LIA Controller' AppStderr (Join-Path $controllerLogDir 'nssm-stderr.log') 2>&1 | Out-Null
        & $nssm set 'LIA Controller' Start SERVICE_DELAYED_AUTO_START 2>&1 | Out-Null

        Write-Ok "Service 'LIA Controller' enregistré (démarrage différé)."
    } else {
        Write-Fail "Script controller introuvable : $controllerScript"
    }

    # LIA GPU Metrics
    if (Test-Path -LiteralPath $gpuMetricsScript) {
        $metricsLogDir = Join-Path $logsDir 'lia-gpu-metrics'
        if (-not (Test-Path -LiteralPath $metricsLogDir)) {
            New-Item -ItemType Directory -Path $metricsLogDir -Force | Out-Null
        }

        $pwsh = if (Get-Command pwsh -ErrorAction SilentlyContinue) { 'pwsh' } else { 'powershell.exe' }
        $nssmArgs = @(
            'install', 'LIA GPU Metrics',
            $pwsh,
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $gpuMetricsScript,
            '-RootDir', $rootDir,
            '-Port', '13621',
            '-IntervalSeconds', '5'
        )
        & $nssm @nssmArgs 2>&1 | Out-Null

        & $nssm set 'LIA GPU Metrics' DisplayName 'LIA GPU Metrics' 2>&1 | Out-Null
        & $nssm set 'LIA GPU Metrics' Description 'Service de métriques GPU LIA' 2>&1 | Out-Null
        & $nssm set 'LIA GPU Metrics' AppDirectory $rootDir 2>&1 | Out-Null
        & $nssm set 'LIA GPU Metrics' AppStdout (Join-Path $metricsLogDir 'nssm-stdout.log') 2>&1 | Out-Null
        & $nssm set 'LIA GPU Metrics' AppStderr (Join-Path $metricsLogDir 'nssm-stderr.log') 2>&1 | Out-Null
        & $nssm set 'LIA GPU Metrics' Start SERVICE_DELAYED_AUTO_START 2>&1 | Out-Null

        Write-Ok "Service 'LIA GPU Metrics' enregistré (démarrage différé)."
    } else {
        Write-Fail "Script GPU Metrics introuvable : $gpuMetricsScript"
    }

    # Host Launcher (session utilisateur)
    if (Test-Path -LiteralPath $hostLauncherScript) {
        Write-Info 'Demarrage du host launcher (session utilisateur)...'
        try {
            $pwsh = if (Get-Command pwsh -ErrorAction SilentlyContinue) { 'pwsh' } else { 'powershell.exe' }
            Start-Process $pwsh -ArgumentList @(
                '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $hostLauncherScript
            ) -WindowStyle Hidden | Out-Null

            $maxTries = 10
            $delay = 1
            $launcherOk = $false
            for ($i = 0; $i -lt $maxTries; $i++) {
                try {
                    $tcp = New-Object Net.Sockets.TcpClient('localhost', 13580)
                    $tcp.Close()
                    $launcherOk = $true
                    break
                } catch {
                    Start-Sleep -Seconds $delay
                }
            }

            if ($launcherOk) {
                Write-Ok "Host launcher demarre sur http://localhost:13580"
            } else {
                Write-Fail "Host launcher non confirmé après $maxTries tentatives."
            }
        } catch {
            Write-Fail "Demarrage du host launcher impossible : $($_.Exception.Message)"
        }
    } else {
        Write-Fail "Script host launcher introuvable : $hostLauncherScript"
    }
} else {
    Write-Info 'Installation des services ignorée (-SkipServiceInstall).'
}

# ------------------------------------------------------------------------------
# 7. Raccourcis Bureau / Menu Démarrer
# ------------------------------------------------------------------------------
Write-Info 'Création des raccourcis...'
$desktopPath = [Environment]::GetFolderPath('Desktop')
$startMenuPath = Join-Path ([Environment]::GetFolderPath('Programs')) 'LIA-X'

if (-not (Test-Path -LiteralPath $startMenuPath)) {
    New-Item -ItemType Directory -Path $startMenuPath -Force | Out-Null
}

$loaderUrl = "http://localhost:$LoaderPort"

 # Icone des raccourcis : {app}\logo.ico, genere par make-assets.ps1 a partir de
 # logo.svg. Avant, on utilisait shell32.dll,13 (icone systeme, sans rapport
 # avec LIA-X). Windows ne sait PAS lire un SVG pour IconLocation : seules
 # les images matricielles (.ico, .exe, .dll) sont acceptees, sur toutes les
 # versions de Windows. Le .ico multi-tailles (16 a 256) est donc la seule facon
 # d'obtenir le logo dans l'Explorateur, sur le Bureau et dans le Menu.
$appIcon = Join-Path $rootDir 'logo.ico'
if (-not (Test-Path -LiteralPath $appIcon)) {
    Write-WarnMsg "logo.ico introuvable ($appIcon) : les raccourcis garderont une icone systeme."
    $appIcon = 'shell32.dll,13'
}

# Raccourci : Model Manager
# .url : TargetPath doit etre une URL pour un raccourci internet. Un .lnk avec
# une cible HTTP laisse TargetPath VIDE (le shell ne l'interprete pas) : on
# cree donc un .url, que Windows ouvre dans le navigateur par defaut.
$desktopUrlFile = Join-Path $desktopPath 'LIA-X Model Manager.url'
$urlContent = "[InternetShortcut]`r`nURL=$loaderUrl`r`nIconFile=$appIcon`r`nIconIndex=0`r`n"
Set-Content -LiteralPath $desktopUrlFile -Value $urlContent -Encoding ASCII
Write-Ok "Raccourci Bureau : $desktopUrlFile"

$startUrlFile = Join-Path $startMenuPath 'LIA-X Model Manager.url'
Set-Content -LiteralPath $startUrlFile -Value $urlContent -Encoding ASCII
Write-Ok "Raccourci Menu Demarrer : $startUrlFile"

# Supprimer les anciens .lnk (cible vide ou icone systeme) pour ne pas doubler
# l'entree dans le Menu Demarrer et sur le Bureau.
foreach ($old in @((Join-Path $desktopPath 'LIA-X Model Manager.lnk'),
                   (Join-Path $startMenuPath 'LIA-X Model Manager.lnk'))) {
    if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue }
}

# Raccourci startup : Host Launcher
$startupPath = [Environment]::GetFolderPath('Startup')
if (-not (Test-Path -LiteralPath $startupPath)) {
    New-Item -ItemType Directory -Path $startupPath -Force | Out-Null
}
$wsShell = New-Object -ComObject WScript.Shell
$shortcut = $wsShell.CreateShortcut((Join-Path $startupPath 'LIA-X Host Launcher.lnk'))
$shortcut.TargetPath = if (Get-Command pwsh -ErrorAction SilentlyContinue) { 'pwsh' } else { 'powershell.exe' }
$shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$hostLauncherScript`""
$shortcut.WorkingDirectory = $rootDir
$shortcut.WindowStyle = 7
$shortcut.IconLocation = $appIcon
$shortcut.Save()
$wsShell = $null

# Raccourci : Documentation
$readmePath = Join-Path $rootDir 'README.md'
if (Test-Path -LiteralPath $readmePath) {
    $wsShell = New-Object -ComObject WScript.Shell
    $shortcut = $wsShell.CreateShortcut((Join-Path $startMenuPath 'Documentation LIA-X.lnk'))
    $shortcut.TargetPath = $readmePath
    $shortcut.IconLocation = $appIcon
    $shortcut.Save()
    $wsShell = $null
}

Write-Ok "Raccourcis crees dans Bureau et Menu Demarrer."

# ------------------------------------------------------------------------------
# 7b. Installation des interfaces IA via Docker
# ------------------------------------------------------------------------------
Write-Info 'Installation des interfaces IA...'

function Test-Port($port) {
    try {
        $tcp = New-Object Net.Sockets.TcpClient('localhost', $port)
        $tcp.Close()
        return $true
    } catch {
        return $false
    }
}

function Wait-Port($port, $label, $timeoutSec = 120) {
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    while ($stopwatch.Elapsed.TotalSeconds -lt $timeoutSec) {
        if (Test-Port $port) {
            Write-Ok "$label prêt sur le port $port"
            return $true
        }
        Start-Sleep -Seconds 2
    }
    Write-Fail "$label n''a pas démarré sur le port $port dans le délai imparti."
    return $false
}

# LibreChat — aligne sur LIA-X.iss RunLibreChatContainer : mongo + 3007:3080,
# reseau lia-network, host-gateway vers le proxy http://host.docker.internal:3005/v1
if ($InstallLibreChat) {
    Write-Host '    Démarrage de LibreChat...' -ForegroundColor Cyan
    try {
        docker network inspect lia-network *> $null
        if ($LASTEXITCODE -ne 0) { docker network create lia-network | Out-Null }
        docker rm -f librechat-mongo 2>$null | Out-Null
        docker rm -f librechat 2>$null | Out-Null
        docker run -d --name librechat-mongo --network lia-network -v librechat-mongo:/data/db --restart unless-stopped mongo:6 | Out-Null
        docker run -d --name librechat --network lia-network -p 3007:3080 --add-host host.docker.internal:host-gateway `
            -e CONFIG_PATH=/app/librechat.yaml `
            -e MONGO_URI=mongodb://librechat-mongo:27017/LibreChat `
            -e JWT_SECRET=7b9d6f2a3c8e5b1d4f7a9c3e8b2d5f1a7c9e3b6d2f8a5c1e4b7d9f3a8c2e5b1d `
            -e JWT_REFRESH_SECRET=5a8c2e6b9d3f5a7c1e4b8d2f6a9c3e7b5d1a4f8c2e6b9d3f5a7c1e4b8d2f6a9c `
            -e ALLOW_EMAIL_LOGIN=true -e ALLOW_REGISTRATION=true -e ALLOW_SOCIAL_LOGIN=false `
            -e OPENAI_API_KEY=not-used `
            -e OPENAI_BASE_URL=http://host.docker.internal:3005/v1 `
            -e OPENAI_API_BASE_URL=http://host.docker.internal:3005/v1 `
            -e OPENAI_API_BASE_URLS=http://host.docker.internal:3005/v1 `
            -e OPENAI_REVERSE_PROXY=http://host.docker.internal:3005/v1 `
            -e OPENAI_MODELS_FETCH=true -e OPENAI_MODELS=lia-local `
            -e AUTO_FETCH_MODELS=true `
            -e ENABLE_OPENAI=true -e OPENAI_PROXY_ENABLED=true `
            -e DISABLE_TELEMETRY=true `
            -v librechat-data:/app/api/data --restart unless-stopped `
            ghcr.io/danny-avila/librechat:latest | Out-Null
        Write-Ok 'LibreChat lancé sur http://localhost:3007'
    } catch {
        Write-Fail "Impossible de démarrer LibreChat : $($_.Exception.Message)"
    }
}

# Open WebUI — aligne sur LIA-X.iss RunOpenWebUIContainer : 3008:8080
if ($InstallOpenWebUI) {
    Write-Host '    Démarrage de Open WebUI...' -ForegroundColor Cyan
    try {
        docker network inspect lia-network *> $null
        if ($LASTEXITCODE -ne 0) { docker network create lia-network | Out-Null }
        docker rm -f openwebui 2>$null | Out-Null
        docker run -d --name openwebui --network lia-network -p 3008:8080 --add-host host.docker.internal:host-gateway `
            -e WEBUI_AUTH=False -e WEBUI_SECRET_KEY=lia-local-secret `
            -e ENABLE_OLLAMA_API=false -e ENABLE_OPENAI_API=true `
            -e OPENAI_API_BASE_URL=http://host.docker.internal:3005/v1 `
            -e OPENAI_API_BASE_URLS=http://host.docker.internal:3005/v1 `
            -e OPENAI_API_KEYS=not-used -e OPENAI_API_KEY=not-used `
            -v open-webui-data:/app/backend/data --restart unless-stopped `
            ghcr.io/open-webui/open-webui:main | Out-Null
        Write-Ok 'Open WebUI lancé sur http://localhost:3008'
    } catch {
        Write-Fail "Impossible de démarrer Open WebUI : $($_.Exception.Message)"
    }
}

# AnythingLLM — aligne sur LIA-X.iss RunAnythingLLMContainer : 3006:3001
if ($InstallAnythingLLM) {
    Write-Host '    Démarrage de AnythingLLM...' -ForegroundColor Cyan
    try {
        docker network inspect lia-network *> $null
        if ($LASTEXITCODE -ne 0) { docker network create lia-network | Out-Null }
        docker rm -f anythingllm 2>$null | Out-Null
        docker run -d --name anythingllm --network lia-network -p 3006:3001 --add-host host.docker.internal:host-gateway `
            -e STORAGE_DIR=/app/server/storage -e LLM_PROVIDER=generic-openai `
            -e GENERIC_OPEN_AI_BASE_PATH=http://host.docker.internal:3005/v1 `
            -e GENERIC_OPEN_AI_MODEL_PREF=lia-local -e GENERIC_OPEN_AI_API_KEY=not-used `
            -e GENERIC_OPEN_AI_MODEL_TOKEN_LIMIT=8192 -e EMBEDDING_ENGINE=native `
            -v anythingllm-storage:/app/server/storage --restart unless-stopped `
            mintplexlabs/anythingllm:latest | Out-Null
        Write-Ok 'AnythingLLM lancé sur http://localhost:3006'
    } catch {
        Write-Fail "Impossible de démarrer AnythingLLM : $($_.Exception.Message)"
    }
}

# ------------------------------------------------------------------------------
# 7c. Ouverture des interfaces dans le navigateur
# ------------------------------------------------------------------------------
# VOLONTAIREMENT VIDE : aucune ouverture d URL ici.
#
# L ouverture des onglets est faite par l installateur (LIA-X.iss, fin de
# CurStepChanged), qui connait les cases a cocher de la page Interfaces. Ce
# script ne recoit pas ces choix : il ouvrait donc TOUJOURS le Model Loader
# (deux fenetres : une depuis ici, une depuis l ISS), et ouvrait LibreChat /
# Open WebUI / AnythingLLM meme si l utilisateur ne les avait pas selectionnes.
#
# L ISS lance ce script AVANT d ouvrir les onglets : les interfaces sont donc
# bien pretes quand le navigateur s ouvre.
Write-Info "Post-installation terminee (ouverture des onglets geree par l installateur)."

# ------------------------------------------------------------------------------
# 8. Marquage installation
# ------------------------------------------------------------------------------
$installInfoPath = Join-Path $rootDir '.install-paths.json'
$installInfo = @{
    install_dir      = $rootDir
    models_dir       = $modelsTargetDir
    controller_port  = $ControllerPort
    llama_port       = $LlamaPort
    loader_port      = $LoaderPort
    installed_at     = (Get-Date -Format 'o')
} | ConvertTo-Json -Depth 3
[System.IO.File]::WriteAllText($installInfoPath, $installInfo, [System.Text.Encoding]::UTF8)
Write-Ok "Informations d'installation enregistrées."

Write-Host ''
Write-Host 'Post-installation LIA-X terminée.' -ForegroundColor Green
Write-Host "  Installation : $rootDir"
Write-Host "  Modèles      : $modelsTargetDir"
Write-Host "  Model Loader : http://localhost:$LoaderPort"
Write-Host '  Services Windows enregistrés (démarrage différé au prochain boot).'
Write-Host ''
