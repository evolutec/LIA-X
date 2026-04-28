$ErrorActionPreference = 'Stop'

param(
    [int]$Port = 13610
)

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

function Install-HardwareMonitorModule {
    if (-not (Get-Command -Name Install-Module -ErrorAction SilentlyContinue)) {
        return $false
    }

    try {
        Write-Verbose '[HardwareMonitor] Installation du module depuis le repository PowerShell.'
        Install-Module -Name $moduleName -Scope CurrentUser -Force -AllowClobber -ErrorAction Stop
        return $true
    } catch {
        Write-Warning "Échec de l'installation du module HardwareMonitor depuis PowerShell Gallery : $($_.Exception.Message)"
        return $false
    }
}

function Download-HardwareMonitorModule {
    Ensure-Directory $toolsDir
    $moduleDir = Get-HardwareMonitorModulePath
    Ensure-Directory $moduleDir

    $baseUrl = 'https://raw.githubusercontent.com/Lifailon/PowerShell.HardwareMonitor/rsa/Module/HardwareMonitor/0.4'
    $files = @('HardwareMonitor.psd1', 'HardwareMonitor.psm1')

    foreach ($file in $files) {
        $target = Join-Path $moduleDir $file
        if (-not (Test-Path $target)) {
            Write-Verbose "[HardwareMonitor] Téléchargement de $file..."
            Invoke-WebRequest -Uri "$baseUrl/$file" -OutFile $target -TimeoutSec 60
        }
    }

    return $moduleDir
}

function Import-HardwareMonitorModule {
    if (Get-Module -ListAvailable -Name $moduleName) {
        Import-Module -Name $moduleName -ErrorAction Stop | Out-Null
        return $true
    }

    $moduleDir = Get-HardwareMonitorModulePath
    if (Test-Path $moduleDir) {
        try {
            Import-Module -Name $moduleDir -ErrorAction Stop | Out-Null
            return $true
        } catch {
            Write-Warning "[HardwareMonitor] Import local failed: $($_.Exception.Message)"
        }
    }

    if (Install-HardwareMonitorModule) {
        try {
            Import-Module -Name $moduleName -ErrorAction Stop | Out-Null
            return $true
        } catch {
            Write-Warning "[HardwareMonitor] Import après installation PSGallery failed: $($_.Exception.Message)"
        }
    }

    try {
        $moduleDir = Download-HardwareMonitorModule
        Import-Module -Name $moduleDir -ErrorAction Stop | Out-Null
        return $true
    } catch {
        Write-Warning "[HardwareMonitor] Import failed: $($_.Exception.Message)"
        return $false
    }
}

function Ensure-HardwareMonitorModule {
    if (Import-HardwareMonitorModule) { return $true }
    Write-Warning 'HardwareMonitor unavailable.'
    return $false
}

function Get-HardwareMonitorSensors {
    if (-not (Ensure-HardwareMonitorModule)) { return @() }

    try {
        if (-not (Get-Command -Name Get-Sensor -ErrorAction SilentlyContinue)) {
            throw 'Get-Sensor command introuvable dans le module HardwareMonitor.'
        }

        try {
            return Get-Sensor -Library -ErrorAction Stop
        } catch {
            Write-Warning "Get-Sensor -Library a échoué : $($_.Exception.Message)"
            return Get-Sensor -ErrorAction Stop
        }
    } catch {
        Write-Warning "Impossible de collecter les capteurs : $($_.Exception.Message)"
        if (Get-Command -Name Install-LibreHardwareMonitor -ErrorAction SilentlyContinue) {
            try {
                Write-Verbose '[HardwareMonitor] Installation de LibreHardwareMonitor en local...'
                Install-LibreHardwareMonitor
                return Get-Sensor -Library -ErrorAction Stop
            } catch {
                Write-Warning "Installation LibreHardwareMonitor échouée : $($_.Exception.Message)"
            }
        }
    }

    return @()
}

function Parse-HardwareMonitorGpuSensors($sensors) {
    $gpuGroups = [ordered]@{}

    foreach ($sensor in $sensors) {
        if (-not $sensor.HardwareName) { continue }
        $name = $sensor.HardwareName
        if ($name -notmatch 'GPU|Radeon|NVIDIA|Intel|Iris|UHD|Xe|gfx|Arc') { continue }

        if (-not $gpuGroups.ContainsKey($name)) {
            $vendor = if ($name -match 'NVIDIA|GeForce|Quadro|RTX|GTX') { 'NVIDIA' }
                      elseif ($name -match 'Radeon|AMD|ATI|FirePro') { 'AMD' }
                      elseif ($name -match 'Intel|Iris|UHD|Xe|Arc') { 'INTEL' }
                      else { 'GPU' }
            $gpuGroups[$name] = [ordered]@{
                Vendor = $vendor
                Name = $name
                LoadPercent = $null
                MemoryTotalBytes = $null
                MemoryUsedBytes = $null
                TemperatureCelsius = $null
                PowerDrawWatts = $null
                Driver = ''
                Sensors = @()
            }
        }

        $entry = $gpuGroups[$name]
        $value = $sensor.Value
        if ($value -isnot [double] -and $value -isnot [int]) {
            if ($value -match '^[\d\.]+$') { $value = [double]$matches[0] } else { $value = $sensor.Value }
        }

        $entry.Sensors += [ordered]@{
            SensorType = $sensor.SensorType
            SensorName = $sensor.SensorName
            Value = $value
            Min = $sensor.Min
            Max = $sensor.Max
        }

        # Load / Utilization - prendre le capteur "GPU Core" ou le premier Load trouvé
        if ($entry.LoadPercent -eq $null -and $sensor.SensorType -match 'Load|Utilization') {
            if ($sensor.SensorName -match 'GPU Core|Total|3D|Video') {
                if ($value -is [double] -or $value -is [int]) { $entry.LoadPercent = [double]$value }
            }
        }
        # Si on n'a pas encore de LoadPercent, prendre n'importe quel Load
        if ($entry.LoadPercent -eq $null -and $sensor.SensorType -match 'Load|Utilization') {
            if ($value -is [double] -or $value -is [int]) { $entry.LoadPercent = [double]$value }
        }

        # Memory Used
        if ($entry.MemoryUsedBytes -eq $null -and $sensor.SensorName -match 'Memory.*Used|Used.*Memory|GPU Memory Used|D3D Dedicated Memory Used') {
            if ($value -is [double] -or $value -is [int]) { $entry.MemoryUsedBytes = [math]::Round([double]$value * 1024 * 1024) }
        }

        # Memory Total
        if ($entry.MemoryTotalBytes -eq $null -and $sensor.SensorName -match 'Memory.*Total|Total.*Memory|GPU Memory Total') {
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

        if ([string]$sensor.SensorName -match 'Driver') {
            $entry.Driver = [string]$value
        }
    }

    return [array]$gpuGroups.Values
}

function Get-GpuMetricsFromLibreHardwareMonitor {
    $sensors = Get-HardwareMonitorSensors
    if (-not $sensors -or $sensors.Count -eq 0) { return $null }

    $gpuMetrics = Parse-HardwareMonitorGpuSensors $sensors
    if (-not $gpuMetrics -or $gpuMetrics.Count -eq 0) { return $null }

    $result = @()
    foreach ($gpu in $gpuMetrics) {
        $result += [ordered]@{
            Name = $gpu.Name
            Vendor = $gpu.Vendor
            LoadPercent = $gpu.LoadPercent
            AdapterRAMBytes = $gpu.MemoryTotalBytes
            VramUsedBytes = $gpu.MemoryUsedBytes
            TemperatureCelsius = $gpu.TemperatureCelsius
            PowerDrawWatts = $gpu.PowerDrawWatts
            DriverVersion = $gpu.Driver
            Source = 'LibreHardwareMonitor'
        }
    }

    return $result
}

# ============================================================
# FALLBACK : Compteurs Windows améliorés (tous engines)
# ============================================================

function Get-GpuMetricsFromCounters {
    $gpuInfoList = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue
    if (-not $gpuInfoList) { return $null }

    $gpuEngines = $null
    try {
        $gpuEngines = Get-Counter '\GPU Engine(*)\Utilization Percentage' -ErrorAction SilentlyContinue
    } catch {}

    $gpuAdapterMemory = $null
    try {
        $gpuAdapterMemory = Get-Counter '\GPU Adapter Memory(*)\Dedicated Usage' -ErrorAction SilentlyContinue
    } catch {}

    $vramCounters = $null
    try {
        $vramCounters = Get-Counter '\GPU Process Memory(*)\Dedicated Usage' -ErrorAction SilentlyContinue
    } catch {}

    $temperatureCounters = $null
    try {
        $temperatureCounters = Get-Counter '\GPU Adapter(*)\Temperature' -ErrorAction SilentlyContinue
    } catch {}

    $powerCounters = $null
    try {
        $powerCounters = Get-Counter '\GPU Adapter(*)\Power' -ErrorAction SilentlyContinue
    } catch {}
    if (-not $powerCounters) {
        try {
            $powerCounters = Get-Counter '\GPU Adapter(*)\Power Consumption' -ErrorAction SilentlyContinue
        } catch {}
    }

    $gpuLoads = @{}
    $gpuMemory = @{}
    $gpuTemps = @{}
    $gpuPower = @{}

    if ($gpuEngines) {
        foreach ($sample in $gpuEngines.CounterSamples) {
            $instance = $sample.InstanceName
            $luid = 'default'
            if ($instance -match 'luid_0x([0-9A-Fa-f]+)_0x([0-9A-Fa-f]+)') {
                $luid = "luid_$($matches[1])_$($matches[2])"
            } elseif ($instance -match 'phys_(\d+)') {
                $luid = "phys_$($matches[1])"
            }

            if ($instance -match 'engtype_(3D|Compute|Copy|VideoDecode|VideoEncode|Cuda|VideoDecode|VideoEncode)') {
                $engineType = $matches[1]
                $value = [double]$sample.CookedValue
                $percent = if ($value -gt 100) { $value } else { $value * 100.0 }

                if (-not $gpuLoads.ContainsKey($luid)) {
                    $gpuLoads[$luid] = @{
                        MaxPercent = 0.0
                        Engines = @{}
                    }
                }

                $gpuLoads[$luid].Engines[$engineType] = $percent
                if ($percent -gt $gpuLoads[$luid].MaxPercent) {
                    $gpuLoads[$luid].MaxPercent = $percent
                }
            }
        }
    }

    if ($gpuAdapterMemory) {
        foreach ($sample in $gpuAdapterMemory.CounterSamples) {
            $instance = $sample.InstanceName
            $luid = 'default'
            if ($instance -match 'luid_0x([0-9A-Fa-f]+)_0x([0-9A-Fa-f]+)') {
                $luid = "luid_$($matches[1])_$($matches[2])"
            } elseif ($instance -match 'phys_(\d+)') {
                $luid = "phys_$($matches[1])"
            }

            $value = [int64]$sample.CookedValue
            if (-not $gpuMemory.ContainsKey($luid) -or $value -gt $gpuMemory[$luid]) {
                $gpuMemory[$luid] = $value
            }
        }
    }

    if ($vramCounters) {
        foreach ($sample in $vramCounters.CounterSamples) {
            $instance = $sample.InstanceName
            $luid = 'default'
            if ($instance -match 'luid_0x([0-9A-Fa-f]+)_0x([0-9A-Fa-f]+)') {
                $luid = "luid_$($matches[1])_$($matches[2])"
            } elseif ($instance -match 'phys_(\d+)') {
                $luid = "phys_$($matches[1])"
            }

            $value = [int64]$sample.CookedValue
            if (-not $gpuMemory.ContainsKey($luid) -or $value -gt $gpuMemory[$luid]) {
                $gpuMemory[$luid] = $value
            }
        }
    }

    if ($temperatureCounters) {
        foreach ($sample in $temperatureCounters.CounterSamples) {
            $instance = $sample.InstanceName
            $luid = 'default'
            if ($instance -match 'luid_0x([0-9A-Fa-f]+)_0x([0-9A-Fa-f]+)') {
                $luid = "luid_$($matches[1])_$($matches[2])"
            } elseif ($instance -match 'phys_(\d+)') {
                $luid = "phys_$($matches[1])"
            }

            $gpuTemps[$luid] = [double]$sample.CookedValue
        }
    }

    if ($powerCounters) {
        foreach ($sample in $powerCounters.CounterSamples) {
            $instance = $sample.InstanceName
            $luid = 'default'
            if ($instance -match 'luid_0x([0-9A-Fa-f]+)_0x([0-9A-Fa-f]+)') {
                $luid = "luid_$($matches[1])_$($matches[2])"
            } elseif ($instance -match 'phys_(\d+)') {
                $luid = "phys_$($matches[1])"
            }

            $gpuPower[$luid] = [double]$sample.CookedValue
        }
    }

    $result = @()
    $index = 0
    foreach ($gpuInfo in $gpuInfoList) {
        $luid = "phys_$index"
        $load = $null
        $engines = @{}

        if ($gpuLoads.ContainsKey($luid)) {
            $load = [math]::Round($gpuLoads[$luid].MaxPercent, 1)
            $engines = $gpuLoads[$luid].Engines
        }

        if ($load -eq $null -and $gpuLoads.Count -gt 0) {
            $firstKey = $gpuLoads.Keys | Select-Object -First 1
            $load = [math]::Round($gpuLoads[$firstKey].MaxPercent, 1)
            $engines = $gpuLoads[$firstKey].Engines
        }

        $vramUsed = $null
        if ($gpuMemory.ContainsKey($luid)) {
            $vramUsed = $gpuMemory[$luid]
        } elseif ($gpuMemory.Count -gt 0) {
            $firstKey = $gpuMemory.Keys | Select-Object -First 1
            $vramUsed = $gpuMemory[$firstKey]
        }

        $temperature = $null
        if ($gpuTemps.ContainsKey($luid)) {
            $temperature = $gpuTemps[$luid]
        } elseif ($gpuTemps.Count -gt 0) {
            $temperature = $gpuTemps.Values | Select-Object -First 1
        }

        $power = $null
        if ($gpuPower.ContainsKey($luid)) {
            $power = $gpuPower[$luid]
        } elseif ($gpuPower.Count -gt 0) {
            $power = $gpuPower.Values | Select-Object -First 1
        }

        $vendor = 'SYSTEM'
        if ($gpuInfo.Name -match 'NVIDIA|GeForce|Quadro|RTX|GTX') { $vendor = 'NVIDIA' }
        elseif ($gpuInfo.Name -match 'Radeon|AMD|ATI|FirePro') { $vendor = 'AMD' }
        elseif ($gpuInfo.Name -match 'Intel|Arc|Iris|UHD|Xe') { $vendor = 'INTEL' }
        elseif ($gpuInfo.AdapterCompatibility -match 'NVIDIA') { $vendor = 'NVIDIA' }
        elseif ($gpuInfo.AdapterCompatibility -match 'AMD|ATI|Radeon') { $vendor = 'AMD' }
        elseif ($gpuInfo.AdapterCompatibility -match 'Intel|Arc') { $vendor = 'INTEL' }

        $result += [ordered]@{
            Name = $gpuInfo.Name
            Vendor = $vendor
            LoadPercent = $load
            AdapterRAMBytes = $gpuInfo.AdapterRAM
            VramUsedBytes = $vramUsed
            TemperatureCelsius = $temperature
            PowerDrawWatts = $power
            DriverVersion = $gpuInfo.DriverVersion
            Source = 'WindowsCounters'
            Engines = $engines
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

    $processes = Get-CimInstance Win32_PerfFormattedData_Counters_Process -ErrorAction SilentlyContinue |
                 Sort-Object PercentProcessorTime -Descending |
                 Select-Object -First 15 Name, IDProcess, PercentProcessorTime, WorkingSetPrivate

    $disks = Get-CimInstance Win32_PerfFormattedData_Counters_PhysicalDisk -ErrorAction SilentlyContinue |
             Where-Object { $_.Name -notmatch '_Total' }

    $network = Get-CimInstance Win32_PerfFormattedData_Counters_NetworkInterface -ErrorAction SilentlyContinue |
               Where-Object { $_.Name -notmatch '_Total' }

    # --- NOUVEAU : Collecte GPU multi-méthodes ---
    $gpuMetricsList = $null
    $gpuSource = 'none'
    $fullMetrics = $null

    # Essayer hw-smi EN PREMIER (meilleur précision)
    try {
        $hwSmiPath = Join-Path $toolsDir 'hw-smi\hw-smi.exe'
        if (Test-Path $hwSmiPath) {
            $jsonOutput = & $hwSmiPath --json 2>$null | Out-String
            if ($LASTEXITCODE -eq 0) {
                $fullMetrics = $jsonOutput | ConvertFrom-Json -ErrorAction Stop
                if ($fullMetrics -and $fullMetrics.gpus -and $fullMetrics.gpus.Count -gt 0) {
                    $gpuMetricsList = @()
                    foreach ($gpu in $fullMetrics.gpus) {
                        $gpuMetricsList += [ordered]@{
                            Name = $gpu.name
                            Vendor = $gpu.vendor
                            LoadPercent = $gpu.gpu_utilization_percent
                            AdapterRAMBytes = $gpu.memory_total_bytes
                            VramUsedBytes = $gpu.memory_used_bytes
                            TemperatureCelsius = $gpu.temperature_c
                            PowerDrawWatts = $gpu.power_draw_watts
                            DriverVersion = $gpu.driver_version
                            Source = 'hw-smi'
                            CoreClockMhz = $gpu.core_clock_mhz
                            MemoryClockMhz = $gpu.memory_clock_mhz
                            PowerLimitWatts = $gpu.power_limit_watts
                            TemperatureHotspotC = $gpu.temperature_hotspot_c
                            TemperatureMemoryC = $gpu.temperature_memory_c
                            FanSpeedRpm = $gpu.fan_speed_rpm
                            FanSpeedPercent = $gpu.fan_speed_percent
                        }
                    }
                    $gpuSource = 'hw-smi'
                }
            }
        }
    } catch {
        Write-Warning "hw-smi GPU failed: $($_.Exception.Message)"
    }

    # Fallback LibreHardwareMonitor
    if (-not $gpuMetricsList -or $gpuMetricsList.Count -eq 0) {
        try {
            $gpuMetricsList = Get-GpuMetricsFromLibreHardwareMonitor
            if ($gpuMetricsList -and $gpuMetricsList.Count -gt 0) {
                $gpuSource = 'LibreHardwareMonitor'
            }
        } catch {
            Write-Warning "LibreHardwareMonitor GPU failed: $($_.Exception.Message)"
        }
    }

    # Fallback sur les compteurs Windows
    if (-not $gpuMetricsList -or $gpuMetricsList.Count -eq 0) {
        try {
            $gpuMetricsList = Get-GpuMetricsFromCounters
            if ($gpuMetricsList -and $gpuMetricsList.Count -gt 0) {
                $gpuSource = 'WindowsCounters'
            }
        } catch {
            Write-Warning "Windows Counters GPU failed: $($_.Exception.Message)"
        }
    }

    # Objet GPU legacy (premier GPU pour compatibilité)
    $firstGpu = $null
    if ($gpuMetricsList -and $gpuMetricsList.Count -gt 0) {
        $firstGpu = $gpuMetricsList[0]
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
            ProcessesCount = (Get-Process | Measure-Object).Count
            ThreadsCount = $mem.NumberOfProcesses
        }
        Memory = [ordered]@{
            TotalBytes = [int64]$mem.TotalVisibleMemorySize * 1024
            UsedBytes = ([int64]$mem.TotalVisibleMemorySize - [int64]$mem.FreePhysicalMemory) * 1024
            FreeBytes = [int64]$mem.FreePhysicalMemory * 1024
            UsedPercent = [math]::Round((1 - ($mem.FreePhysicalMemory / $mem.TotalVisibleMemorySize)) * 100, 1)
            PageFileUsedBytes = [int64]$memPerf.PagesInputPersec
            AvailableMB = [int]$memPerf.AvailableMBytes
        }
        GPUs = $gpuMetricsList
        Disks = $disks | ForEach-Object {
            [ordered]@{
                DriveLetter = $_.Name
                LoadPercent = [math]::Round($_.PercentDiskTime, 1)
                ReadBytesPerSecond = [int64]$_.DiskReadBytesPersec
                WriteBytesPerSecond = [int64]$_.DiskWriteBytesPersec
                QueueLength = [int]$_.CurrentDiskQueueLength
            }
        }
        Network = $network | ForEach-Object {
            [ordered]@{
                InterfaceName = $_.Name
                BytesReceivedPerSecond = [int64]$_.BytesReceivedPersec
                BytesSentPerSecond = [int64]$_.BytesSentPersec
                BandwidthBitsPerSecond = [int64]$_.CurrentBandwidth
                PacketsReceivedPerSecond = [int64]$_.PacketsReceivedPersec
                PacketsSentPerSecond = [int64]$_.PacketsSentPersec
            }
        }
        TopProcesses = $processes | ForEach-Object {
            [ordered]@{
                Name = $_.Name
                ProcessId = [int]$_.IDProcess
                CpuPercent = [math]::Round($_.PercentProcessorTime, 1)
                WorkingSetBytes = [int64]$_.WorkingSetPrivate
            }
        }
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
            Uptime = if ($os -and $os.LastBootUpTime -and -not [string]::IsNullOrWhiteSpace($os.LastBootUpTime)) {
                try {
                    [math]::Round(((Get-Date) - ([Management.ManagementDateTimeConverter]::ToDateTime($os.LastBootUpTime))).TotalSeconds)
                } catch {
                    $null
                }
            } else { $null }
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
$port = 13620
$prefix = "http://${listenHost}:${port}/"

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($prefix)
$listener.Start()
Write-Host "LIA GPU metrics service démarrée sur $prefix"

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

