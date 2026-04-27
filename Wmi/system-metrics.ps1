# System Metrics Collection (CPU, RAM, Disk)
# Utilise WMI pour les métriques système de la machine hôte

function Get-SystemMetrics {
    # CPU
    $cpu = Get-CimInstance -ClassName Win32_Processor -ErrorAction SilentlyContinue
    $cpuTotal = 0
    $cpuCores = 0
    if ($cpu -and $cpu.Count -gt 0) {
        $cpuTotal = [math]::Round($cpu.CpuLoadPercentage, 2)
        $cpuCores = $cpu.Count
        $cpuName = $cpu[0].Name
        $cpuSpeed = [math]::Round($cpu[0].MaxClockSpeed, 2)
    }
    
    # Mémoire
    $memory = Get-CimInstance -ClassName Win32_PhysicalMemory -ErrorAction SilentlyContinue
    $totalMemory = [math]::Round($memory.TotalWidth / 1MB, 2)  # GB
    $freeMemory = [math]::Round($memory.Free / 1MB, 2)  # GB
    $usedMemory = [math]::Round($totalMemory - $freeMemory, 2)
    $memoryUsage = if ($totalMemory -gt 0) { [math]::Round(($usedMemory / $totalMemory) * 100, 2) } else { 0 }
    
    # Disque
    $disk = Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DeviceID='C:'" -ErrorAction SilentlyContinue
    $totalDisk = [math]::Round($disk.Size / 1GB, 2)  # GB
    $freeDisk = [math]::Round($disk.FreeSpace / 1GB, 2)  # GB
    $usedDisk = [math]::Round($disk.Size - $disk.FreeSpace, 2)
    $diskUsage = if ($totalDisk -gt 0) { [math]::Round(($usedDisk / $totalDisk) * 100, 2) } else { 0 }
    
    # Système
    $os = Get-CimInstance -ClassName Win32_OperatingSystem
    $osName = $os.Caption
    $osVersion = $os.Version
    $osBuild = $os.BuildNumber
    $uptime = [math]::Round($os.Uptime / (60*60*24), 2)  # jours
    
    return @{
        CPU = @{
            Load = $cpuTotal
            Cores = $cpuCores
            Name = $cpuName
            Speed = $cpuSpeed
        }
        Memory = @{
            Total = $totalMemory
            Used = $usedMemory
            Free = $freeMemory
            Usage = $memoryUsage
        }
        Disk = @{
            Total = $totalDisk
            Used = $usedDisk
            Free = $freeDisk
            Usage = $diskUsage
        }
        OS = @{
            Name = $osName
            Version = $osVersion
            Build = $osBuild
            Uptime = $uptime + " days"
        }
    }
}

# Collecter les métriques système
$metrics = Get-SystemMetrics
$output = $metrics | ConvertTo-Json -Compress
Write-Output $output