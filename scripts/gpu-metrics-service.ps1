$ErrorActionPreference = 'Stop'

# Default port for the GPU metrics service
$Port = 13620

# ============================================================
# Collecte GPU - Windows Performance Counters (fiable)
# ============================================================

$repoRoot = Split-Path -Parent $PSScriptRoot
$toolsDir = Join-Path $repoRoot 'tools'

# ============================================================
# FALLBACK : Compteurs Windows améliorés
# ============================================================

function Get-GpuMetricsFromCounters {
    $gpuInfoList = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue
    if (-not $gpuInfoList) { return $null }

    # Valeurs par défaut
    $maxGpuLoad = 0
    $dedicatedMemoryUsed = 0

    # Essayer de récupérer rapidement l'utilisation GPU (timeout court)
    try {
        $gpuEngines = Get-Counter '\GPU Engine(*)\Utilization Percentage' -ErrorAction Stop
        if ($gpuEngines -and $gpuEngines.CounterSamples) {
            $maxGpuLoad = [math]::Round(($gpuEngines.CounterSamples | Measure-Object -Property CookedValue -Maximum).Maximum, 1)
        }
    } catch {}

    # Essayer de récupérer la mémoire GPU
    try {
        $memoryCounters = Get-Counter '\GPU Process Memory(*)\Dedicated Usage' -ErrorAction Stop
        if ($memoryCounters -and $memoryCounters.CounterSamples) {
            $dedicatedMemoryUsed = [int64]($memoryCounters.CounterSamples | Measure-Object -Property CookedValue -Maximum).Maximum
        } elseif (-not $dedicatedMemoryUsed) {
            $adapterCounters = Get-Counter '\GPU Adapter Memory(*)\Dedicated Usage' -ErrorAction Stop
            if ($adapterCounters -and $adapterCounters.CounterSamples) {
                $dedicatedMemoryUsed = [int64]($adapterCounters.CounterSamples | Measure-Object -Property CookedValue -Maximum).Maximum
            }
        }
    } catch {}

    $result = @()
    $index = 0
    foreach ($gpuInfo in $gpuInfoList) {
        $loadPercent = if ($index -eq 0 -and $maxGpuLoad) { $maxGpuLoad } else { 0 }
        $vramUsed = if ($index -eq 0 -and $dedicatedMemoryUsed) { [int64]$dedicatedMemoryUsed } else { 0 }

        $vendor = 'SYSTEM'
        if ($gpuInfo.Name -match 'NVIDIA|GeForce|Quadro|RTX|GTX') { $vendor = 'NVIDIA' }
        elseif ($gpuInfo.Name -match 'Radeon|AMD|ATI|FirePro') { $vendor = 'AMD' }
        elseif ($gpuInfo.Name -match 'Intel|Arc|Iris|UHD|Xe') { $vendor = 'INTEL' }

        $result += [ordered]@{
            Name = $gpuInfo.Name
            Vendor = $vendor
            LoadPercent = $loadPercent
            AdapterRAMBytes = $gpuInfo.AdapterRAM
            VramUsedBytes = $vramUsed
            TemperatureCelsius = $null
            PowerDrawWatts = $null
            DriverVersion = $gpuInfo.DriverVersion
            Source = 'WindowsCounters'
        }

        $index++
    }

    return $result
}

# ============================================================
# MÉTRIQUES SYSTÈME
# ============================================================

function Get-PerformanceMetrics {
    $cpu = Get-CimInstance Win32_PerfFormattedData_Counters_ProcessorInformation -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -notmatch '_Total' } |
            Select-Object Name, PercentProcessorTime, ProcessorFrequency

    $cpuTotal = Get-CimInstance Win32_PerfFormattedData_Counters_ProcessorInformation -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -eq '_Total' } |
                Select-Object -First 1

    $mem = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
    $memPerf = Get-CimInstance Win32_PerfFormattedData_Counters_Memory -ErrorAction SilentlyContinue

    # Collecte GPU - Windows Counters uniquement (fiable)
    $gpuMetricsList = Get-GpuMetricsFromCounters

    $cpuTotalLoad = if ($cpuTotal -and $cpuTotal.PercentProcessorTime) { [int]$cpuTotal.PercentProcessorTime } else { 0 }

    return [ordered]@{
        CPU = [ordered]@{
            TotalLoadPercent = $cpuTotalLoad
            Cores = $cpu | ForEach-Object {
                [ordered]@{
                    CoreId = $_.Name
                    LoadPercent = [int]$_.PercentProcessorTime
                    FrequencyMHz = [int]$_.ProcessorFrequency
                }
            }
        }
        Memory = [ordered]@{
            TotalBytes = [int64]$mem.TotalVisibleMemorySize * 1024
            UsedBytes = ([int64]$mem.TotalVisibleMemorySize - [int64]$mem.FreePhysicalMemory) * 1024
            FreeBytes = [int64]$mem.FreePhysicalMemory * 1024
            UsedPercent = [math]::Round((1 - ($mem.FreePhysicalMemory / $mem.TotalVisibleMemorySize)) * 100, 1)
        }
        GPUs = $gpuMetricsList
    }
}

function Get-SystemMetrics {
    $os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
    $cpuInfo = Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue | Select-Object -First 1

    $memoryTotalBytes = 0
    $memoryFreeBytes = 0
    $cpuSpeed = 0

    if ($os) {
        $memoryTotalBytes = if ($os.TotalVisibleMemorySize) { [int64]$os.TotalVisibleMemorySize * 1024 } else { 0 }
        $memoryFreeBytes = if ($os.FreePhysicalMemory) { [int64]$os.FreePhysicalMemory * 1024 } else { 0 }
    }

    if ($cpuInfo) {
        $cpuSpeed = if ($cpuInfo.MaxClockSpeed) { [int]$cpuInfo.MaxClockSpeed } else { 0 }
    }

    return [ordered]@{
        OS = [ordered]@{
            Caption = if ($os) { $os.Caption } else { $null }
            Version = if ($os) { $os.Version } else { $null }
            BuildNumber = if ($os) { $os.BuildNumber } else { $null }
        }
        CPU = [ordered]@{
            Name = if ($cpuInfo) { $cpuInfo.Name } else { $null }
            Cores = if ($cpuInfo -and $cpuInfo.NumberOfCores) { [int]$cpuInfo.NumberOfCores } else { 0 }
            LogicalProcessors = if ($cpuInfo -and $cpuInfo.NumberOfLogicalProcessors) { [int]$cpuInfo.NumberOfLogicalProcessors } else { 0 }
            MaxClockSpeedMHz = $cpuSpeed
        }
        Memory = [ordered]@{
            TotalBytes = $memoryTotalBytes
            FreeBytes = $memoryFreeBytes
            UsedBytes = ($memoryTotalBytes - $memoryFreeBytes)
        }
    }
}

function Write-Response {
    param(
        [System.Net.HttpListenerResponse]$Response,
        [int]$StatusCode,
        [object]$Body
    )

    $Response.AddHeader("Access-Control-Allow-Origin", "*")
    $Response.AddHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    $Response.AddHeader("Access-Control-Allow-Headers", "*")

    $Response.StatusCode = $StatusCode
    $Response.ContentType = 'application/json; charset=utf-8'
    $json = $Body | ConvertTo-Json -Depth 10
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $Response.ContentLength64 = $bytes.Length
    $Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $Response.OutputStream.Close()
}

function Get-HardwareProfile {
    $rootDir = Split-Path -Parent $PSScriptRoot
    $hardwareProfilePath = Join-Path $rootDir 'runtime\hardware-profile.json'
    if (-not (Test-Path $hardwareProfilePath)) {
        return $null
    }

    try {
        return Get-Content -Path $hardwareProfilePath -Raw | ConvertFrom-Json
    } catch {
        return $null
    }
}

function Determine-GpuTypeFromProfile([psobject]$profile) {
    if (-not $profile -or -not $profile.vendor) {
        return 'SYSTEM'
    }

    switch ($profile.vendor.ToString().ToLower()) {
        'nvidia' { return 'NVIDIA' }
        'amd' { return 'AMD' }
        'intel' { return 'INTEL' }
        default { return 'SYSTEM' }
    }
}

$listenHost = '127.0.0.1'
$port = $Port
$prefix = "http://${listenHost}:${port}/"

# Vérifier si le port est déjà utilisé
try {
    $portCheck = netstat -ano | Select-String ":${port}\s"
    if ($portCheck) {
        Write-Error "Le port ${port} est déjà utilisé. Veuillez spécifier un port différent avec -Port."
        Write-Error "Processus utilisant le port : $($portCheck | Out-String)"
        exit 1
    }
} catch {
    Write-Warning "Impossible de vérifier l'utilisation du port : $($_.Exception.Message)"
}

$listener = New-Object System.Net.HttpListener
try {
    $listener.Prefixes.Add($prefix)
    $listener.Start()
    Write-Host "LIA GPU metrics service démarré sur $prefix"
} catch {
    Write-Error "Échec du démarrage du service LIA GPU Metrics : $($_.Exception.Message)"
    Write-Error "Assurez-vous d'exécuter le script avec des privilèges administrateurs si le port < 1024"
    Write-Error "Pour utiliser un port différent, exécutez : .\gpu-metrics-service.ps1 -Port <NUMERO_PORT>"
    exit 1
}

while ($true) {
    $context = $listener.GetContext()
    try {
        $request = $context.Request
        $response = $context.Response

        if ($request.HttpMethod -eq 'OPTIONS') {
            Write-Response -Response $response -StatusCode 200 -Body $null
            continue
        }

        if ($request.HttpMethod -ne 'GET') {
            Write-Response -Response $response -StatusCode 405 -Body @{ error = 'Method not allowed' }
            continue
        }

        switch ($request.Url.AbsolutePath) {
            '/metrics/host' {
                $hardwareProfile = Get-HardwareProfile
                $gpuType = Determine-GpuTypeFromProfile $hardwareProfile
                $detection = [ordered]@{
                    source = 'hardware-profile'
                    vendor = $hardwareProfile?.vendor
                    label = $hardwareProfile?.label
                }

                $systemMetrics = Get-SystemMetrics
                $performanceMetrics = Get-PerformanceMetrics

                $hostMetrics = [ordered]@{
                    source = 'hardware-monitor-host'
                    gpuType = $gpuType
                    detection = $detection
                    metrics = $performanceMetrics
                    system = $systemMetrics
                    timestamp = (Get-Date).ToString('o')
                }

                Write-Response -Response $response -StatusCode 200 -Body $hostMetrics
            }
            default {
                Write-Response -Response $response -StatusCode 404 -Body @{ error = 'Endpoint introuvable' }
            }
        }
    } catch {
        $errorResponse = @{ error = $_.Exception.Message }
        Write-Response -Response $context.Response -StatusCode 500 -Body $errorResponse
    }
}