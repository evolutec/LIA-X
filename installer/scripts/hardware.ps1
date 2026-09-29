# installer\scripts\hardware.ps1
# Fonctions de détection et gestion du matériel

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

    # Un GPU « Basic Render »/virtuel ne doit jamais être considéré comme
    # accélérateur : on le marque pour que l'appelant retombe sur CPU.
    $gpuDevices = @()
    foreach ($controller in $controllers) {
        $name = ''
        if ($controller.Name) { $name = $controller.Name.Trim() }
        $driverVersion = ''
        if ($controller.DriverVersion) { $driverVersion = $controller.DriverVersion.Trim() }
        $adapterRam = 0
        if ($controller.AdapterRAM -ne $null) { $adapterRam = [int64]$controller.AdapterRAM }

        # Un GPU « Basic Render »/virtuel ne doit jamais être considéré comme accélérateur.
        $isVirtual = [bool]($name -match 'Basic Render|Microsoft Basic|Virtual|Remote Display')

        # Vidéo mémoire dédiée : AdapterRAM est un uint32 côté WMI et peut être
        # plafonné (~4 Go). On conserve la valeur rapportée et on la compare au
        # nombre de Go éventuellement présent dans le nom marketing du modèle.
        $namedDedicatedBytes = [int64]0
        if ($name -match '(\d+)\s*GB') {
            $namedDedicatedBytes = [int64]$Matches[1] * 1024MB
        }
        $dedicatedBytes = [Math]::Max($adapterRam, $namedDedicatedBytes)

        $isIntegrated = $false
        if ($name -match 'NVIDIA') {
            $isIntegrated = $false
        } elseif ($name -match 'Radeon\s+(RX|Pro|WX|HD\s+[6-9]|Instinct)') {
            $isIntegrated = $false
        } elseif ($name -match 'Radeon.*Graphics|Radeon\s*\(TM\)|Vega|Ryzen.*Radeon|Radeon\s+\d{3}M') {
            $isIntegrated = $true
        } elseif ($name -match 'Intel') {
            # Arc A/B = cartes discrètes ; Arc 1xxV / Iris / UHD = iGPU Xe.
            if ($name -match 'Arc\s*(\(TM\))?\s*(A|B)\s*\d{3}') {
                $isIntegrated = $false
            } else {
                $isIntegrated = $true
            }
        } elseif ($name -match 'AMD') {
            $isIntegrated = $true
        }

        # eGPU / GPU externe : utile pour expliquer un changement de profil sans
        # changement de machine (Thunderbolt, OCuLink, boîtier externe).
        $isExternal = [bool]($name -match 'eGPU|Thunderbolt|External|OCuLink|Razer Core')

        $deviceVendor = 'unknown'
        if ($name -match 'NVIDIA|GeForce|Quadro|RTX|GTX') { $deviceVendor = 'nvidia' }
        elseif ($name -match 'Radeon|AMD|Instinct|Vega') { $deviceVendor = 'amd' }
        elseif ($name -match 'Intel|Arc|Iris|UHD') { $deviceVendor = 'intel' }

        $gpuDevices += @{
            name = $name
            vendor = $deviceVendor
            driver_version = $driverVersion
            adapter_ram_bytes = $adapterRam
            dedicated_estimated_bytes = $dedicatedBytes
            memory_source = if ($dedicatedBytes -gt 0) { 'adapter' } else { 'unavailable' }
            is_integrated = $isIntegrated
            is_external = $isExternal
            is_virtual = $isVirtual
        }
    }

    # ── Agrégats GPU : multi-GPU, dédié vs partagé, mémoire réellement utilisable
    # On distingue la mémoire dédiée (VRAM d'une carte) de la mémoire partagée
    # (RAM système utilisée par un iGPU). Un iGPU Intel/AMD « 16 Go » annoncé par
    # Windows ne dispose pas de 16 Go de VRAM réelle : c'est de la RAM partagée.
    $gpuDedicatedBytes = [int64]0
    $gpuHasDiscrete = $false
    $gpuHasIntegrated = $false
    $gpuHasExternal = $false
    $gpuHasVirtualOnly = $true
    $gpuBestDevice = $null
    $gpuBestScore = [int64]-1
    foreach ($dev in $gpuDevices) {
        if (-not $dev.is_virtual) { $gpuHasVirtualOnly = $false }
        if ($dev.is_integrated) { $gpuHasIntegrated = $true } else { $gpuHasDiscrete = $true }
        if ($dev.is_external) { $gpuHasExternal = $true }

        # Score : un GPU discret avec mémoire dédiée prime sur un iGPU.
        $score = [int64]$dev.dedicated_estimated_bytes
        if ($dev.is_integrated) { $score = [int64]($score / 4) }
        if ($dev.is_virtual) { $score = [int64]-1 }
        if ($score -gt $gpuBestScore) {
            $gpuBestScore = $score
            $gpuBestDevice = $dev
        }
        # Une carte discrète apporte de la VRAM dédiée réelle ; un iGPU apporte
        # de la mémoire unifiée (RAM partagée), comptée séparément.
        if (-not $dev.is_integrated -and -not $dev.is_virtual) {
            $gpuDedicatedBytes += [int64]$dev.dedicated_estimated_bytes
        }
    }
    $gpuUnifiedBytes = [int64]0
    if ($gpuHasIntegrated -and -not $gpuHasDiscrete -and $gpuBestDevice) {
        $gpuUnifiedBytes = [int64]$gpuBestDevice.dedicated_estimated_bytes
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

    # ── Mémoire GPU consolidée : dédiée (VRAM) vs partagée (mémoire unifiée iGPU)
    $systemRamBytes = [int64]0
    if ($memoryProfile -and $memoryProfile.total_bytes) { $systemRamBytes = [int64]$memoryProfile.total_bytes }
    $isUnified = [bool]($gpuHasIntegrated -and -not $gpuHasDiscrete)

    # Mémoire réellement utilisable par llama.cpp :
    #  - carte discrète : VRAM dédiée rapportée par WMI ;
    #  - iGPU seul : mémoire unifiée, volontairement bornée à ~60 % car le
    #    système, le compositeur et les autres applications en consomment aussi.
    $usableBytes = [int64]$gpuDedicatedBytes
    if ($isUnified) {
        $usableBytes = [int64][Math]::Floor($gpuUnifiedBytes * 0.6)
    }
    if ($gpuHasVirtualOnly) { $usableBytes = [int64]0 }

    $gpuMemoryProfile = @{
        dedicated_bytes  = [int64]$gpuDedicatedBytes
        unified_bytes    = [int64]$gpuUnifiedBytes
        usable_bytes     = [int64]$usableBytes
        system_ram_bytes = $systemRamBytes
        is_unified       = $isUnified
        is_virtual_only  = [bool]$gpuHasVirtualOnly
        source           = if ($gpuDedicatedBytes -gt 0 -or $gpuUnifiedBytes -gt 0) { 'wmi' } else { 'unavailable' }
        note             = if ($isUnified) { 'iGPU : mémoire unifiée partagée avec la RAM (pas de VRAM dédiée).' } else { '' }
    }

    $gpuProfile = @{
        vendor        = $gpuVendor
        label         = $gpuLabel
        count         = $gpuDevices.Count
        devices       = $gpuDevices
        memory        = $gpuMemoryProfile
        has_discrete  = [bool]$gpuHasDiscrete
        has_integrated = [bool]$gpuHasIntegrated
        has_external  = [bool]$gpuHasExternal
        is_igpu_only  = [bool]$isUnified
        best_device   = $gpuBestDevice
    }

    return @{
        vendor = $gpuVendor
        label = $gpuLabel
        gpu = $gpuProfile
        cpu = $cpuProfile
        memory = $memoryProfile
        os = $osProfile
        is_igpu_only = [bool]$isUnified
        detected_at = (Get-Date).ToString('o')
    }
}

# ─────────────────────────────────────────────────────────────────────────────
# Capacités backend réellement disponibles sur la machine hôte.
# Aucune supposition : chaque backend est prouvé par un outil ou un runtime
# présent (nvidia-smi, rocm-smi / DLL HIP, vulkaninfo / ICD Vulkan / vulkan-1.dll).
# Le résultat est mis en cache (script scope) car nvidia-smi et vulkaninfo
# coûtent quelques centaines de ms à quelques secondes.
# ─────────────────────────────────────────────────────────────────────────────
function Get-BackendCapabilities {
    param([hashtable]$Hardware, [switch]$Force)

    if (-not $Force -and $script:LiaBackendCapabilitiesCache) {
        return $script:LiaBackendCapabilitiesCache
    }

    $capabilities = @{
        cuda   = @{ available = $false; source = 'none'; detail = 'nvidia-smi introuvable'; devices = @() }
        rocm   = @{ available = $false; source = 'none'; detail = 'runtime ROCm introuvable'; devices = @() }
        vulkan = @{ available = $false; source = 'none'; detail = 'runtime Vulkan introuvable'; devices = @() }
        cpu    = @{ available = $true;  source = 'always'; detail = 'CPU x86/x64 toujours disponible'; devices = @() }
    }

    # ── CUDA : nvidia-smi interroge vraiment le pilote et liste les GPU.
    $nvidiaSmi = $null
    $smiCandidates = @()
    $smiCmd = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
    if ($smiCmd) { $smiCandidates += $smiCmd.Source }
    if ($env:ProgramFiles) { $smiCandidates += (Join-Path $env:ProgramFiles 'NVIDIA Corporation\NVSMI\nvidia-smi.exe') }
    if ($env:SystemRoot) { $smiCandidates += (Join-Path $env:SystemRoot 'System32\nvidia-smi.exe') }
    foreach ($candidate in $smiCandidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { $nvidiaSmi = $candidate; break }
    }
    if ($nvidiaSmi) {
        try {
            $raw = & $nvidiaSmi '--query-gpu=name,memory.total,driver_version' '--format=csv,noheader' 2>$null
            if ($LASTEXITCODE -eq 0 -and $raw) {
                $cudaDevices = @()
                foreach ($line in @($raw)) {
                    $parts = [string]$line -split '\s*,\s*'
                    if ($parts.Count -ge 1 -and $parts[0]) {
                        $cudaDevices += @{
                            name           = $parts[0]
                            memory_total   = if ($parts.Count -gt 1) { $parts[1] } else { '' }
                            driver_version = if ($parts.Count -gt 2) { $parts[2] } else { '' }
                        }
                    }
                }
                $capabilities.cuda.devices = $cudaDevices
                $capabilities.cuda.available = [bool]($cudaDevices.Count -gt 0)
                $capabilities.cuda.source = 'nvidia-smi'
                $capabilities.cuda.detail = if ($cudaDevices.Count -gt 0) {
                    "pilote NVIDIA opérationnel ($($cudaDevices.Count) GPU)"
                } else {
                    'nvidia-smi présent mais aucun GPU NVIDIA exploitable'
                }
            } else {
                $capabilities.cuda.detail = 'nvidia-smi présent mais interrogation du pilote en échec'
            }
        } catch {
            $capabilities.cuda.detail = "nvidia-smi : $($_.Exception.Message)"
        }
    }

    # ── ROCm : outil ROCm, runtime HIP (DLL) ou HIP_PATH.
    $rocmSmi = $null
    $rocmCandidates = @()
    $rocmCmd = Get-Command rocm-smi.exe -ErrorAction SilentlyContinue
    if ($rocmCmd) { $rocmCandidates += $rocmCmd.Source }
    if ($env:ProgramFiles) { $rocmCandidates += (Join-Path $env:ProgramFiles 'AMD\ROCm\bin\rocm-smi.exe') }
    if ($env:HIP_PATH) { $rocmCandidates += (Join-Path $env:HIP_PATH 'bin\rocm-smi.exe') }
    foreach ($candidate in $rocmCandidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { $rocmSmi = $candidate; break }
    }
    if ($rocmSmi) {
        $capabilities.rocm.available = $true
        $capabilities.rocm.source = 'rocm-smi'
        $capabilities.rocm.detail = 'runtime ROCm détecté (rocm-smi)'
    } else {
        # Recherche des DLL du runtime HIP (installation ROCm sans rocm-smi dans le PATH).
        $hipDlls = @()
        $hipRoots = @()
        if ($env:ProgramFiles) { $hipRoots += (Join-Path $env:ProgramFiles 'AMD\ROCm') }
        if ($env:HIP_PATH) { $hipRoots += $env:HIP_PATH }
        foreach ($root in $hipRoots) {
            if (-not (Test-Path -LiteralPath $root)) { continue }
            $hipDlls += @(Get-ChildItem -Path $root -Filter 'amdhip64*.dll' -File -Recurse -ErrorAction SilentlyContinue |
                Select-Object -First 5 -ExpandProperty FullName)
        }
        if ($hipDlls.Count -gt 0) {
            $capabilities.rocm.available = $true
            $capabilities.rocm.source = 'hip-runtime'
            $capabilities.rocm.detail = "runtime HIP présent ($($hipDlls.Count) DLL)"
        }
    }
    # ── Vulkan : ICD enregistrés dans le registre, vulkaninfo, chargeur vulkan-1.dll.
    $vulkanIcps = @()
    foreach ($key in @('HKLM:\SOFTWARE\Khronos\Vulkan\Drivers', 'HKLM:\SOFTWARE\WOW6432Node\Khronos\Vulkan\Drivers')) {
        if (Test-Path $key) {
            try { $vulkanIcps += @((Get-Item $key).Property) } catch { }
        }
    }
    $vulkanInfo = $null
    $vkCmd = Get-Command vulkaninfo.exe -ErrorAction SilentlyContinue
    if ($vkCmd) { $vulkanInfo = $vkCmd.Source }
    if (-not $vulkanInfo -and $env:VULKAN_SDK) {
        $vkSdkPath = Join-Path $env:VULKAN_SDK 'Bin\vulkaninfo.exe'
        if (Test-Path -LiteralPath $vkSdkPath) { $vulkanInfo = $vkSdkPath }
    }
    $vulkanLoader = $false
    if ($env:SystemRoot) {
        $vulkanLoader = Test-Path -LiteralPath (Join-Path $env:SystemRoot 'System32\vulkan-1.dll')
    }

    if ($vulkanInfo) {
        $capabilities.vulkan.available = $true
        $capabilities.vulkan.source = 'vulkaninfo'
        $capabilities.vulkan.detail = 'runtime Vulkan présent (vulkaninfo)'
    } elseif ($vulkanLoader -and $vulkanIcps.Count -gt 0) {
        $capabilities.vulkan.available = $true
        $capabilities.vulkan.source = 'icd-registry'
        $capabilities.vulkan.detail = "chargeur Vulkan + $($vulkanIcps.Count) pilote(s) ICD"
    } elseif ($vulkanLoader) {
        $capabilities.vulkan.detail = 'chargeur Vulkan présent mais aucun pilote ICD enregistré'
    }

    # Un backend GPU n'a de sens que si un GPU réel (non virtuel) est présent.
    $hasRealGpu = $false
    if ($Hardware -and $Hardware.gpu -and $Hardware.gpu.devices) {
        $hasRealGpu = @($Hardware.gpu.devices | Where-Object { -not $_.is_virtual }).Count -gt 0
    }
    if (-not $hasRealGpu) {
        foreach ($name in @('cuda', 'rocm', 'vulkan')) {
            if ($capabilities.$name.available) {
                $capabilities.$name.available = $false
                $capabilities.$name.detail = "$($capabilities.$name.detail) — mais aucun GPU réel détecté"
            }
        }
    }
    $capabilities.has_real_gpu = [bool]$hasRealGpu
    $capabilities.vulkan_icd_count = [int]$vulkanIcps.Count

    $script:LiaBackendCapabilitiesCache = $capabilities
    return $capabilities
}

# Test RÉEL d'un binaire llama.cpp : exécute `llama-server.exe --version` avec
# délai maximal. Non destructif (aucun modèle chargé) et permet de refuser un
# backend dont le binaire ne démarre pas (DLL manquante, CPU incompatible, etc.).
function Test-LlamaBinary {
    param([string]$BinaryPath, [int]$TimeoutSeconds = 20)

    $result = @{
        ok        = $false
        path      = $BinaryPath
        exit_code = $null
        version   = ''
        error     = ''
        tested_at = (Get-Date).ToString('o')
    }

    if (-not $BinaryPath -or -not (Test-Path -LiteralPath $BinaryPath)) {
        $result.error = 'binaire introuvable'
        return $result
    }

    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $BinaryPath
        $psi.Arguments = '--version'
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.WorkingDirectory = Split-Path -Parent $BinaryPath

        $proc = [System.Diagnostics.Process]::Start($psi)
        if (-not $proc.WaitForExit($TimeoutSeconds * 1000)) {
            try { $proc.Kill() } catch { }
            $result.error = "délai dépassé (${TimeoutSeconds}s)"
            return $result
        }

        $stdout = $proc.StandardOutput.ReadToEnd()
        $stderr = $proc.StandardError.ReadToEnd()
        $text = "$stdout`n$stderr"

        $result.exit_code = $proc.ExitCode
        if ($text -match 'version:\s*([^\s]+)') { $result.version = $Matches[1] }
        elseif ($text -match '\bbuild:\s*([^\s]+)') { $result.version = $Matches[1] }

        # Certains builds renvoient un code non nul tout en affichant la version.
        $result.ok = ($proc.ExitCode -eq 0) -or (-not [string]::IsNullOrWhiteSpace($result.version))
        if (-not $result.ok) {
            $firstLine = @($text -split "`r?`n" | Where-Object { $_.Trim() }) | Select-Object -First 1
            $result.error = if ($firstLine) { $firstLine.Trim() } else { "code de sortie $($proc.ExitCode)" }
        }
    } catch {
        $result.error = $_.Exception.Message
    }

    return $result
}

function Get-RecommendedRuntimeConfig([hashtable]$hardware, $Capabilities = $null) {
    $GB = 1024 * 1024 * 1024
    $vendorValue = 'cpu'
    if ($hardware -and $hardware.vendor) { $vendorValue = $hardware.vendor }
    $vendor = [string]$vendorValue.ToLower()

    $totalRam = 0
    if ($hardware -and $hardware.memory -and $hardware.memory.total_bytes) { $totalRam = [int64]$hardware.memory.total_bytes }

    # Mémoire GPU exploitable. Si le profil vient de Get-HardwareProfile, on
    # utilise les agrégats calculés (VRAM dédiée vs mémoire unifiée). Sinon
    # (profil synthétique / ancien format) on retombe sur une estimation par
    # périphérique, sans jamais inventer de VRAM pour un iGPU.
    $gpuRam = 0
    $bestIsIntegrated = $true
    $isUnifiedMemory = $false
    if ($hardware -and $hardware.gpu -and $hardware.gpu.memory -and $hardware.gpu.memory.usable_bytes) {
        $gpuRam = [int64]$hardware.gpu.memory.usable_bytes
        $isUnifiedMemory = [bool]$hardware.gpu.memory.is_unified
        $bestIsIntegrated = -not [bool]$hardware.gpu.has_discrete
    } elseif ($hardware -and $hardware.gpu -and $hardware.gpu.devices -and $hardware.gpu.devices.Count -gt 0) {
        foreach ($dev in $hardware.gpu.devices) {
            $currentRam = 0
            if ($dev.adapter_ram_bytes) { $currentRam = [int64]$dev.adapter_ram_bytes }

            # Détection depuis le nom (ex: "Intel(R) Arc(TM) 140V GPU (16GB)")
            if ($dev.name -match '(\d+)\s*GB') {
                $namedGb = [int64]$Matches[1] * $GB
                if ($namedGb -gt $currentRam) { $currentRam = $namedGb }
            }

            $devIsIntegrated = [bool]$dev.is_integrated

            # Privilégier les GPU discrets ; si aucun discret trouvé, on prend le meilleur iGPU
            if (-not $devIsIntegrated -and $currentRam -gt $gpuRam) {
                $gpuRam = $currentRam
                $bestIsIntegrated = $false
            } elseif ($bestIsIntegrated -and $devIsIntegrated -and $currentRam -gt $gpuRam) {
                $gpuRam = $currentRam
                $isUnifiedMemory = $true
            }
        }
    }

    # Aucune VRAM n'est inventée : la mémoire retenue est soit la VRAM dédiée
    # rapportée par WMI, soit la mémoire unifiée d'un iGPU (bornée prudemment).
    $effectiveGpuRam = [int64]$gpuRam
    if ($effectiveGpuRam -le 0 -and $isUnifiedMemory) {
        $effectiveGpuRam = [int64][Math]::Floor($totalRam * 0.6)
    }
    # Contrat identique à hardware.gpu.memory (mêmes clés) pour que l'UI, l'API et
    # l'installateur lisent la mémoire GPU de la même façon.
    $profileDedicated = [int64]0
    $profileUnified = [int64]0
    if ($hardware -and $hardware.gpu -and $hardware.gpu.memory) {
        if ($hardware.gpu.memory.dedicated_bytes) { $profileDedicated = [int64]$hardware.gpu.memory.dedicated_bytes }
        if ($hardware.gpu.memory.unified_bytes) { $profileUnified = [int64]$hardware.gpu.memory.unified_bytes }
    }
    if ($profileUnified -eq 0 -and $isUnifiedMemory) { $profileUnified = $effectiveGpuRam }
    if ($profileDedicated -eq 0 -and -not $isUnifiedMemory) { $profileDedicated = $effectiveGpuRam }

    $gpuMemoryDecision = @{
        dedicated_bytes     = $profileDedicated
        unified_bytes       = $profileUnified
        usable_bytes        = $effectiveGpuRam
        effective_bytes     = $effectiveGpuRam
        is_unified          = [bool]$isUnifiedMemory
        shared_memory_bytes = [Math]::Max([int64]0, [int64]$totalRam - $effectiveGpuRam)
        source              = if ($isUnifiedMemory) { 'unified' } elseif ($effectiveGpuRam -gt 0) { 'dedicated' } else { 'none' }
    }

    $recommended = @{
        backend = 'cpu'
        backend_label = 'CPU'
        context = 4096
        gpu_layers = 0
    }

    # Résolution des capacités réellement disponibles (cuda/rocm/vulkan/cpu).
    if (-not $Capabilities) { $Capabilities = Get-BackendCapabilities $hardware }
    $cudaAvailable = [bool]($Capabilities.cuda -and $Capabilities.cuda.available)
    $rocmAvailable = [bool]($Capabilities.rocm -and $Capabilities.rocm.available)
    $vkAvailable = [bool]($Capabilities.vulkan -and $Capabilities.vulkan.available)

    if ($vendor -in @('nvidia', 'amd', 'intel')) {
        # Un backend GPU annoncé par le matériel n'est retenu que si le runtime
        # correspondant est réellement présent ; sinon on retombe sur Vulkan, puis
        # CPU. On ne promet jamais une accélération non prouvée.
        if ($vendor -eq 'nvidia' -and $cudaAvailable) {
            $recommended.backend = 'cuda'
            $recommended.backend_label = 'NVIDIA CUDA'
            $recommended.backend_source = $Capabilities.cuda.source
        } elseif ($vendor -eq 'amd' -and $rocmAvailable) {
            $recommended.backend = 'rocm'
            $recommended.backend_label = 'AMD ROCm'
            $recommended.backend_source = $Capabilities.rocm.source
        } elseif ($vkAvailable) {
            $recommended.backend = 'vulkan'
            $recommended.backend_label = 'Vulkan'
            $recommended.backend_source = $Capabilities.vulkan.source
            if ($vendor -eq 'nvidia' -and -not $cudaAvailable) {
                $recommended.fallback_reason = 'CUDA indisponible : pilote/nvidia-smi non détecté'
            } elseif ($vendor -eq 'amd' -and -not $rocmAvailable) {
                $recommended.fallback_reason = 'ROCm indisponible : runtime AMD non détecté'
            }
        } else {
            $recommended.backend = 'cpu'
            $recommended.backend_label = 'CPU'
            $recommended.backend_source = 'fallback'
            $recommended.fallback_reason = 'aucun runtime GPU prouvé (CUDA/ROCm/Vulkan absents)'
        }

        if ($recommended.backend -ne 'cpu') { $recommended.gpu_layers = 999 }
        if ($isUnifiedMemory) { $recommended.unified_memory = $true }

        if ($effectiveGpuRam -ge 24 * $GB) {
            $recommended.context = 16384
        } elseif ($effectiveGpuRam -ge 12 * $GB) {
            $recommended.context = 8192
        } elseif ($effectiveGpuRam -ge 8 * $GB) {
            $recommended.context = 8192
        } elseif ($effectiveGpuRam -ge 6 * $GB) {
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

    $recommended.gpu_memory = $gpuMemoryDecision
    return $recommended
}

function Get-BackendPlan($hardware) {
    $capabilities = Get-BackendCapabilities $hardware
    $recommended = Get-RecommendedRuntimeConfig $hardware $capabilities
    $vendor = [string]$hardware.vendor

    # La cible du plan est le backend réellement recommandé (matériel + capacités
    # prouvées). Le seul fournisseur ne suffit plus à promettre une accélération.
    $backend = [string]$recommended.backend
    $label = [string]$recommended.backend_label

    # Source unique des candidats : l'installateur et scripts/lia.ps1 utilisent
    # exactement cette table (plus de liste dupliquée qui divergeait).
    $candidateTable = @{
        cuda   = @(
            @{ backend = 'cuda'; label = 'NVIDIA CUDA'; assetPattern = 'llama-.*-bin-win-cuda-13\.\d+-x64\.zip$' },
            @{ backend = 'cuda'; label = 'NVIDIA CUDA'; assetPattern = 'llama-.*-bin-win-cuda-12\.\d+-x64\.zip$' }
        )
        rocm   = @(
            @{ backend = 'rocm'; label = 'AMD ROCm'; assetPattern = 'llama-.*-bin-win-rocm.*x64\.zip$' }
        )
        vulkan = @(
            @{ backend = 'vulkan'; label = 'Vulkan'; assetPattern = 'llama-.*-bin-win-vulkan-x64\.zip$' }
        )
        cpu    = @(
            @{ backend = 'cpu'; label = 'CPU'; assetPattern = 'llama-.*-bin-win-cpu-x64\.zip$' }
        )
    }

    # Ordre : backend recommandé, puis Vulkan (repli GPU générique), puis CPU en
    # dernier recours. Aucun candidat n'est supprimé : si la détection est
    # incomplète (registre Vulkan illisible sans droits admin), le binaire reste
    # essayé et validé par exécution réelle.
    $order = @($backend)
    if ($vendor -ne 'cpu' -and $order -notcontains 'vulkan') { $order += 'vulkan' }
    if ($order -notcontains 'cpu') { $order += 'cpu' }

    $candidates = @()
    foreach ($name in $order) { $candidates += $candidateTable[$name] }

    # Les backends réellement prouvés passent en premier ; le CPU reste toujours
    # en dernier recours. Aucun candidat n'est supprimé : la validation finale se
    # fait sur le binaire (Test-LlamaBinary), pas sur une supposition.
    $proven = @()
    foreach ($name in @('cuda', 'rocm', 'vulkan')) {
        if ($capabilities.$name -and $capabilities.$name.available) { $proven += $name }
    }
    foreach ($c in $candidates) {
        $c['proven'] = [bool]($c.backend -eq 'cpu' -or $proven -contains $c.backend)
    }
    $ranked = @()
    foreach ($c in $candidates) {
        if ($c.backend -ne 'cpu' -and $proven -contains $c.backend) { $ranked += $c }
    }
    foreach ($c in $candidates) {
        if ($c.backend -ne 'cpu' -and $proven -notcontains $c.backend) { $ranked += $c }
    }
    foreach ($c in $candidates) { if ($c.backend -eq 'cpu') { $ranked += $c } }
    return @{
        backend               = $backend
        label                 = $label
        recommended_backend   = $recommended.backend
        recommended_source    = if ($recommended.backend_source) { $recommended.backend_source } else { '' }
        fallback_reason       = if ($recommended.fallback_reason) { $recommended.fallback_reason } else { '' }
        unified_memory        = [bool]$recommended.unified_memory
        gpu_memory            = $recommended.gpu_memory
        capabilities          = $capabilities
        proven_backends       = $proven
        recommended_context   = $recommended.context
        recommended_gpu_layers = $recommended.gpu_layers
        releaseCandidates     = $ranked
    }
}

function Save-HardwareProfile([hashtable]$Config, [hashtable]$profile) {
    try {
        $hardwareProfilePath = Join-Path $Config.rootDir $Config.paths.hardwareProfilePath

        # S'assurer que le répertoire parent existe
        $parentDir = Split-Path $hardwareProfilePath -Parent
        if (-not (Test-Path $parentDir)) {
            New-Item -ItemType Directory -Path $parentDir -Force | Out-Null
        }

        $existing = $null
        if (Test-Path $hardwareProfilePath) {
            try {
                $existing = Get-Content -Path $hardwareProfilePath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
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

        $jsonContent = $profile | ConvertTo-Json -Depth 6 -Compress
        [System.IO.File]::WriteAllText($hardwareProfilePath, $jsonContent, [System.Text.Encoding]::UTF8)

        OK "Profil matériel sauvegardé : $hardwareProfilePath (generation_count=$($profile.generation_count))"
    } catch {
        WARN "Impossible de sauvegarder le profil matériel: $($_.Exception.Message)"
    }
}