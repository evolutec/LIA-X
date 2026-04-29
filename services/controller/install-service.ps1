# services/controller/install-service.ps1
# Script d'installation du service LIA Controller
# À exécuter en tant qu'administrateur

param(
    [string]$RootDir = (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
)

$ErrorActionPreference = 'Stop'

# Importer les helpers communs
$helpersPath = Join-Path $PSScriptRoot '..\shared\service-helpers.ps1'
. $helpersPath

function Stop-LegacyControllerProcesses {
    $legacyProcesses = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -match 'llama-host-controller\.ps1' }

    foreach ($proc in $legacyProcesses) {
        Write-Host "Arrêt du processus legacy PID $($proc.ProcessId) : $($proc.CommandLine)"
        try {
            Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
        } catch {
            Write-Warning "Impossible d'arrêter le processus $($proc.ProcessId) : $($_.Exception.Message)"
        }
    }
}

# Nettoyer les anciens processus de contrôleur avant d'installer le service
Stop-LegacyControllerProcesses

# LIA Controller: service principal qui lance llama-host-controller.ps1
$controllerScript = Join-Path $PSScriptRoot 'llama-host-controller.ps1'
Install-Or-Update-LiaService -ServiceName 'LIA Controller' -DisplayName 'LIA Controller' -Description 'Service de controle hote LIA' -ScriptPath $controllerScript -ExpectedPort 13579 -RootDir $RootDir

Write-Host "Installation du service LIA Controller terminée."