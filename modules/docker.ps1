# modules/docker.ps1
# Fonctions Docker communes

function Ensure-DockerNetwork([string]$name) {
    docker network inspect $name *> $null
    if ($LASTEXITCODE -ne 0) {
        docker network create $name | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "Création du réseau Docker impossible : $name"
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
            throw "Impossible de rattacher $name au réseau Docker $network."
        }
    }
}

function Start-DockerContainer {
    param(
        [string]$ContainerName,
        [string]$ImageName,
        [string]$LiaImageName,
        [string]$InternalPort,
        [string]$ExternalPort,
        [string]$NetworkName,
        [hashtable]$Config,
        [string[]]$AdditionalArgs = @(),
        [string]$VolumeMapping = "",
        [string]$HealthCheckUrl = "",
        [switch]$UseBaseImage
    )

    Remove-Container $ContainerName

    $existing = docker inspect $ContainerName 2>&1
    if ($LASTEXITCODE -eq 0) {
        $state = $existing | ConvertFrom-Json
        if ($state[0].State.Running -eq $true -and $state[0].State.Status -eq 'running') {
            OK "$ContainerName déjà en fonctionnement"
            return
        }
        Remove-Container $ContainerName
    }

    # Détection flexible du Dockerfile
    $dockerfileCandidates = @(
        (Join-Path $Config.rootDir "Dockerfiles\Dockerfile.$ContainerName"),
        (Join-Path $Config.rootDir "Dockerfiles\Dockerfile.lia-$ContainerName"),
        (Join-Path $Config.rootDir "Dockerfiles\Dockerfile.$($ContainerName -replace '^lia-', '')")
    )
    $dockerfilePath = $dockerfileCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $dockerfilePath) {
        throw "Dockerfile introuvable pour $ContainerName (candidats : $($dockerfileCandidates -join ', '))"
    }

    $runImageName = $LiaImageName
    if ($UseBaseImage) {
        $runImageName = $ImageName
        INFO "Utilisation de l'image Docker existante $runImageName"
        docker image inspect $runImageName *> $null
        if ($LASTEXITCODE -ne 0) {
            INFO "Image absente localement, téléchargement : $runImageName"
            docker pull $runImageName
            if ($LASTEXITCODE -ne 0) {
                throw "Téléchargement de l'image $runImageName impossible."
            }
        }
    } else {
        # Build de l'image LIA personnalisée. Docker réutilise déjà le cache
        # local; --cache-from sur une image locale produit des erreurs de
        # manifest avec BuildKit quand l'image n'existe pas en registry.
        INFO "Construction de l'image Docker $LiaImageName"
        $buildArgs = @('build', '-t', $LiaImageName, '-f', $dockerfilePath, $Config.rootDir)
        docker @buildArgs
        if ($LASTEXITCODE -ne 0) {
            throw "Build du conteneur $ContainerName impossible."
        }
    }

    $args = @(
        'run', '-d',
        '--name', $ContainerName,
        '--network', $NetworkName,
        '-p', ("{0}:{1}" -f $ExternalPort, $InternalPort),
        '--add-host', 'host.docker.internal:host-gateway'
    )

    if ($VolumeMapping) {
        $args += @('-v', $VolumeMapping)
    }

    $args += @('--restart', 'unless-stopped')
    $args += $AdditionalArgs
    $args += $runImageName

    docker @args | Out-Null

    if ($HealthCheckUrl) {
        $maxTries = $Config.timeout.httpRetries
        $delay = $Config.timeout.httpDelay
        if (-not (Wait-HttpOk -url $HealthCheckUrl -maxTries $maxTries -delay $delay)) {
            WARN "$ContainerName met plus de temps à répondre."
        } else {
            OK "$ContainerName prêt sur http://localhost:$ExternalPort"
        }
    } else {
        OK "$ContainerName démarré"
    }
}
