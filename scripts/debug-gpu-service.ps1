$ErrorActionPreference = 'Stop'

# Debug version of GPU metrics service
$Port = 13620
$logPath = "C:\Windows\Temp\gpu-metrics-debug.log"

function Write-DebugLog {
    param([string]$message)
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -Path $logPath -Value "[$timestamp] $message"
}

Write-DebugLog "GPU Metrics Service starting..."

# ============================================================
# HW-SMI (ProjectPhysX) - Priorité principale
# ============================================================

$repoRoot = Split-Path -Parent $PSScriptRoot
$toolsDir = Join-Path $repoRoot 'tools'
$hwSmiPath = Join-Path $toolsDir 'hw-smi\hw-smi.exe'

function Get-GpuMetricsFromHwSmi {
    if (-not (Test-Path $hwSmiPath)) {
        Write-DebugLog "hw-smi.exe not found at $hwSmiPath"
        return $null
    }

    try {
        Write-DebugLog "Running hw-smi and parsing text output..."
        $output = & $hwSmiPath 2>$null | Out-String
        if ($LASTEXITCODE -ne 0) {
            Write-DebugLog "hw-smi.exe returned exit code $LASTEXITCODE"
            return $null
        }

        $gpuMetrics = Parse-HwSmiTextOutput $output
        if ($gpuMetrics -and $gpuMetrics.Count -gt 0) {
            Write-DebugLog "hw-smi parsed $($gpuMetrics.Count) GPUs from text output"
            return $gpuMetrics
        } else {
            Write-DebugLog "No GPUs parsed from hw-smi text output"
            return $null
        }
    } catch {
        Write-DebugLog "hw-smi text parsing failed: $($_.Exception.Message)"
        return $null
    }
}

function Parse-HwSmiTextOutput {
    param([string]$output)

    if (-not $output) {
        Write-DebugLog "No output from hw-smi"
        return $null
    }

    $lines = $output -split "`n"
    $gpuData = @{}
    $currentGpuIndex = -1

    foreach ($line in $lines) {
        $line = $line.Trim()

        # Détecter le début d'une section GPU
        if ($line -match '^GPU \[(.+)\]$') {
            $currentGpuIndex++
            $gpuName = $matches[1]
            $gpuData[$currentGpuIndex] = @{
                Name = $gpuName
                Vendor = if ($gpuName -match 'NVIDIA') { 'NVIDIA' } elseif ($gpuName -match 'AMD|Radeon') { 'AMD' } elseif ($gpuName -match 'Intel|Arc') { 'INTEL' } else { 'GPU' }
                LoadPercent = $null
                MemoryTotalBytes = $null
                MemoryUsedBytes = $null
                TemperatureCelsius = $null
                PowerDrawWatts = $null
                DriverVersion = ''
                Source = 'hw-smi-text'
            }
            continue
        }

        # Parser les métriques avec pourcentages
        if ($line -match '^Usage \[.+\s+(\d+)%\]$') {
            if ($currentGpuIndex -ge 0) {
                $gpuData[$currentGpuIndex].LoadPercent = [double]$matches[1]
            }
        }

        if ($line -match '^VRAM \[.+\s+(\d+) / (\d+) MB\]') {
            if ($currentGpuIndex -ge 0) {
                $gpuData[$currentGpuIndex].MemoryUsedBytes = [int64]$matches[1] * 1024 * 1024
                $gpuData[$currentGpuIndex].MemoryTotalBytes = [int64]$matches[2] * 1024 * 1024
            }
        }

        if ($line -match '^Temp \[.+\s+(\d+)°C\]') {
            if ($currentGpuIndex -ge 0) {
                $gpuData[$currentGpuIndex].TemperatureCelsius = [double]$matches[1]
            }
        }

        if ($line -match '^Power \[.+\s+(\d+) / (\d+) W\]') {
            if ($currentGpuIndex -ge 0) {
                $gpuData[$currentGpuIndex].PowerDrawWatts = [double]$matches[1]
            }
        }

        if ($line -match '^Clock \[.+\s+(\d+) / (\d+) MHz\]') {
            if ($currentGpuIndex -ge 0 -and -not $gpuData[$currentGpuIndex].CoreClockMhz) {
                $gpuData[$currentGpuIndex].CoreClockMhz = [int]$matches[1]
            }
        }

        if ($line -match '^Mem Clk \[.+\s+(\d+)\|\s*(\d+) MHz\]') {
            if ($currentGpuIndex -ge 0) {
                $gpuData[$currentGpuIndex].MemoryClockMhz = [int]$matches[1]
            }
        }
    }

    return [array]$gpuData.Values
}

# ============================================================
# FALLBACK : Compteurs Windows
# ============================================================

function Get-GpuMetricsFromCounters {
    Write-DebugLog "Getting GPU metrics from Windows counters..."
    $gpuInfoList = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue
    if (-not $gpuInfoList) {
        Write-DebugLog "No GPU info from CIM"
        return $null
    }

    Write-DebugLog "Found $($gpuInfoList.Count) GPUs from CIM"

    $gpuLoads = @{}

    try {
        $gpuEngines = Get-Counter '\GPU Engine(*)\Utilization Percentage' -ErrorAction SilentlyContinue
        if ($gpuEngines) {
            foreach ($sample in $gpuEngines.CounterSamples) {
                $instance = $sample.InstanceName
                $luid = 'default'
                if ($instance -match 'phys_(\d+)') {
                    $luid = "phys_$($matches[1])"
                }

                if ($instance -match 'engtype_(3D|Compute|Copy|VideoDecode|VideoEncode|Cuda)') {
                    $engineType = $matches[1]
                    $value = [double]$sample.CookedValue
                    $percent = if ($value -gt 100) { $value } else { $value * 100.0 }

                    if (-not $gpuLoads.ContainsKey($luid)) {
                        $gpuLoads[$luid] = @{ MaxPercent = 0.0; Engines = @{} }
                    }

                    $gpuLoads[$luid].Engines[$engineType] = $percent
                    if ($percent -gt $gpuLoads[$luid].MaxPercent) {
                        $gpuLoads[$luid].MaxPercent = $percent
                    }
                }
            }
        }
    } catch {
        Write-DebugLog "Failed to get GPU engine counters: $($_.Exception.Message)"
    }

    $result = @()
    $index = 0
    foreach ($gpuInfo in $gpuInfoList) {
        $luid = "phys_$index"
        $load = $null

        if ($gpuLoads.ContainsKey($luid)) {
            $load = [math]::Round($gpuLoads[$luid].MaxPercent, 1)
        } elseif ($gpuLoads.Count -gt 0) {
            $firstKey = $gpuLoads.Keys | Select-Object -First 1
            $load = [math]::Round($gpuLoads[$firstKey].MaxPercent, 1)
        }

        $vendor = 'SYSTEM'
        if ($gpuInfo.Name -match 'NVIDIA|GeForce|Quadro|RTX|GTX') { $vendor = 'NVIDIA' }
        elseif ($gpuInfo.Name -match 'Radeon|AMD|ATI|FirePro') { $vendor = 'AMD' }
        elseif ($gpuInfo.Name -match 'Intel|Arc|Iris|UHD|Xe') { $vendor = 'INTEL' }

        $result += @{
            Name = $gpuInfo.Name
            Vendor = $vendor
            LoadPercent = $load
            AdapterRAMBytes = $gpuInfo.AdapterRAM
            VramUsedBytes = $null
            TemperatureCelsius = $null
            PowerDrawWatts = $null
            DriverVersion = $gpuInfo.DriverVersion
            Source = 'WindowsCounters'
        }

        $index++
    }

    Write-DebugLog "Windows counters found $($result.Count) GPUs"
    return $result
}

Write-DebugLog "Testing GPU metrics collection..."
$gpuMetrics = Get-GpuMetricsFromHwSmi

# If hw-smi failed, try Windows counters
if (-not $gpuMetrics -or $gpuMetrics.Count -eq 0) {
    Write-DebugLog "Trying Windows counters fallback..."
    $gpuMetrics = Get-GpuMetricsFromCounters
}

Write-DebugLog "GPU Metrics Service starting..."

# ============================================================
# MODULE HardwareMonitor (LibreHardwareMonitor)
# ============================================================

$repoRoot = Split-Path -Parent $PSScriptRoot
$toolsDir = Join-Path $repoRoot 'tools'
$moduleName = 'HardwareMonitor'

function Ensure-Directory([string]$path) {
    if (-not (Test-Path $path)) {
        New-Item -ItemType Directory -Path $path -Force | Out-Null
    }
}

function Get-HardwareMonitorModulePath {
    return Join-Path $toolsDir 'HardwareMonitor'
}

function Download-HardwareMonitorModule {
    Write-DebugLog "Downloading HardwareMonitor module..."
    Ensure-Directory $toolsDir
    $moduleDir = Get-HardwareMonitorModulePath
    Ensure-Directory $moduleDir

    $baseUrl = 'https://raw.githubusercontent.com/Lifailon/PowerShell.HardwareMonitor/rsa/Module/HardwareMonitor/0.4'
    $files = @('HardwareMonitor.psd1', 'HardwareMonitor.psm1')

    foreach ($file in $files) {
        $target = Join-Path $moduleDir $file
        if (-not (Test-Path $target)) {
            Write-DebugLog "Downloading $file..."
            try {
                Invoke-WebRequest -Uri "$baseUrl/$file" -OutFile $target -TimeoutSec 60
            } catch {
                Write-DebugLog "Failed to download $file : $($_.Exception.Message)"
            }
        }
    }

    return $moduleDir
}

function Import-HardwareMonitorModule {
    Write-DebugLog "Attempting to import HardwareMonitor module..."
    if (Get-Module -ListAvailable -Name $moduleName) {
        Write-DebugLog "Module found in PSModulePath, importing..."
        Import-Module -Name $moduleName -ErrorAction Stop | Out-Null
        Write-DebugLog "Module imported successfully"
        return $true
    }

    $moduleDir = Get-HardwareMonitorModulePath
    if (Test-Path $moduleDir) {
        Write-DebugLog "Module directory exists, importing from $moduleDir..."
        try {
            Import-Module -Name $moduleDir -ErrorAction Stop | Out-Null
            Write-DebugLog "Module imported from local directory"
            return $true
        } catch {
            Write-DebugLog "Local import failed: $($_.Exception.Message)"
        }
    }

    Write-DebugLog "Module not available"
    return $false
}

function Ensure-HardwareMonitorModule {
    Write-DebugLog "Ensuring HardwareMonitor module is available..."
    if (Import-HardwareMonitorModule) { return $true }
    Write-DebugLog 'HardwareMonitor unavailable. GPU metrics will not be available.'
    return $false
}

Write-DebugLog "Testing module loading..."
$hwMonitorAvailable = Ensure-HardwareMonitorModule

function Get-HardwareMonitorSensors {
    Write-DebugLog "Getting hardware monitor sensors..."
    if (-not (Ensure-HardwareMonitorModule)) {
        Write-DebugLog "HardwareMonitor not available"
        return @()
    }

    try {
        if (-not (Get-Command -Name Get-Sensor -ErrorAction SilentlyContinue)) {
            Write-DebugLog "Get-Sensor command not found"
            throw 'Get-Sensor command introuvable dans le module HardwareMonitor.'
        }

        Write-DebugLog "Calling Get-Sensor -Library..."
        try {
            $sensors = Get-Sensor -Library -ErrorAction Stop
            Write-DebugLog "Got $($sensors.Count) sensors from -Library"
            return $sensors
        } catch {
            Write-DebugLog "Get-Sensor -Library failed: $($_.Exception.Message)"
            $sensors = Get-Sensor -ErrorAction Stop
            Write-DebugLog "Got $($sensors.Count) sensors from fallback"
            return $sensors
        }
    } catch {
        Write-DebugLog "Error collecting sensors: $($_.Exception.Message)"
        return @()
    }
}

function Get-GpuMetricsFromLibreHardwareMonitor {
    Write-DebugLog "Getting GPU metrics from LibreHardwareMonitor..."
    $sensors = Get-HardwareMonitorSensors
    if (-not $sensors -or $sensors.Count -eq 0) {
        Write-DebugLog "No sensors available"
        return $null
    }

    Write-DebugLog "Processing GPU sensors..."
    # Simplified GPU detection for now
    $gpuGroups = @{}

    foreach ($sensor in $sensors) {
        if (-not $sensor.HardwareName) { continue }
        $name = $sensor.HardwareName
        if ($name -notmatch 'GPU|Radeon|NVIDIA|Intel|Iris|UHD|Xe|gfx|Arc') { continue }

        if (-not $gpuGroups.ContainsKey($name)) {
            $vendor = if ($name -match 'NVIDIA|GeForce|Quadro|RTX|GTX') { 'NVIDIA' }
                      elseif ($name -match 'Radeon|AMD|ATI|FirePro') { 'AMD' }
                      elseif ($name -match 'Intel|Iris|UHD|Xe|Arc') { 'INTEL' }
                      else { 'GPU' }
            $gpuGroups[$name] = @{
                Vendor = $vendor
                Name = $name
                LoadPercent = $null
                MemoryTotalBytes = $null
                MemoryUsedBytes = $null
                TemperatureCelsius = $null
                PowerDrawWatts = $null
                Sensors = @()
            }
        }

        $entry = $gpuGroups[$name]
        $value = $sensor.Value
        if ($value -isnot [double] -and $value -isnot [int]) {
            if ($value -match '^[\d\.]+$') { $value = [double]$matches[0] } else { $value = $sensor.Value }
        }

        $entry.Sensors += @{
            SensorType = $sensor.SensorType
            SensorName = $sensor.SensorName
            Value = $value
        }

        # Load / Utilization
        if ($entry.LoadPercent -eq $null -and $sensor.SensorType -match 'Load|Utilization') {
            if ($sensor.SensorName -match 'GPU Core|Total|3D|Video') {
                if ($value -is [double] -or $value -is [int]) { $entry.LoadPercent = [double]$value }
            }
        }

        # Memory Used
        if ($entry.MemoryUsedBytes -eq $null -and $sensor.SensorName -match 'Memory.*Used|Used.*Memory|D3D Dedicated Memory Used') {
            if ($value -is [double] -or $value -is [int]) { $entry.MemoryUsedBytes = [math]::Round([double]$value * 1024 * 1024) }
        }

        # Memory Total
        if ($entry.MemoryTotalBytes -eq $null -and $sensor.SensorName -match 'Memory.*Total|Total.*Memory') {
            if ($value -is [double] -or $value -is [int]) { $entry.MemoryTotalBytes = [math]::Round([double]$value * 1024 * 1024) }
        }

        # Temperature
        if ($entry.TemperatureCelsius -eq $null -and $sensor.SensorType -match 'Temperature' -and $sensor.SensorName -match 'GPU|Core') {
            if ($value -is [double] -or $value -is [int]) { $entry.TemperatureCelsius = [double]$value }
        }

        # Power
        if ($entry.PowerDrawWatts -eq $null -and $sensor.SensorType -match 'Power' -and $sensor.SensorName -match 'GPU|Package|Core') {
            if ($value -is [double] -or $value -is [int]) { $entry.PowerDrawWatts = [double]$value }
        }
    }

    $result = @()
    foreach ($gpu in $gpuGroups.Values) {
        $result += @{
            Name = $gpu.Name
            Vendor = $gpu.Vendor
            LoadPercent = $gpu.LoadPercent
            AdapterRAMBytes = $gpu.MemoryTotalBytes
            VramUsedBytes = $gpu.MemoryUsedBytes
            TemperatureCelsius = $gpu.TemperatureCelsius
            PowerDrawWatts = $gpu.PowerDrawWatts
            DriverVersion = ''
            Source = 'LibreHardwareMonitor'
        }
    }

    Write-DebugLog "Found $($result.Count) GPUs"
    return $result
}

Write-DebugLog "Testing GPU metrics collection..."
$gpuMetrics = Get-GpuMetricsFromLibreHardwareMonitor

# Fallback: Windows Performance Counters
function Get-GpuMetricsFromCounters {
    Write-DebugLog "Getting GPU metrics from Windows counters..."
    $gpuInfoList = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue
    if (-not $gpuInfoList) {
        Write-DebugLog "No GPU info from CIM"
        return $null
    }

    Write-DebugLog "Found $($gpuInfoList.Count) GPUs from CIM"

    $gpuLoads = @{}
    $gpuMemory = @{}
    $gpuTemps = @{}
    $gpuPower = @{}

    # Try to get GPU utilization counters
    try {
        $gpuEngines = Get-Counter '\GPU Engine(*)\Utilization Percentage' -ErrorAction SilentlyContinue
        if ($gpuEngines) {
            foreach ($sample in $gpuEngines.CounterSamples) {
                $instance = $sample.InstanceName
                $luid = 'default'
                if ($instance -match 'luid_0x([0-9A-Fa-f]+)_0x([0-9A-Fa-f]+)') {
                    $luid = "luid_$($matches[1])_$($matches[2])"
                }

                if ($instance -match 'engtype_(3D|Compute|Copy|VideoDecode|VideoEncode|Cuda)') {
                    $engineType = $matches[1]
                    $value = [double]$sample.CookedValue
                    $percent = if ($value -gt 100) { $value } else { $value * 100.0 }

                    if (-not $gpuLoads.ContainsKey($luid)) {
                        $gpuLoads[$luid] = @{ MaxPercent = 0.0; Engines = @{} }
                    }

                    $gpuLoads[$luid].Engines[$engineType] = $percent
                    if ($percent -gt $gpuLoads[$luid].MaxPercent) {
                        $gpuLoads[$luid].MaxPercent = $percent
                    }
                }
            }
        }
    } catch {
        Write-DebugLog "Failed to get GPU engine counters: $($_.Exception.Message)"
    }

    $result = @()
    $index = 0
    foreach ($gpuInfo in $gpuInfoList) {
        $luid = "phys_$index"
        $load = $null

        if ($gpuLoads.ContainsKey($luid)) {
            $load = [math]::Round($gpuLoads[$luid].MaxPercent, 1)
        } elseif ($gpuLoads.Count -gt 0) {
            $firstKey = $gpuLoads.Keys | Select-Object -First 1
            $load = [math]::Round($gpuLoads[$firstKey].MaxPercent, 1)
        }

        $vendor = 'SYSTEM'
        if ($gpuInfo.Name -match 'NVIDIA|GeForce|Quadro|RTX|GTX') { $vendor = 'NVIDIA' }
        elseif ($gpuInfo.Name -match 'Radeon|AMD|ATI|FirePro') { $vendor = 'AMD' }
        elseif ($gpuInfo.Name -match 'Intel|Arc|Iris|UHD|Xe') { $vendor = 'INTEL' }

        $result += @{
            Name = $gpuInfo.Name
            Vendor = $vendor
            LoadPercent = $load
            AdapterRAMBytes = $gpuInfo.AdapterRAM
            VramUsedBytes = $null
            TemperatureCelsius = $null
            PowerDrawWatts = $null
            DriverVersion = $gpuInfo.DriverVersion
            Source = 'WindowsCounters'
        }

        $index++
    }

    Write-DebugLog "Windows counters found $($result.Count) GPUs"
    return $result
}

# If LibreHardwareMonitor failed, try Windows counters
if (-not $gpuMetrics -or $gpuMetrics.Count -eq 0) {
    Write-DebugLog "Trying Windows counters fallback..."
    $gpuMetrics = Get-GpuMetricsFromCounters
}

$listenHost = '127.0.0.1'
$port = $Port  # Utilise le paramètre passé au script
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
    Write-DebugLog "LIA GPU metrics service démarrée sur $prefix"
} catch {
    Write-Error "Échec du démarrage du service LIA GPU Metrics : $($_.Exception.Message)"
    Write-Error "Assurez-vous d'exécuter le script avec des privilèges administrateurs si le port < 1024"
    Write-Error "Pour utiliser un port différent, exécutez : .\gpu-metrics-service.ps1 -Port <NUMERO_PORT>"
    exit 1
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

function Get-PerformanceMetrics {
    Write-DebugLog "Collecting performance metrics..."

    $cpu = Get-CimInstance Win32_PerfFormattedData_Counters_ProcessorInformation -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -notmatch '_Total' } |
            Select-Object Name, PercentProcessorTime, ProcessorFrequency

    $cpuTotal = Get-CimInstance Win32_PerfFormattedData_Counters_ProcessorInformation -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -eq '_Total' } |
                Select-Object -First 1

    $mem = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
    $memPerf = Get-CimInstance Win32_PerfFormattedData_Counters_Memory -ErrorAction SilentlyContinue

    # Collecte GPU : hw-smi en priorité
    $gpuMetricsList = $null
    $gpuSource = 'none'

    # Priorité 1: hw-smi (précision maximale)
    try {
        Write-DebugLog "Trying hw-smi..."
        $gpuMetricsList = Get-GpuMetricsFromHwSmi
        if ($gpuMetricsList -and $gpuMetricsList.Count -gt 0) {
            $gpuSource = 'hw-smi'
            Write-DebugLog "hw-smi succeeded with $($gpuMetricsList.Count) GPUs"
        }
    } catch {
        Write-DebugLog "hw-smi failed: $($_.Exception.Message)"
    }

    # Fallback sur les compteurs Windows
    if (-not $gpuMetricsList -or $gpuMetricsList.Count -eq 0) {
        try {
            Write-DebugLog "Trying Windows counters..."
            $gpuMetricsList = Get-GpuMetricsFromCounters
            if ($gpuMetricsList -and $gpuMetricsList.Count -gt 0) {
                $gpuSource = 'WindowsCounters'
                Write-DebugLog "Windows counters succeeded with $($gpuMetricsList.Count) GPUs"
            }
        } catch {
            Write-DebugLog "Windows counters failed: $($_.Exception.Message)"
        }
    }

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

while ($true) {
    Write-DebugLog "Waiting for HTTP request..."
    $context = $listener.GetContext()
    try {
        $request = $context.Request
        $response = $context.Response

        if ($request.HttpMethod -eq 'OPTIONS') {
            Write-DebugLog "Handling OPTIONS request"
            Write-Response -Response $response -StatusCode 200 -Body $null
            continue
        }

        if ($request.HttpMethod -ne 'GET') {
            Write-DebugLog "Method not allowed: $($request.HttpMethod)"
            Write-Response -Response $response -StatusCode 405 -Body @{ error = 'Method not allowed' }
            continue
        }

        switch ($request.Url.AbsolutePath) {
            '/metrics/host' {
                Write-DebugLog "Processing /metrics/host request"
                try {
                    $hardwareProfile = Get-HardwareProfile
                    $gpuType = Determine-GpuTypeFromProfile $hardwareProfile
                    $detection = [ordered]@{
                        source = 'hardware-profile'
                        vendor = $hardwareProfile?.vendor
                        label = $hardwareProfile?.label
                        hwSmiAvailable = (Test-Path $hwSmiPath)
                    }

                    $performanceMetrics = Get-PerformanceMetrics

                    $hostMetrics = [ordered]@{
                        source = 'hardware-monitor-host'
                        gpuType = $gpuType
                        detection = $detection
                        metrics = $performanceMetrics
                        timestamp = (Get-Date).ToString('o')
                    }

                    Write-Response -Response $response -StatusCode 200 -Body $hostMetrics
                    Write-DebugLog "Response sent successfully"
                } catch {
                    Write-DebugLog "Error processing request: $($_.Exception.Message)"
                    Write-Response -Response $response -StatusCode 500 -Body @{ error = $_.Exception.Message }
                }
            }
            default {
                Write-DebugLog "Unknown endpoint: $($request.Url.AbsolutePath)"
                Write-Response -Response $response -StatusCode 404 -Body @{ error = 'Endpoint introuvable' }
            }
        }
    } catch {
        Write-DebugLog "Critical error: $($_.Exception.Message)"
        try {
            Write-Response -Response $context.Response -StatusCode 500 -Body @{ error = $_.Exception.Message }
        } catch {}
    }
}

        if ($request.HttpMethod -ne 'GET') {
            Write-DebugLog "Method not allowed: $($request.HttpMethod)"
            $response.StatusCode = 405
            $json = '{"error": "Method not allowed"}' | ConvertTo-Json
            $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
            $response.ContentType = 'application/json; charset=utf-8'
            $response.ContentLength64 = $bytes.Length
            $response.OutputStream.Write($bytes, 0, $bytes.Length)
            $response.OutputStream.Close()
            continue
        }

        switch ($request.Url.AbsolutePath) {
            '/metrics/host' {
                Write-DebugLog "Processing /metrics/host request"
                try {
                    # Response with actual metrics
                    $hostMetrics = @{
                        source = 'hardware-monitor-host'
                        gpuType = 'unknown'
                        detection = @{ source = 'debug'; hwMonitorAvailable = $hwMonitorAvailable }
                        metrics = @{ GPUs = $gpuMetrics }
                        system = @{ OS = @{ Caption = 'Debug' } }
                        timestamp = (Get-Date).ToString('o')
                    }

                    $response.AddHeader("Access-Control-Allow-Origin", "*")
                    $response.StatusCode = 200
                    $response.ContentType = 'application/json; charset=utf-8'
                    $json = $hostMetrics | ConvertTo-Json -Depth 10
                    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
                    $response.ContentLength64 = $bytes.Length
                    $response.OutputStream.Write($bytes, 0, $bytes.Length)
                    $response.OutputStream.Close()
                    Write-DebugLog "Response sent successfully"
                } catch {
                    Write-DebugLog "Error processing request: $($_.Exception.Message)"
                    $response.StatusCode = 500
                    $errorJson = @{ error = $_.Exception.Message } | ConvertTo-Json
                    $bytes = [System.Text.Encoding]::UTF8.GetBytes($errorJson)
                    $response.ContentType = 'application/json; charset=utf-8'
                    $response.ContentLength64 = $bytes.Length
                    $response.OutputStream.Write($bytes, 0, $bytes.Length)
                    $response.OutputStream.Close()
                }
            }
            default {
                Write-DebugLog "Unknown endpoint: $($request.Url.AbsolutePath)"
                $response.StatusCode = 404
                $json = '{"error": "Endpoint introuvable"}' | ConvertTo-Json
                $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
                $response.ContentType = 'application/json; charset=utf-8'
                $response.ContentLength64 = $bytes.Length
                $response.OutputStream.Write($bytes, 0, $bytes.Length)
                $response.OutputStream.Close()
            }
        }
    }
} catch {
    Write-DebugLog "Critical error: $($_.Exception.Message)"
    Write-DebugLog "Stack trace: $($_.Exception.StackTrace)"
} finally {
    if ($listener) {
        try { $listener.Stop() } catch {}
    }
}