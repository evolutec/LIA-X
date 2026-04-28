$ErrorActionPreference = "Stop"
$ScriptName = "lia.ps1"
$ScriptDir = Split-Path -Parent $PSCommandPath
$ScriptPath = Join-Path $ScriptDir $ScriptName

$rootDir           = Split-Path -Parent $ScriptDir
$runtimeDir        = Join-Path $rootDir "runtime"
$modelsDir         = Join-Path $rootDir "models"
$llamaRepoDir      = Join-Path $runtimeDir "llama.cpp"
$controllerScript  = Join-Path $rootDir "controller\llama-host-controller.ps1"
$controllerServiceHelper = Join-Path $rootDir "scripts\install-update-lia-controller-service.ps1"
$runtimeConfigPath = Join-Path $runtimeDir "host-runtime-config.json"
$runtimeStatePath  = Join-Path $runtimeDir "host-runtime-state.json"
$hardwareProfilePath = Join-Path $runtimeDir "hardware-profile.json"
$controllerPort    = 13579
$llamaPort         = 12434
$loaderPort           = 3002
$anythingPort         = 3001
$openWebUiPort        = 3003
$libreChatPort        = 3004
$libreChatInternalPort = 3080
$dockerNetwork        = "lia-network"
$modelLoaderImage     = "lia-model-loader:latest"
$anythingllmImage  = "mintplexlabs/anythingllm:latest"
$openWebUiImage    = "ghcr.io/open-webui/open-webui:main"
$libreChatImage    = "ghcr.io/danny-avila/librechat:latest"

function Confirm-Command([string]$cmd) {
    [bool](Get-Command $cmd -ErrorAction SilentlyContinue)
}

function Test-IsAdministrator {
    try {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = [Security.Principal.WindowsPrincipal]::new($identity)
        return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch {
        return $false
    }
}

function Get-PreferredPowerShellExecutable {
    $pwsh = Get-Command pwsh -ErrorAction SilentlyContinue
    if ($pwsh) {
        return $pwsh.Source
    }
    return (Get-Command powershell.exe -ErrorAction Stop).Source
}

function Start-HostMetricsService {
    $metricsScript = Join-Path $rootDir 'scripts\install-update-lia-gpu-metrics-service.ps1'
    if (-not (Test-Path $metricsScript)) {
        WARN "Service de metriques hôte introuvable : $metricsScript"
        return
    }

    pwsh -NoProfile -ExecutionPolicy Bypass -File $metricsScript
}

function Ensure-ControllerServiceInstalled {
    if (Test-IsAdministrator) {
        & $controllerServiceHelper -RootDir $rootDir
        return
    }

    INFO "Installation du service LIA Controller: elevation UAC requise."
    $pwshExe = Get-PreferredPowerShellExecutable
    $escapedRoot = $rootDir.Replace("'", "''")
    $escapedHelper = $controllerServiceHelper.Replace("'", "''")
    $elevatedCommand = "& '$escapedHelper' -RootDir '$escapedRoot'"

    try {
        $proc = Start-Process -FilePath $pwshExe -Verb RunAs -Wait -PassThru -ArgumentList @(
            '-NoProfile',
            '-ExecutionPolicy', 'Bypass',
            '-Command', $elevatedCommand
        )
        if ($proc.ExitCode -ne 0) {
            FAIL "Installation du service annulee ou echouee (exit code $($proc.ExitCode))."
        }
    } catch {
        FAIL "Impossible de lancer l'installation service avec elevation UAC: $($_.Exception.Message)"
    }
}

function Step([string]$n, [string]$msg) {
    Write-Host "`n── [$n] $msg" -ForegroundColor Cyan
}

function OK([string]$msg)   { Write-Host "  ✅ $msg" -ForegroundColor Green }
function WARN([string]$msg) { Write-Host "  ⚠️  $msg" -ForegroundColor Yellow }
function FAIL([string]$msg) { Write-Host "  ❌ $msg" -ForegroundColor Red; exit 1 }
function INFO([string]$msg) { Write-Host "  ℹ️  $msg" -ForegroundColor DarkCyan }

function Ensure-Directory([string]$path) {
    if (-not (Test-Path $path)) {
        New-Item -ItemType Directory -Path $path -Force | Out-Null
    }
}

function Ensure-WingetPackage([string]$id, [string]$name, [string]$checkCommand = "", [string]$override = "") {
    $isInstalled = $false
    if ($checkCommand) {
        $isInstalled = Confirm-Command $checkCommand
    } else {
        $wingetListOutput = winget list --id $id -e --accept-source-agreements 2>&1
        if ($LASTEXITCODE -eq 0 -and ($wingetListOutput -join "`n") -notmatch 'No installed package found') {
            $isInstalled = $true
        }
    }

    if (-not $isInstalled) {
        INFO "Installation $name"
        $args = @('install', '--id', $id, '-e', '--silent', '--accept-source-agreements', '--accept-package-agreements')
        if ($override) {
            $args += @('--override', $override)
        }
        winget @args
        if ($LASTEXITCODE -ne 0) {
            if ($checkCommand) {
                $isInstalled = Confirm-Command $checkCommand
            } else {
                $wingetListOutput = winget list --id $id -e --accept-source-agreements 2>&1
                $isInstalled = ($LASTEXITCODE -eq 0 -and ($wingetListOutput -join "`n") -notmatch 'No installed package found')
            }

            if (-not $isInstalled) {
                FAIL "Installation impossible : $name"
            }
        }

        if (-not $isInstalled) {
            if ($checkCommand) {
                $isInstalled = Confirm-Command $checkCommand
            } else {
                $wingetListOutput = winget list --id $id -e --accept-source-agreements 2>&1
                $isInstalled = ($LASTEXITCODE -eq 0 -and ($wingetListOutput -join "`n") -notmatch 'No installed package found')
            }
        }

        if (-not $isInstalled) {
            FAIL "Installation impossible : $name"
        }
    }

    OK "$name prêt"
}

function Get-LlamaReleaseCandidates($plan) {
    if ($plan.releaseCandidates) {
        return $plan.releaseCandidates
    }

    switch ($plan.backend) {
        'cuda' {
            return @(
                @{ backend = 'cuda'; label = 'NVIDIA CUDA'; assetPattern = 'llama-.*-bin-win-cuda-13\.1-x64\.zip$' },
                @{ backend = 'cuda'; label = 'NVIDIA CUDA'; assetPattern = 'llama-.*-bin-win-cuda-12\.4-x64\.zip$' },
                @{ backend = 'vulkan'; label = 'Vulkan'; assetPattern = 'llama-.*-bin-win-vulkan-x64\.zip$' },
                @{ backend = 'cpu'; label = 'CPU'; assetPattern = 'llama-.*-bin-win-cpu-x64\.zip$' }
            )
        }
        'vulkan' {
            return @(
                @{ backend = 'vulkan'; label = 'Vulkan'; assetPattern = 'llama-.*-bin-win-vulkan-x64\.zip$' },
                @{ backend = 'cpu'; label = 'CPU'; assetPattern = 'llama-.*-bin-win-cpu-x64\.zip$' }
            )
        }
        default {
            return @(
                @{ backend = 'cpu'; label = 'CPU'; assetPattern = 'llama-.*-bin-win-cpu-x64\.zip$' }
            )
        }
    }
}

function Normalize-RuntimeConfig {
    if (-not (Test-Path $runtimeConfigPath)) {
        return
    }

    $config = Get-Content $runtimeConfigPath -Raw | ConvertFrom-Json
    $updated = $false

    if ($config.server_port -ne $llamaPort) {
        $config.server_port = $llamaPort
        $updated = $true
    }

    if ([string]$config.backend -eq 'sycl') {
        $config.backend = 'vulkan'
        $config.backend_label = 'Vulkan'
        $updated = $true
    }

    if ([string]$config.binary_path -match 'llama-releases\\[^\\]+-sycl\\') {
        $config.binary_path = $config.binary_path -replace 'llama-releases\\([^\\]+)-sycl\\', 'llama-releases\\$1-vulkan\\'
        $updated = $true
    }

    if ($updated) {
        $config | ConvertTo-Json -Depth 6 | Set-Content -Path $runtimeConfigPath -Encoding UTF8
        OK "Configuration runtime existante normalisee sur Vulkan"
    }
}

function Get-LlamaReleaseDirectoryTag([System.IO.DirectoryInfo]$dir, [string]$backend) {
    if (-not $dir -or -not $dir.Name) {
        return $null
    }

    if ($dir.Name -match "^(.*)-$([regex]::Escape($backend))$") {
        return $matches[1]
    }

    return $null
}

function Get-LlamaServerBinaryFromDirectory([string]$directoryPath) {
    if (-not (Test-Path $directoryPath)) {
        return $null
    }

    $binary = Get-ChildItem -Path $directoryPath -Filter 'llama-server.exe' -File -Recurse -ErrorAction SilentlyContinue |
        Select-Object -First 1

    if ($binary) {
        return $binary.FullName
    }

    return $null
}

function Confirm-LlamaCppUpdate([string]$backend, [string]$localTag, [string]$latestTag) {
    $localLabel = 'inconnue'
    if ($localTag) { $localLabel = $localTag }
    Write-Host "\nUne nouvelle version de llama.cpp est disponible pour le backend $backend." -ForegroundColor Yellow
    Write-Host "Version locale : $localLabel" -ForegroundColor Gray
    Write-Host "Derniere version : $latestTag" -ForegroundColor Gray
    do {
        $answer = Read-Host 'Voulez-vous telecharger et remplacer le binaire existant ? [O/N]'
        $normalized = $answer.Trim().ToUpper()
    } while ($normalized -notin @('O', 'OUI', 'Y', 'YES', 'N', 'NON', 'NO'))

    return $normalized -in @('O', 'OUI', 'Y', 'YES')
}

function Cleanup-OldLlamaReleaseDirectories([string]$releaseRoot, [string]$backend, [string]$keepDir, [string]$archivePattern = '.*\.zip$') {
    if (-not (Test-Path $releaseRoot)) {
        return
    }

    $keepTag = $null
    if ($keepDir) {
        $keepTag = Get-LlamaReleaseDirectoryTag $keepDir $backend
    }

    $oldDirs = Get-ChildItem -Path $releaseRoot -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match "^.+-$([regex]::Escape($backend))$" -and $_.FullName -ne $keepDir }

    foreach ($dir in $oldDirs) {
        try {
            INFO "Suppression de l'ancien dossier llama-releases : $($dir.Name)"
            Remove-Item -Path $dir.FullName -Recurse -Force -ErrorAction Stop
        } catch {
            WARN "Impossible de supprimer $($dir.FullName) : $($_.Exception.Message)"
        }
    }

    $oldZips = Get-ChildItem -Path $releaseRoot -File -Filter '*.zip' -ErrorAction SilentlyContinue |
        Where-Object {
            $_.Name -match $archivePattern -and
            (-not $keepTag -or $_.Name -notmatch [regex]::Escape($keepTag))
        }

    foreach ($zip in $oldZips) {
        try {
            INFO "Suppression de l'ancien archive llama-releases : $($zip.Name)"
            Remove-Item -Path $zip.FullName -Force -ErrorAction Stop
        } catch {
            WARN "Impossible de supprimer $($zip.FullName) : $($_.Exception.Message)"
        }
    }
}

function Try-DownloadLlamaCppRelease($plan) {
    $candidates = @(Get-LlamaReleaseCandidates $plan)
    $releaseRoot = Join-Path $runtimeDir 'llama-releases'
    Ensure-Directory $releaseRoot

    # Vérifier la dernière version sur GitHub dès que possible.
    $latestRelease = $null
    try {
        $latestRelease = Invoke-RestMethod -Uri 'https://api.github.com/repos/ggml-org/llama.cpp/releases/latest' -Headers @{ 'User-Agent' = 'LIA-setup' }
    } catch {
        WARN "Impossible de recuperer la derniere release llama.cpp. Le binaire local sera utilise si disponible."
    }

    foreach ($candidate in $candidates) {
        $localDirs = Get-ChildItem -Path $releaseRoot -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match "^.+-$([regex]::Escape($candidate.backend))$" } |
            Sort-Object Name -Descending

        foreach ($dir in $localDirs) {
            $localBinary = Get-LlamaServerBinaryFromDirectory $dir.FullName
            if (-not $localBinary) {
                continue
            }

            $localTag = Get-LlamaReleaseDirectoryTag $dir $candidate.backend
            if ($latestRelease -and $latestRelease.tag_name -and ($localTag -ne $latestRelease.tag_name)) {
                if (Confirm-LlamaCppUpdate $candidate.backend $localTag $latestRelease.tag_name) {
                    $asset = $latestRelease.assets | Where-Object { $_.name -match $candidate.assetPattern } | Select-Object -First 1
                    if ($asset) {
                        $releaseDir = Join-Path $releaseRoot ("{0}-{1}" -f $latestRelease.tag_name, $candidate.backend)
                        $archivePath = Join-Path $releaseRoot $asset.name

                        INFO "Telechargement de la nouvelle release llama.cpp : $($asset.name)"
                        Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $archivePath -Headers @{ 'User-Agent' = 'LIA-setup' }

                        if (Test-Path $releaseDir) {
                            Remove-Item $releaseDir -Recurse -Force -ErrorAction Stop
                        }

                        Expand-Archive -Path $archivePath -DestinationPath $releaseDir -Force

                        $binaryPath = Get-LlamaServerBinaryFromDirectory $releaseDir
                        if ($binaryPath) {
                            INFO "Mise a jour de llama.cpp terminee : $($releaseDir)"
                            Cleanup-OldLlamaReleaseDirectories $releaseRoot $candidate.backend $releaseDir $candidate.assetPattern
                            return @{ backend = $candidate.backend; label = $candidate.label; binaryPath = $binaryPath; source = 'release'; buildDir = $releaseDir }
                        }

                        WARN "Le binaire telecharge ne contient pas llama-server.exe : $($asset.name)"
                    } else {
                        WARN "Aucun asset correspondant trouve pour le backend $($candidate.backend) sur la release $($latestRelease.tag_name)."
                    }

                    INFO "Reutilisation du binaire local existant : $($dir.Name)"
                    Cleanup-OldLlamaReleaseDirectories $releaseRoot $candidate.backend $dir.FullName $candidate.assetPattern
                    return @{ backend = $candidate.backend; label = $candidate.label; binaryPath = $localBinary; source = 'release'; buildDir = $dir.FullName }
                }
            }

            INFO "Binaire llama.cpp existant réutilisé : $($dir.Name)"
            Cleanup-OldLlamaReleaseDirectories $releaseRoot $candidate.backend $dir.FullName $candidate.assetPattern
            return @{ backend = $candidate.backend; label = $candidate.label; binaryPath = $localBinary; source = 'release'; buildDir = $dir.FullName }
        }
    }

    if (-not $latestRelease) {
        WARN "Aucune release distante disponible et aucun binaire local compatible n'a ete trouve."
        return $null
    }

    foreach ($candidate in $candidates) {
        $asset = $latestRelease.assets | Where-Object { $_.name -match $candidate.assetPattern } | Select-Object -First 1
        if (-not $asset) {
            continue
        }

        $releaseDir = Join-Path $releaseRoot ("{0}-{1}" -f $latestRelease.tag_name, $candidate.backend)
        $archivePath = Join-Path $releaseRoot $asset.name

        INFO "Telechargement du binaire officiel llama.cpp : $($asset.name)"
        Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $archivePath -Headers @{ 'User-Agent' = 'LIA-setup' }

        if (Test-Path $releaseDir) {
            Remove-Item $releaseDir -Recurse -Force -ErrorAction Stop
        }

        Expand-Archive -Path $archivePath -DestinationPath $releaseDir -Force

        $binaryPath = Get-LlamaServerBinaryFromDirectory $releaseDir
        if ($binaryPath) {
            Cleanup-OldLlamaReleaseDirectories $releaseRoot $candidate.backend $releaseDir
            return @{ backend = $candidate.backend; label = $candidate.label; binaryPath = $binaryPath; source = 'release'; buildDir = $releaseDir }
        }

        WARN "Le binaire telecharge ne contient pas llama-server.exe : $($asset.name)"
    }

    WARN "Aucun binaire précompilé compatible n'a pu être préparé."
    return $null
}

function Wait-HttpOk([string]$url, [int]$maxTries = 30, [int]$delay = 3) {
    for ($i = 0; $i -lt $maxTries; $i++) {
        try {
            $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
                return $true
            }
        } catch {}
        Start-Sleep -Seconds $delay
    }
    return $false
}

function Open-Tabs([string[]]$urls) {
    $chromePaths = @(
        "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
    )
    $chrome = $chromePaths | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($chrome) {
        Start-Process $chrome ($urls -join " ")
    } else {
        $urls | ForEach-Object { Start-Process $_ }
    }
}

function Get-InterfaceChoice {
    Write-Host "`nInterfaces disponibles :" -ForegroundColor White
    Write-Host "  1) Open WebUI" -ForegroundColor Gray
    Write-Host "  2) AnythingLLM" -ForegroundColor Gray
    Write-Host "  3) LibreChat" -ForegroundColor Gray
    Write-Host "  4) Tous" -ForegroundColor Gray

    do {
        $choice = (Read-Host "Choix [1/2/3/4]").Trim()
    } while ($choice -notin @('1', '2', '3', '4'))

    return $choice
}

function Get-HardwareProfile {
    $controllers = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue
    $names = @()
    foreach ($controller in $controllers) {
        if ($controller.Name) { $names += $controller.Name }
    }

    if ($names.Count -gt 0) {
        $joined = $names -join ' | '
    } else {
        $joined = ''
    }

    if ($joined -match 'NVIDIA') {
        $gpuVendor = 'nvidia'
    } elseif ($joined -match 'Radeon|AMD') {
        $gpuVendor = 'amd'
    } elseif ($joined -match 'Intel') {
        $gpuVendor = 'intel'
    } else {
        $gpuVendor = 'cpu'
    }

    if ($joined) { $gpuLabel = $joined } else { $gpuLabel = 'Aucun GPU détecté' }

    $gpuDevices = @()
    foreach ($controller in $controllers) {
        $name = ''
        if ($controller.Name) { $name = $controller.Name.Trim() }
        $driverVersion = ''
        if ($controller.DriverVersion) { $driverVersion = $controller.DriverVersion.Trim() }
        $adapterRam = 0
        if ($controller.AdapterRAM -ne $null) { $adapterRam = [int64]$controller.AdapterRAM }

        $gpuDevices += @{
            name = $name
            driver_version = $driverVersion
            adapter_ram_bytes = $adapterRam
        }
    }

    $processor = Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue | Select-Object -First 1
    $cpuProfile = $null
    if ($processor) {
        $model = ''
        if ($processor.Name) { $model = $processor.Name.Trim() }
        $manufacturer = ''
        if ($processor.Manufacturer) { $manufacturer = $processor.Manufacturer.Trim() }

        $physicalCores = 0
        if ($processor.NumberOfCores -ne $null) { $physicalCores = [int]$processor.NumberOfCores }
        $logicalProcessors = 0
        if ($processor.NumberOfLogicalProcessors -ne $null) { $logicalProcessors = [int]$processor.NumberOfLogicalProcessors }
        $maxClockSpeedMhz = 0
        if ($processor.MaxClockSpeed -ne $null) { $maxClockSpeedMhz = [int]$processor.MaxClockSpeed }
        $currentClockSpeedMhz = 0
        if ($processor.CurrentClockSpeed -ne $null) { $currentClockSpeedMhz = [int]$processor.CurrentClockSpeed }

        $cpuProfile = @{
            model = $model
            manufacturer = $manufacturer
            architecture = switch ($processor.Architecture) {
                0 { 'x86' }
                1 { 'MIPS' }
                2 { 'Alpha' }
                3 { 'PowerPC' }
                5 { 'ARM' }
                6 { 'Itanium' }
                9 { 'x64' }
                default { [string]$processor.Architecture }
            }
            physical_cores = $physicalCores
            logical_processors = $logicalProcessors
            max_clock_speed_mhz = $maxClockSpeedMhz
            current_clock_speed_mhz = $currentClockSpeedMhz
        }
    }

    $osInfo = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
    $memoryProfile = $null
    $osProfile = $null
    if ($osInfo) {
        $totalMemory = 0
        if ($osInfo.TotalVisibleMemorySize -ne $null) { $totalMemory = [int64]$osInfo.TotalVisibleMemorySize }
        $freeMemory = 0
        if ($osInfo.FreePhysicalMemory -ne $null) { $freeMemory = [int64]$osInfo.FreePhysicalMemory }

        $memoryProfile = @{
            total_bytes = $totalMemory * 1024
            free_bytes = $freeMemory * 1024
        }
        $caption = ''
        if ($osInfo.Caption) { $caption = $osInfo.Caption.Trim() }
        $version = ''
        if ($osInfo.Version) { $version = $osInfo.Version.Trim() }
        $buildNumber = ''
        if ($osInfo.BuildNumber) { $buildNumber = $osInfo.BuildNumber.Trim() }

        $osProfile = @{
            caption = $caption
            version = $version
            build_number = $buildNumber
        }
    }

    return @{
        vendor = $gpuVendor
        label = $gpuLabel
        gpu = @{
            vendor = $gpuVendor
            label = $gpuLabel
            count = $gpuDevices.Count
            devices = $gpuDevices
        }
        cpu = $cpuProfile
        memory = $memoryProfile
        os = $osProfile
        detected_at = (Get-Date).ToString('o')
    }
}

# GPU-specific tool installation has been removed.
# Host hardware is detected in lia.ps1, and GPU metrics collection is done via PowerShell.HardwareMonitor in scripts/gpu-collector.ps1.

function Save-HardwareProfile([hashtable]$profile) {
    try {
        $existing = $null
        if (Test-Path $hardwareProfilePath) {
            try {
                $existing = Get-Content -Path $hardwareProfilePath -Raw | ConvertFrom-Json
            } catch {
                $existing = $null
            }
        }

        $generationCount = 1
        if ($existing -and $existing.generation_count) {
            $generationCount = [int]$existing.generation_count + 1
        }
        $profile.generation_count = $generationCount
        $profile.generated_at = (Get-Date).ToString('o')
        $profile | ConvertTo-Json -Depth 6 | Set-Content -Path $hardwareProfilePath -Encoding UTF8
        OK "Profil materiel sauve : $hardwareProfilePath (generation_count=$($profile.generation_count))"
    } catch {
        WARN "Impossible de sauvegarder le profil materiel: $($_.Exception.Message)"
    }
}

function Get-RecommendedRuntimeConfig([hashtable]$hardware) {
    $GB = 1024 * 1024 * 1024
    $vendorValue = 'cpu'
    if ($hardware -and $hardware.vendor) { $vendorValue = $hardware.vendor }
    $vendor = [string]$vendorValue.ToLower()

    $totalRam = 0
    if ($hardware -and $hardware.memory -and $hardware.memory.total_bytes) { $totalRam = [int64]$hardware.memory.total_bytes }

    $gpuRam = 0
    if ($hardware -and $hardware.gpu -and $hardware.gpu.devices -and $hardware.gpu.devices.Count -gt 0) { $gpuRam = [int64]$hardware.gpu.devices[0].adapter_ram_bytes }

    $recommended = @{
        backend = 'cpu'
        backend_label = 'CPU'
        context = 4096
        gpu_layers = 0
    }

    if ($vendor -in @('nvidia', 'amd', 'intel')) {
        if ($vendor -eq 'nvidia') {
            $recommended.backend = 'cuda'
            $recommended.backend_label = 'NVIDIA CUDA'
        } else {
            $recommended.backend = 'vulkan'
            $recommended.backend_label = 'Vulkan'
        }
        $recommended.gpu_layers = 999

        if ($gpuRam -ge 24 * $GB) {
            $recommended.context = 8192
        } elseif ($gpuRam -ge 14 * $GB) {
            $recommended.context = 6144
        } elseif ($gpuRam -ge 8 * $GB) {
            $recommended.context = 4096
        } else {
            $recommended.context = 2048
        }
    } else {
        if ($totalRam -ge 32 * $GB) {
            $recommended.context = 8192
        } elseif ($totalRam -ge 16 * $GB) {
            $recommended.context = 4096
        } else {
            $recommended.context = 2048
        }
    }

    return $recommended
}

function Get-BackendPlan($hardware) {
    $recommended = Get-RecommendedRuntimeConfig $hardware
    $vendor = [string]$hardware.vendor

    if ($vendor -eq 'nvidia') {
        return @{
            backend = 'cuda'
            label = 'NVIDIA CUDA'
            recommended_context = $recommended.context
            recommended_gpu_layers = $recommended.gpu_layers
            releaseCandidates = @(
                @{ backend = 'cuda'; label = 'NVIDIA CUDA'; assetPattern = 'llama-.*-bin-win-cuda-13\.1-x64\.zip$' },
                @{ backend = 'cuda'; label = 'NVIDIA CUDA'; assetPattern = 'llama-.*-bin-win-cuda-12\.4-x64\.zip$' },
                @{ backend = 'vulkan'; label = 'Vulkan'; assetPattern = 'llama-.*-bin-win-vulkan-x64\.zip$' },
                @{ backend = 'cpu'; label = 'CPU'; assetPattern = 'llama-.*-bin-win-cpu-x64\.zip$' }
            )
        }
    }

    if ($vendor -eq 'amd') {
        return @{
            backend = 'vulkan'
            label = 'Vulkan'
            recommended_context = $recommended.context
            recommended_gpu_layers = $recommended.gpu_layers
            releaseCandidates = @(
                @{ backend = 'vulkan'; label = 'Vulkan'; assetPattern = 'llama-.*-bin-win-vulkan-x64\.zip$' },
                @{ backend = 'cpu'; label = 'CPU'; assetPattern = 'llama-.*-bin-win-cpu-x64\.zip$' }
            )
        }
    }

    if ($vendor -eq 'intel') {
        return @{
            backend = 'vulkan'
            label = 'Vulkan'
            recommended_context = $recommended.context
            recommended_gpu_layers = $recommended.gpu_layers
            releaseCandidates = @(
                @{ backend = 'vulkan'; label = 'Vulkan'; assetPattern = 'llama-.*-bin-win-vulkan-x64\.zip$' },
                @{ backend = 'cpu'; label = 'CPU'; assetPattern = 'llama-.*-bin-win-cpu-x64\.zip$' }
            )
        }
    }

    return @{
        backend = 'cpu'
        label = 'CPU'
        recommended_context = $recommended.context
        recommended_gpu_layers = $recommended.gpu_layers
        releaseCandidates = @(
            @{ backend = 'cpu'; label = 'CPU'; assetPattern = 'llama-.*-bin-win-cpu-x64\.zip$' }
        )
    }
}

function Build-LlamaCpp($plan) {
    Ensure-Directory $runtimeDir

    $releaseResult = Try-DownloadLlamaCppRelease $plan
    if ($releaseResult) {
        return $releaseResult
    }

    FAIL "Aucun binaire llama.cpp précompilé compatible trouvé pour le backend $($plan.label). Compilation native désactivée."
}

function Resolve-LlamaServerBinary([string]$buildDir) {
    $directBinary = Get-LlamaServerBinaryFromDirectory $buildDir
    if ($directBinary) {
        return $directBinary
    }

    $candidates = @(
        (Join-Path $buildDir 'bin\llama-server.exe'),
        (Join-Path $buildDir 'bin\Release\llama-server.exe')
    )

    $binary = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $binary) {
        FAIL "llama-server.exe introuvable après compilation."
    }

    return $binary
}

function Stop-LlamaServerProcess {
    $procs = Get-Process -Name 'llama-server' -ErrorAction SilentlyContinue
    if ($procs) {
        $procs | Stop-Process -Force -ErrorAction SilentlyContinue
        # Attendre libération du port
        for ($i = 0; $i -lt 20; $i++) {
            Start-Sleep -Milliseconds 500
            $still = Get-NetTCPConnection -LocalPort $llamaPort -ErrorAction SilentlyContinue
            if (-not $still) { break }
        }
    }
}

function Stop-ExistingController {
    $connections = Get-NetTCPConnection -LocalPort $controllerPort -State Listen -ErrorAction SilentlyContinue
    foreach ($conn in @($connections)) {
        Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
    }
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 500
        $still = Get-NetTCPConnection -LocalPort $controllerPort -ErrorAction SilentlyContinue
        if (-not $still) { break }
    }
}

function Ensure-ControllerRunning {
    $controllerOk = $false
    if (Wait-HttpOk -url "http://127.0.0.1:$controllerPort/health" -maxTries 1 -delay 1) {
        try {
            $currentStatus = Invoke-RestMethod -Uri "http://127.0.0.1:$controllerPort/status" -Method Get -TimeoutSec 5 -ErrorAction Stop
            $modelsMatch = [string]$currentStatus.models_dir -ieq $modelsDir
            $supportsMulti = $currentStatus.PSObject.Properties['instances'] -ne $null
            if ($modelsMatch -and $supportsMulti) {
                $controllerOk = $true
            } else {
                if (-not $modelsMatch) {
                    $reason = "chemin different ($($currentStatus.models_dir))"
                } else {
                    $reason = "format legacy (redemarrage requis)"
                }
                INFO "Contrôleur existant incompatible ($reason), redémarrage..."
                Stop-LlamaServerProcess
                Stop-ExistingController
            }
        } catch {
            Stop-LlamaServerProcess
            Stop-ExistingController
        }
    } else {
        Stop-LlamaServerProcess
    }

    if (-not $controllerOk) {
        INFO "Démarrage du contrôleur hôte"
        if (Get-Command pwsh -ErrorAction SilentlyContinue) {
            $pwshExe = 'pwsh'
        } else {
            $pwshExe = 'powershell.exe'
        }
        Start-Process $pwshExe -ArgumentList @(
            '-ExecutionPolicy', 'Bypass',
            '-File', $controllerScript,
            '-Port', $controllerPort,
            '-ConfigPath', $runtimeConfigPath,
            '-StatePath', $runtimeStatePath
        ) -WindowStyle Hidden | Out-Null
    }

    if (-not (Wait-HttpOk -url "http://127.0.0.1:$controllerPort/health" -maxTries 40 -delay 2)) {
        FAIL "Le contrôleur hôte ne répond pas."
    }

    OK "Contrôleur hôte prêt"
}

function Get-ActiveRuntimeContextConfig {
    if (-not (Test-Path $runtimeStatePath)) { return $null }

    try {
        $state = Get-Content -Path $runtimeStatePath -Raw | ConvertFrom-Json
    } catch {
        return $null
    }

    $instances = @($state.instances) | Where-Object { $_ -and $_.running -eq $true }
    if (-not $instances -or $instances.Count -eq 0) { return $null }

    $latest = $instances |
        Sort-Object {
            try { [datetime]::Parse([string]$_.started_at) } catch { [datetime]::MinValue }
        } -Descending |
        Select-Object -First 1

    if (-not $latest) { return $null }

    return @{
        context = if ($latest.context) { [int]$latest.context } else { $null }
        gpu_layers = if ($latest.gpu_layers) { [int]$latest.gpu_layers } else { $null }
    }
}

function Write-RuntimeConfig([string]$backend, [string]$backendLabel, [string]$binaryPath, [int]$recommendedContext = 8192, [int]$recommendedGpuLayers = 999) {
    $defaultContext = $recommendedContext
    $defaultGpuLayers = 0

    if ($backend -ne 'cpu') { $defaultGpuLayers = $recommendedGpuLayers }

    $stateConfig = Get-ActiveRuntimeContextConfig
    if ($stateConfig) {
        if ($stateConfig.context -and $stateConfig.context -gt 0) {
            $defaultContext = $stateConfig.context
        }
        if ($backend -ne 'cpu' -and $stateConfig.gpu_layers -and $stateConfig.gpu_layers -gt 0) {
            $defaultGpuLayers = $stateConfig.gpu_layers
        }
    }

    $config = @{
        controller_port = $controllerPort
        server_port = $llamaPort
        backend = $backend
        backend_label = $backendLabel
        binary_path = $binaryPath
        models_dir = $modelsDir
        proxy_model_id = 'lia-local'
        default_context = $defaultContext
        default_gpu_layers = $defaultGpuLayers
        sleep_idle_seconds = 60
        server_port_start = 12434
        server_port_end = 12444
        max_instances = 6
    }

    $config | ConvertTo-Json -Depth 5 | Set-Content -Path $runtimeConfigPath -Encoding UTF8
}

function Get-DefaultModelFromState {
    if (-not (Test-Path $runtimeStatePath)) {
        return $null
    }

    try {
        $state = Get-Content -Path $runtimeStatePath -Raw | ConvertFrom-Json
    } catch {
        return $null
    }

    $instances = @($state.instances) | Where-Object {
        $_ -and $_.filename -and ($_.running -ne $false)
    }

    if (-not $instances -or $instances.Count -eq 0) {
        return $null
    }

    $latestInstance = $instances |
        Sort-Object {
            try {
                [datetime]::Parse([string]$_.started_at)
            } catch {
                [datetime]::MinValue
            }
        } -Descending |
        Select-Object -First 1

    if (-not $latestInstance) {
        return $null
    }

    return [string]$latestInstance.filename
}

function Get-DefaultModel {
    $stateModel = Get-DefaultModelFromState
    if ($stateModel) {
        return $stateModel
    }

    $candidateModels = Get-ChildItem -Path $modelsDir -Filter *.gguf -File -ErrorAction SilentlyContinue |
        Where-Object { $_.BaseName -notmatch 'deepseek' } |
        Sort-Object Length, Name

    $smallestModel = $candidateModels | Select-Object -First 1
    if (-not $smallestModel) {
        return $null
    }

    return $smallestModel.Name
}

function Start-DefaultRuntime {
    $defaultModel = Get-DefaultModel
    if (-not $defaultModel) {
        WARN "Aucun modèle GGUF détecté. Le runtime restera inactif jusqu’au premier import."
        return
    }

    INFO "Chargement initial : $defaultModel"
    $payload = @{ model = $defaultModel } | ConvertTo-Json
    Invoke-RestMethod -Uri "http://127.0.0.1:$controllerPort/start" -Method Post -Body $payload -ContentType 'application/json' | Out-Null

    if (-not (Wait-HttpOk -url "http://127.0.0.1:$llamaPort/v1/models" -maxTries 30 -delay 2)) {
        WARN "llama-server ne répond pas encore. Le Model Loader permettra de relancer un modèle."
    } else {
        OK "llama-server répond sur http://127.0.0.1:$llamaPort/v1"
    }
}

function Ensure-WindowsFirewallRuleForDockerPorts {
    param(
        [string[]]$Ports = @('12434-12444','13579','3002','13610'),
        [string]$RuleName = 'LIA Allow Docker Runtime Access'
    )

    try {
        $existingRule = Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue
        if ($existingRule) {
            Set-NetFirewallRule -DisplayName $RuleName -Enabled True -Profile Any -Action Allow | Out-Null
            return
        }

        New-NetFirewallRule -DisplayName $RuleName `
            -Direction Inbound `
            -Action Allow `
            -Protocol TCP `
            -LocalPort ($Ports -join ',') `
            -Profile Any `
            -Description 'Autorise le trafic Docker vers les ports du runtime LIA et du contrôleur.' `
            -Enabled True | Out-Null
    } catch {
        WARN "Impossible de créer ou de mettre à jour la règle pare-feu Windows pour Docker : $($_.Exception.Message)"
    }
}

function Ensure-DockerNetwork([string]$name) {
    docker network inspect $name *> $null
    if ($LASTEXITCODE -ne 0) {
        docker network create $name | Out-Null
        if ($LASTEXITCODE -ne 0) {
            FAIL "Création du réseau Docker impossible : $name"
        }
    }

    OK "Réseau Docker $name prêt"
}

function Remove-Container([string]$name) {
    docker stop $name 2>$null | Out-Null
    docker rm $name 2>$null | Out-Null
}

function Ensure-ContainerOnNetwork([string]$name, [string]$network) {
    $inspect = docker inspect $name --format '{{json .NetworkSettings.Networks}}' 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $inspect) {
        return
    }

    try {
        $networkState = $inspect | ConvertFrom-Json
    } catch {
        return
    }

    $attachedNetworks = @($networkState.PSObject.Properties.Name)

    if ($attachedNetworks -notcontains $network) {
        docker network connect $network $name | Out-Null
        if ($LASTEXITCODE -ne 0) {
            FAIL "Impossible de rattacher $name au réseau Docker $network."
        }
    }
}


function Start-LibreChatContainer {
    Remove-Container 'librechat'

    $existing = docker inspect librechat 2>&1
    if ($LASTEXITCODE -eq 0) {
        $state = $existing | ConvertFrom-Json
        if ($state[0].State.Running -eq $true -and $state[0].State.Status -eq 'running') {
            OK "LibreChat déjà en fonctionnement"
            return
        }
        Remove-Container 'librechat'
    }

    # Démarrer MongoDB requis pour LibreChat
    Remove-Container 'librechat-mongo'
    docker run -d `
        --name librechat-mongo `
        --network $dockerNetwork `
        -v librechat-mongo:/data/db `
        --restart unless-stopped `
        mongo:6

    # Build de l'image LibreChat personnalisée LIA avec configuration préintégrée
    docker build -t lia-librechat -f "$rootDir\Dockerfiles\Dockerfile.librechat" $rootDir
    if ($LASTEXITCODE -ne 0) {
        FAIL "Build du conteneur LibreChat impossible."
    }

    $args = @(
        'run', '-d',
        '--name', 'librechat',
        '--network', $dockerNetwork,
        '-p', ("{0}:{1}" -f $libreChatPort, $libreChatInternalPort),
        '--add-host', 'host.docker.internal:host-gateway',
        '-v', 'librechat-data:/app/api/data',
        '--restart', 'unless-stopped',
        'lia-librechat'
    )

    docker @args | Out-Null
    if ($LASTEXITCODE -ne 0) {
        FAIL "Démarrage LibreChat impossible."
    }

    if (-not (Wait-HttpOk -url "http://127.0.0.1:$libreChatPort" -maxTries 40 -delay 3)) {
        WARN "LibreChat met plus de temps à répondre."
    } else {
        OK "LibreChat prêt sur http://localhost:$libreChatPort"
    }
}

function Start-ModelLoaderContainer {
    Ensure-WindowsFirewallRuleForDockerPorts

    Start-HostMetricsService

    Remove-Container 'model-loader'

    docker build -t $modelLoaderImage -f "$rootDir\Dockerfiles\Dockerfile.model-loader" $rootDir
    if ($LASTEXITCODE -ne 0) {
        FAIL "Build du conteneur Model Loader impossible."
    }

    $existing = docker inspect model-loader 2>&1
    if ($LASTEXITCODE -eq 0) {
        $state = $existing | ConvertFrom-Json
        if ($state[0].State.Running -eq $true -and $state[0].State.Status -eq 'running') {
            OK "Model Loader déjà en fonctionnement"
            return
        }
        Remove-Container 'model-loader'
    }

    $modelMountArg = "type=bind,source=$modelsDir,target=/models"
    $runtimeMountArg = "type=bind,source=$runtimeDir,target=/runtime,readonly"

    $args = @(
        'run', '-d',
        '--name', 'model-loader',
        '--network', $dockerNetwork,
        '-p', ("{0}:3002" -f $loaderPort),
        '--add-host', 'host.docker.internal:host-gateway',
        '-e', ("LLAMA_HOST_CONTROL_URL=http://host.docker.internal:{0}" -f $controllerPort),
        '-e', ("LLAMA_SERVER_BASE_URL=http://host.docker.internal:{0}" -f $llamaPort),
        '-e', 'MODEL_STORAGE_DIR=/models',
        '-e', 'RUNTIME_STATE_PATH=/runtime/host-runtime-state.json',
        '-e', 'PROXY_MODEL_ID=lia-local',
        '--mount', $modelMountArg,
        '--mount', $runtimeMountArg,
        '--restart', 'unless-stopped',
        '--health-cmd', 'curl -fsS http://localhost:3002/health > /dev/null || exit 1',
        '--health-interval', '15s',
        '--health-timeout', '3s',
        '--health-retries', '2',
        $modelLoaderImage
    )

    docker @args | Out-Null
    if ($LASTEXITCODE -ne 0) {
        FAIL "Démarrage du conteneur Model Loader impossible."
    }

    Ensure-ContainerOnNetwork 'model-loader' $dockerNetwork

    if (-not (Wait-HttpOk -url "http://127.0.0.1:$loaderPort/health" -maxTries 30 -delay 2)) {
        FAIL "Le Model Loader ne répond pas."
    }

    $inspectionRaw = docker inspect model-loader 2>&1
    if ($LASTEXITCODE -ne 0) {
        FAIL "Impossible d'inspecter le conteneur model-loader après démarrage."
    }

    $inspection = $inspectionRaw | ConvertFrom-Json
    $mounts = @($inspection[0].Mounts)
    $modelsDirResolved = (Resolve-Path -LiteralPath $modelsDir).Path

    $modelsMountOk = $false
    foreach ($mount in $mounts) {
        if ($mount.Destination -ne '/models') { continue }
        if ($mount.Type -ne 'bind') { continue }
        $source = [string]$mount.Source
        if ($source -eq $modelsDirResolved -or $source -eq $modelsDir) {
            $modelsMountOk = $true
            break
        }
    }

    if (-not $modelsMountOk) {
        FAIL "Mount /models invalide: bind mount vers '$modelsDirResolved' absent."
    }

    OK "Model Loader prêt sur http://localhost:$loaderPort"
}

function Start-AnythingLLMContainer {
    Remove-Container 'anythingllm'

    $existing = docker inspect anythingllm 2>&1
    if ($LASTEXITCODE -eq 0) {
        $state = $existing | ConvertFrom-Json
        if ($state[0].State.Running -eq $true -and $state[0].State.Status -eq 'running') {
            OK "AnythingLLM déjà en fonctionnement"
            return
        }
        Remove-Container 'anythingllm'
    }

    # Build de l'image AnythingLLM personnalisée LIA avec configuration préintégrée
    docker build -t lia-anythingllm -f "$rootDir\Dockerfiles\Dockerfile.anythingllm" $rootDir
    if ($LASTEXITCODE -ne 0) {
        FAIL "Build du conteneur AnythingLLM impossible."
    }

    $args = @(
        'run', '-d',
        '--name', 'anythingllm',
        '--network', $dockerNetwork,
        '-p', ("{0}:3001" -f $anythingPort),
        '--add-host', 'host.docker.internal:host-gateway',
        '-v', 'anythingllm-storage:/app/server/storage',
        '--restart', 'unless-stopped',
        'lia-anythingllm'
    )

    docker @args | Out-Null
    if ($LASTEXITCODE -ne 0) {
        FAIL "Démarrage AnythingLLM impossible."
    }

    if (-not (Wait-HttpOk -url "http://127.0.0.1:$anythingPort" -maxTries 40 -delay 3)) {
        WARN "AnythingLLM met plus de temps à répondre."
    } else {
        OK "AnythingLLM prêt sur http://localhost:$anythingPort"
    }
}

function Start-OpenWebUiContainer {
    Remove-Container 'open-webui'

    $existing = docker inspect open-webui 2>&1
    if ($LASTEXITCODE -eq 0) {
        $state = $existing | ConvertFrom-Json
        if ($state[0].State.Running -eq $true -and $state[0].State.Status -eq 'running') {
            OK "Open WebUI déjà en fonctionnement"
            return
        }
        Remove-Container 'open-webui'
    }

    # Build de l'image Open WebUI personnalisée LIA avec configuration préintégrée
    docker build -t lia-openwebui -f "$rootDir\Dockerfiles\Dockerfile.openwebui" $rootDir
    if ($LASTEXITCODE -ne 0) {
        FAIL "Build du conteneur Open WebUI impossible."
    }

    $args = @(
        'run', '-d',
        '--name', 'open-webui',
        '--network', $dockerNetwork,
        '-p', ("{0}:8080" -f $openWebUiPort),
        '--add-host', 'host.docker.internal:host-gateway',
        '-v', 'open-webui-data:/app/backend/data',
        '--restart', 'unless-stopped',
        'lia-openwebui'
    )

    docker @args | Out-Null
    if ($LASTEXITCODE -ne 0) {
        FAIL "Démarrage Open WebUI impossible."
    }

    if (-not (Wait-HttpOk -url "http://127.0.0.1:$openWebUiPort" -maxTries 40 -delay 3)) {
        WARN "Open WebUI met plus de temps à répondre."
    } else {
        OK "Open WebUI prêt sur http://localhost:$openWebUiPort"
    }
}


# S'assure que le réseau Docker existe avant tout lancement
Ensure-DockerNetwork $dockerNetwork

Ensure-Directory $runtimeDir
Ensure-Directory $modelsDir
Normalize-RuntimeConfig

Step "1/6" "Choix interface"
$interfaceChoice = Get-InterfaceChoice
OK "Selection utilisateur enregistree"

Step "2/6" "Preparation outils Windows"
if (-not (Confirm-Command "winget")) {
    FAIL "winget est requis sur cette machine Windows."
}

if (-not (Confirm-Command "docker")) {
    INFO "Installation Docker Desktop"
    winget install --id Docker.DockerDesktop -e --silent --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -ne 0) {
        FAIL "Installation Docker Desktop impossible."
    }
    FAIL "Docker Desktop a ete installe. Relance le script apres demarrage de Docker."
}

try {
    docker info 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw
    }
} catch {
    FAIL "Docker Desktop n'est pas demarre."
}

OK "Docker operationnel"

Step "3/6" "Detection materiel et preparation llama.cpp"
$hardware = Get-HardwareProfile
$plan = Get-BackendPlan $hardware
Save-HardwareProfile -profile $hardware
INFO "Materiel detecte : $($hardware.label)"
if ($hardware.cpu) {
    INFO "CPU detecte : $($hardware.cpu.model) | cores physiques : $($hardware.cpu.physical_cores) | threads : $($hardware.cpu.logical_processors)"
}
if ($hardware.memory) {
    $GB = 1024 * 1024 * 1024
    INFO "RAM detectee : $([math]::Round($hardware.memory.total_bytes / $GB, 2)) Go"
}
INFO "Backend cible : $($plan.label)"

$buildResult = Build-LlamaCpp $plan
$llamaServerBinary = $buildResult.binaryPath
if (-not $llamaServerBinary) { $llamaServerBinary = Resolve-LlamaServerBinary $buildResult.buildDir }
Write-RuntimeConfig -backend $buildResult.backend -backendLabel $buildResult.label -binaryPath $llamaServerBinary -recommendedContext $plan.recommended_context -recommendedGpuLayers $plan.recommended_gpu_layers
if ($buildResult.source -eq 'release') {
    OK "llama.cpp prepare via binaire officiel avec backend $($buildResult.label)"
} else {
    OK "llama.cpp compile avec backend $($buildResult.label)"
}

Step "4/6" "Controleur hote et runtime"
Ensure-ControllerServiceInstalled
Start-HostMetricsService
Ensure-ControllerRunning
Start-DefaultRuntime

Step "5/6" "Conteneurs applicatifs"
Ensure-DockerNetwork $dockerNetwork
Start-ModelLoaderContainer

    switch ($interfaceChoice) {
        "1" { Start-OpenWebUiContainer }
        "2" { Start-AnythingLLMContainer }
        "3" { Start-LibreChatContainer }
        "4" {
            Start-AnythingLLMContainer
            Start-OpenWebUiContainer
            Start-LibreChatContainer
        }
    }

Step "6/6" "Ouverture navigateur"
$tabs = @("http://localhost:$loaderPort")
if ($interfaceChoice -in @("2", "4")) {
    $tabs += "http://localhost:$anythingPort"
}
if ($interfaceChoice -in @("1", "4")) {
    $tabs += "http://localhost:$openWebUiPort"
}
if ($interfaceChoice -in @("3", "4")) {
    $tabs += "http://localhost:$libreChatPort"
}

Open-Tabs $tabs

$sep = "=" * 64
Write-Host "`n  $sep" -ForegroundColor Cyan
Write-Host "  STACK LLAMA.CPP PRETE" -ForegroundColor Green
Write-Host "  $sep" -ForegroundColor Cyan
Write-Host "  Model Loader -> http://localhost:$loaderPort" -ForegroundColor White
if ($interfaceChoice -in @("2", "3")) {
    Write-Host "  AnythingLLM  -> http://localhost:$anythingPort" -ForegroundColor White
}
if ($interfaceChoice -in @("1", "4")) {
    Write-Host "  Open WebUI   -> http://localhost:$openWebUiPort" -ForegroundColor White
}
if ($interfaceChoice -in @("3", "4")) {
    Write-Host "  LibreChat    -> http://localhost:$libreChatPort" -ForegroundColor White
}

