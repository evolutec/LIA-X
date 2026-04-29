# modules/llama.ps1
# Fonctions pour la gestion de llama.cpp

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
    $runtimeConfigPath = Join-Path $Config.rootDir $Config.paths.runtimeConfigPath
    if (-not (Test-Path $runtimeConfigPath)) {
        return
    }

    $config = Get-Content $runtimeConfigPath -Raw | ConvertFrom-Json
    $updated = $false

    if ($config.server_port -ne $Config.ports.llama) {
        $config.server_port = $Config.ports.llama
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
        OK "Configuration runtime existante normalisée sur Vulkan"
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
    Write-Host "Dernière version : $latestTag" -ForegroundColor Gray

    # En mode automatisé, ne pas mettre à jour automatiquement
    if ($env:CI -or $env:AUTOMATED_TEST) {
        Write-Host "Mode automatisé : conservation de la version locale" -ForegroundColor Yellow
        return $false
    }

    do {
        try {
            $answer = Read-Host 'Voulez-vous télécharger et remplacer le binaire existant ? [O/N]'
            if ($answer) {
                $normalized = $answer.Trim().ToUpper()
                if ($normalized -in @('O', 'OUI', 'Y', 'YES', 'N', 'NON', 'NO')) {
                    return $normalized -in @('O', 'OUI', 'Y', 'YES')
                }
            }
        } catch {
            # En cas d'erreur (pas d'entrée interactive), ne pas mettre à jour
            Write-Host "Mode non-interactif : conservation de la version locale" -ForegroundColor Yellow
            return $false
        }
    } while ($true)
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
    $releaseRoot = Join-Path $Config.rootDir $Config.paths.runtimeDir 'llama-releases'
    Ensure-Directory $releaseRoot

    # Vérifier la dernière version sur GitHub dès que possible.
    $latestRelease = $null
    try {
        $latestRelease = Invoke-RestMethod -Uri 'https://api.github.com/repos/ggml-org/llama.cpp/releases/latest' -Headers @{ 'User-Agent' = 'LIA-setup' }
    } catch {
        WARN "Impossible de récupérer la dernière release llama.cpp. Le binaire local sera utilisé si disponible."
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

                        INFO "Téléchargement de la nouvelle release llama.cpp : $($asset.name)"
                        Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $archivePath -Headers @{ 'User-Agent' = 'LIA-setup' }

                        if (Test-Path $releaseDir) {
                            Remove-Item $releaseDir -Recurse -Force -ErrorAction Stop
                        }

                        Expand-Archive -Path $archivePath -DestinationPath $releaseDir -Force

                        $binaryPath = Get-LlamaServerBinaryFromDirectory $releaseDir
                        if ($binaryPath) {
                            INFO "Mise à jour de llama.cpp terminée : $($releaseDir)"
                            Cleanup-OldLlamaReleaseDirectories $releaseRoot $candidate.backend $releaseDir $candidate.assetPattern
                            return @{ backend = $candidate.backend; label = $candidate.label; binaryPath = $binaryPath; source = 'release'; buildDir = $releaseDir }
                        }

                        WARN "Le binaire téléchargé ne contient pas llama-server.exe : $($asset.name)"
                    } else {
                        WARN "Aucun asset correspondant trouvé pour le backend $($candidate.backend) sur la release $($latestRelease.tag_name)."
                    }

                    INFO "Réutilisation du binaire local existant : $($dir.Name)"
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
        WARN "Aucune release distante disponible et aucun binaire local compatible n'a été trouvé."
        return $null
    }

    foreach ($candidate in $candidates) {
        $asset = $latestRelease.assets | Where-Object { $_.name -match $candidate.assetPattern } | Select-Object -First 1
        if (-not $asset) {
            continue
        }

        $releaseDir = Join-Path $releaseRoot ("{0}-{1}" -f $latestRelease.tag_name, $candidate.backend)
        $archivePath = Join-Path $releaseRoot $asset.name

        INFO "Téléchargement du binaire officiel llama.cpp : $($asset.name)"
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

        WARN "Le binaire téléchargé ne contient pas llama-server.exe : $($asset.name)"
    }

    WARN "Aucun binaire précompilé compatible n'a pu être préparé."
    return $null
}

function Build-LlamaCpp($plan) {
    $runtimeDir = Join-Path $Config.rootDir $Config.paths.runtimeDir
    Ensure-Directory $runtimeDir

    $releaseResult = Try-DownloadLlamaCppRelease $plan
    if ($releaseResult) {
        return $releaseResult
    }

    throw "Aucun binaire llama.cpp précompilé compatible trouvé pour le backend $($plan.label). Compilation native désactivée."
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
        throw "llama-server.exe introuvable après compilation."
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
            $still = Get-NetTCPConnection -LocalPort $Config.ports.llama -ErrorAction SilentlyContinue
            if (-not $still) { break }
        }
    }
}

function Stop-ExistingController {
    $connections = Get-NetTCPConnection -LocalPort $Config.ports.controller -State Listen -ErrorAction SilentlyContinue
    foreach ($conn in @($connections)) {
        Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
    }
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 500
        $still = Get-NetTCPConnection -LocalPort $Config.ports.controller -ErrorAction SilentlyContinue
        if (-not $still) { break }
    }
}