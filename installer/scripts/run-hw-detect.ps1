# installer\scripts\run-hw-detect.ps1
# ENVELOPPE de detect-hardware.ps1 pour l'installateur Inno Setup.
#
# POURQUOI CE WRAPPER EST NECESSAIRE
# ---------------------------------
# L'installateur doit (a) capturer toute la sortie de la detection materielle
# dans <InstallDir>\logs\hw-detect.log et (b) propager le code de sortie reel
# du script. Ces deux choses sont incompatibles avec un appel direct depuis
# Inno, car le parametre `Params` de Exec() est passe VERBATIM a CreateProcess :
# il n'y a pas de shell intermediaire. Donc `-File detect-hardware.ps1 ... *>&1
# | Tee-Object -FilePath ...` n'est PAS interprete : `*>&1`, `|`,
# `Tee-Object`, `-FilePath` et le chemin du log sont recus par
# detect-hardware.ps1 comme arguments positionnels supplementaires. Le binding
# de parametres echoue (il n'attend que RootDir/ModelsDir/ControllerPort/
# LlamaPort), le script sort en erreur -> ResultCode <> 0 -> l'installateur
# leve « Detection materielle echouee » alors que la detection fonctionne tres
# bien en ligne de commande.
#
# Memes pieges corriges ici :
#   - `cmd.exe /c ... > log 2>&1` : `>` et `2>&1` sont des operateurs
#     PowerShell, pas cmd ; via cmd.exe la redirection echouait silencieusement.
#   - `-RedirectStandardOutput` : ce parametre n'existe que sur l'hote pwsh
#     (Pwsh.exe -> Start-Process), pas sur pwsh.exe en ligne de commande
#     (« Nous ne pouvons pas trouver un parametre qui correspond »).
#
# Ici la redirection est faite PAR PowerShell, dans le script : c'est le seul
# niveau ou `*>&1` et le pipeline sont reellement interpretes.
param(
    [Parameter(Mandatory = $true)][string]$RootDir,
    [string]$ModelsDir = '',
    [string]$LogPath = '',
    [int]$ControllerPort = 13579,
    [int]$LlamaPort = 12434
)

$ErrorActionPreference = 'Continue'
# On ne laisse pas une erreur de redirection masquer le resultat de la
# detection : le log est un confort de diagnostic, pas un juge de succes.
if ($LogPath) {
    $logDir = Split-Path -Parent $LogPath
    if ($logDir -and -not (Test-Path -LiteralPath $logDir)) {
        New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    }
}

# detect-hardware.ps1 vit dans le meme dossier (installer\scripts\).
# On le cherche ici en premier ; les deux autres chemins sont des replis pour
# une installation ancienne (avant deplacement) ou une execution depuis le depot.
$detector = Join-Path $PSScriptRoot 'detect-hardware.ps1'
if (-not (Test-Path -LiteralPath $detector)) {
    $detector = Join-Path $PSScriptRoot '..\detect-hardware.ps1'
}
if (-not (Test-Path -LiteralPath $detector)) {
    $detector = Join-Path $RootDir 'installer\scripts\detect-hardware.ps1'
}
if (-not (Test-Path -LiteralPath $detector)) {
    $detector = Join-Path $RootDir 'detect-hardware.ps1'
}
if (-not (Test-Path -LiteralPath $detector)) {
    Write-Error "detect-hardware.ps1 introuvable (cherche dans : $PSScriptRoot, $PSScriptRoot\.., $RootDir\installer\scripts et $RootDir)."
    exit 2
}

$detectArgs = @{
    RootDir       = $RootDir
    ModelsDir     = $ModelsDir
    ControllerPort = $ControllerPort
    LlamaPort     = $LlamaPort
}

# `*>&1` fusionne stdout/stderr/warnings dans le flux de sortie, `Tee-Object`
# ecrit dans le log ET laisse passer vers la sortie de cet enveloppeur (que
# l'installateur recupere via son propre mecanisme de log).
& $detector @detectArgs *>&1 | Tee-Object -FilePath $LogPath
$code = $LASTEXITCODE

# Si le script appelant n'a pas positionne LASTEXITCODE (versions anciennes de
# detect-hardware.ps1 sans `exit`), on considere que l'absence d'erreur
# terminante vaut succes.
if ($null -eq $code) { $code = 0 }
exit $code
