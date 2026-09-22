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
$embeddedNssm = Join-Path $rootDir 'tools\nssm\nssm.exe'

if (Test-Path -LiteralPath $embeddedNssm) {
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
# 3. runtime/host-runtime-config.json
# ------------------------------------------------------------------------------
Write-Info 'Configuration du runtime...'
$binaryPath = Join-Path $runtimeDir 'llama-releases\b11013-vulkan\llama-server.exe'
if (-not (Test-Path -LiteralPath $binaryPath)) {
    Write-Fail "llama-server.exe introuvable à : $binaryPath"
    throw "Runtime incomplet."
}

$runtimeConfigPath = Join-Path $runtimeDir 'host-runtime-config.json'
$runtimeConfig = @{
    controller_port        = $ControllerPort
    server_port            = $LlamaPort
    backend                = 'vulkan'
    backend_label          = 'Vulkan'
    binary_path            = $binaryPath
    models_dir             = $modelsTargetDir
    proxy_model_id         = 'lia-local'
    default_context        = 8192
    default_gpu_layers     = 999
    sleep_idle_seconds     = 60
    server_port_start      = 12434
    server_port_end        = 12444
    max_instances          = 6
} | ConvertTo-Json -Depth 5 -Compress

[System.IO.File]::WriteAllText($runtimeConfigPath, $runtimeConfig, [System.Text.Encoding]::UTF8)
Write-Ok "host-runtime-config.json écrit : $runtimeConfigPath"

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
            npm install | Out-Null
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

# Raccourci : Model Manager
$wsShell = New-Object -ComObject WScript.Shell
$shortcut = $wsShell.CreateShortcut((Join-Path $desktopPath 'LIA-X Model Manager.lnk'))
$shortcut.TargetPath = $loaderUrl
$shortcut.IconLocation = 'shell32.dll,13'
$shortcut.Save()
$wsShell = $null

$wsShell = New-Object -ComObject WScript.Shell
$shortcut = $wsShell.CreateShortcut((Join-Path $startMenuPath 'LIA-X Model Manager.lnk'))
$shortcut.TargetPath = $loaderUrl
$shortcut.IconLocation = 'shell32.dll,13'
$shortcut.Save()
$wsShell = $null

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
$shortcut.IconLocation = 'shell32.dll,13'
$shortcut.Save()
$wsShell = $null
$shortcut.IconLocation = 'shell32.dll,13'
$shortcut.Save()
$wsShell = $null

# Raccourci : Installation / Ajout d'interfaces
$installerScript = Join-Path $rootDir 'scripts\lia.ps1'
if (Test-Path -LiteralPath $installerScript) {
    $wsShell = New-Object -ComObject WScript.Shell
    $shortcut = $wsShell.CreateShortcut((Join-Path $startMenuPath 'LIA-X - Ajouter interfaces.lnk'))
    $shortcut.TargetPath = if (Get-Command pwsh -ErrorAction SilentlyContinue) { 'pwsh' } else { 'powershell.exe' }
    $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$installerScript`""
    $shortcut.WorkingDirectory = $rootDir
    $shortcut.IconLocation = 'shell32.dll,15'
    $shortcut.Save()
    $wsShell = $null

    Write-Ok "Raccourci 'Ajouter interfaces' créé."
}

# Raccourci : Documentation
$readmePath = Join-Path $rootDir 'README.md'
if (Test-Path -LiteralPath $readmePath) {
    $wsShell = New-Object -ComObject WScript.Shell
    $shortcut = $wsShell.CreateShortcut((Join-Path $startMenuPath 'Documentation LIA-X.lnk'))
    $shortcut.TargetPath = $readmePath
    $shortcut.IconLocation = 'shell32.dll,14'
    $shortcut.Save()
    $wsShell = $null
}

Write-Ok "Raccourcis créés dans Bureau et Menu Démarrer."

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

# LibreChat
if ($InstallLibreChat) {
    Write-Host '    Démarrage de LibreChat...' -ForegroundColor Cyan
    try {
        docker run -d -p 3080:3080 --name librechat -e JWT_SECRET="lia-x-secret" -e OPENAI_API_KEY="sk-placeholder" ghcr.io/danny-avila/librechat:latest | Out-Null
        Write-Ok 'LibreChat lancé sur http://localhost:3080'
    } catch {
        Write-Fail "Impossible de démarrer LibreChat : $($_.Exception.Message)"
    }
}

# Open WebUI
if ($InstallOpenWebUI) {
    Write-Host '    Démarrage de Open WebUI...' -ForegroundColor Cyan
    try {
        docker run -d -p 3000:8080 --name open-webui -e DEFAULT_MODELS="[]" ghcr.io/open-webui/open-webui:main | Out-Null
        Write-Ok 'Open WebUI lancé sur http://localhost:3000'
    } catch {
        Write-Fail "Impossible de démarrer Open WebUI : $($_.Exception.Message)"
    }
}

# AnythingLLM
if ($InstallAnythingLLM) {
    Write-Host '    Démarrage de AnythingLLM...' -ForegroundColor Cyan
    try {
        docker run -d -p 3001:3001 --name anything-llm -e JWT_SECRET="lia-x-secret" ghcr.io/montanalab/anythingllm:latest | Out-Null
        Write-Ok 'AnythingLLM lancé sur http://localhost:3001'
    } catch {
        Write-Fail "Impossible de démarrer AnythingLLM : $($_.Exception.Message)"
    }
}

# ------------------------------------------------------------------------------
# 7c. Ouverture des interfaces dans le navigateur
# ------------------------------------------------------------------------------
Write-Info 'Préparation de l''ouverture des interfaces...'
$urls = @()
if ($InstallLibreChat) { $urls += 'http://localhost:3080' }
if ($InstallOpenWebUI) { $urls += 'http://localhost:3000' }
if ($InstallAnythingLLM) { $urls += 'http://localhost:3001' }
$urls += "http://localhost:$LoaderPort"

foreach ($url in $urls) {
    try {
        Start-Process $url
        Write-Ok "Ouverture navigateur : $url"
    } catch {
        Write-Fail "Impossible d''ouvrir $url : $($_.Exception.Message)"
    }
}

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
