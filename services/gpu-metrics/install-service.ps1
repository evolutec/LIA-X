# services/gpu-metrics/install-service.ps1
# Script d'installation du service LIA GPU Metrics
# À exécuter en tant qu'administrateur

param(
    [string]$RootDir = (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
)

$ErrorActionPreference = 'Stop'

# Importer les helpers communs
$helpersPath = Join-Path $PSScriptRoot '..\shared\service-helpers.ps1'
. $helpersPath

function Stop-LegacyGpuMetricsProcesses {
    $legacyProcesses = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -match 'gpu-metrics-service\.ps1' }

    foreach ($proc in $legacyProcesses) {
        Write-Host "Arrêt du processus GPU metrics legacy PID $($proc.ProcessId) : $($proc.CommandLine)"
        try {
            Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
        } catch {
            Write-Warning "Impossible d'arrêter le processus $($proc.ProcessId) : $($_.Exception.Message)"
        }
    }
}

# Nettoyer les anciens processus GPU metrics avant d'installer le service
Stop-LegacyGpuMetricsProcesses

# LIA GPU Metrics: service de métriques système et GPU
$gpuMetricsScript = Join-Path $PSScriptRoot 'service.ps1'
Install-Or-Update-LiaService -ServiceName 'LIA GPU Metrics' -DisplayName 'LIA GPU Metrics' -Description 'Service de metriques GPU et systeme LIA' -ScriptPath $gpuMetricsScript -ExpectedPort 13620 -RootDir $RootDir

Write-Host "Installation du service LIA GPU Metrics terminée."