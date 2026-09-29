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

# LIA Controller: service principal qui lance llama-host-controller.ps1
# IMPORTANT : ne PAS tuer les processus ici. Install-Or-Update-LiaService
# gère l'ordre critique lui-même : suppression du service AVANT l'arrêt des
# processus, sinon NSSM (AppThrottle) relance un controller entre deux kills
# et le port 13579 ne se libère jamais (cause du crash-loop historique).
$controllerScript = Join-Path $PSScriptRoot 'llama-host-controller.ps1'
Install-Or-Update-LiaService -ServiceName 'LIA Controller' -DisplayName 'LIA Controller' -Description 'Service de controle hote LIA' -ScriptPath $controllerScript -ExpectedPort 13579 -RootDir $RootDir -ProcessPattern 'llama-host-controller\.ps1'

Write-Host "Installation du service LIA Controller terminée."
