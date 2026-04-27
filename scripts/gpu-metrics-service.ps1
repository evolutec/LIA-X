$ErrorActionPreference = 'Stop'

function Get-PerformanceMetrics {

    $cpu = Get-CimInstance Win32_PerfFormattedData_Counters_ProcessorInformation -ErrorAction SilentlyContinue | 
            Where-Object { $_.Name -notmatch '_Total' } | 
            Select-Object Name, PercentProcessorTime, ProcessorFrequency

    $cpuTotal = Get-CimInstance Win32_PerfFormattedData_Counters_ProcessorInformation -ErrorAction SilentlyContinue | 
                Where-Object { $_.Name -eq '_Total' } | 
                Select-Object -First 1

    $mem = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
    $memPerf = Get-CimInstance Win32_PerfFormattedData_Counters_Memory -ErrorAction SilentlyContinue

    $disks = Get-CimInstance Win32_PerfFormattedData_Counters_LogicalDisk -ErrorAction SilentlyContinue | 
             Where-Object { $_.Name -match '^[A-Z]:' } | 
             Select-Object Name, PercentDiskTime, DiskReadBytesPersec, DiskWriteBytesPersec, CurrentDiskQueueLength

    $network = Get-CimInstance Win32_PerfFormattedData_Tcpip_NetworkInterface -ErrorAction SilentlyContinue | 
               Select-Object Name, BytesReceivedPersec, BytesSentPersec, CurrentBandwidth, PacketsReceivedPersec, PacketsSentPersec

    $processes = Get-CimInstance Win32_PerfFormattedData_Counters_Process -ErrorAction SilentlyContinue | 
                 Sort-Object PercentProcessorTime -Descending | 
                 Select-Object -First 15 Name, IDProcess, PercentProcessorTime, WorkingSetPrivate

    $gpu = $null
    try {
        $gpuCounters = Get-Counter '\GPU Engine(*)\Utilization Percentage' -ErrorAction SilentlyContinue
        if ($gpuCounters) {
            $gpu = $gpuCounters.CounterSamples | Where-Object { $_.InstanceName -match 'engtype_3D' } | Measure-Object -Property CookedValue -Average
        }
    } catch {}

    $vram = $null
    try {
        $vramCounters = Get-Counter '\GPU Process Memory(*)\Dedicated Usage' -ErrorAction SilentlyContinue
        if ($vramCounters) {
            $vram = $vramCounters.CounterSamples | Measure-Object -Property CookedValue -Sum
        }
    } catch {}

    $gpuInfo = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | Select-Object -First 1

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
        GPU = [ordered]@{
            Name = $gpuInfo.Name
            DriverVersion = $gpuInfo.DriverVersion
            AdapterRAMBytes = $gpuInfo.AdapterRAM
            LoadPercent = if ($gpu.Average) { [math]::Round($gpu.Average, 1) } else { $null }
            VramUsedBytes = if ($vram.Sum) { [int64]$vram.Sum } else { $null }
        }
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
$port = 13610
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