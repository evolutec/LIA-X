# installer\cleanup-stale-runtime.ps1
# Arrête les contrôleurs llama-host-controller et llama-server qui ne
# proviennent PAS de l'installation courante (ex. dépôt de développement).
# Conforme à Stop-ExistingController / Stop-LlamaServerProcess de modules/llama.ps1.
param(
    [Parameter(Mandatory = $true)][string]$InstallDir,
    [string]$ModelsDir = ''
)
$ErrorActionPreference = 'Continue'
$log = @()
try { $logPath = Join-Path $InstallDir 'logs\cleanup-runtime.log' } catch { $logPath = "$env:TEMP\cleanup-runtime.log" }

function Log([string]$m) { $script:log += $m }

# 1) Contrôleurs pwsh externes à l'installation (déçus d'un dépôt de dev, etc.)
$controllers = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
        $_.Name -in @('pwsh.exe', 'powershell.exe') -and
        $_.CommandLine -and $_.CommandLine -match 'llama-host-controller' -and
        $_.CommandLine -notmatch [regex]::Escape($InstallDir)
    }
foreach ($p in $controllers) {
    Log "Controller obsolète arrêté : PID $($p.ProcessId) — $($p.CommandLine)"
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}
if (-not $controllers) { Log 'Aucun contrôleur obsolète détecté.' }

# 2) Instances llama-server orphelines (elles seront relancées par le controller
#    installé selon host-runtime-state.json / premier import)
$llama = Get-Process -Name 'llama-server' -ErrorAction SilentlyContinue
foreach ($proc in $llama) {
    Log "llama-server orphelin arrêté : PID $($proc.Id)"
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
}
if (-not $llama) { Log 'Aucune instance llama-server orpheline.' }

# 3) Assainir l'état runtime (host-runtime-state.json) : retirer les instances
#    « fantômes » dont le GGUF n'existe plus dans le dossier de modèles créé par
#    l'installateur, et purger le modèle principal devenu orphelin.
#    Sans ça, le model-loader affichait des modèles « chargés » au premier
#    lancement alors qu'aucun fichier GGUF n'est présent sur le disque.
$statePath = Join-Path $InstallDir 'runtime\host-runtime-state.json'
if (-not $ModelsDir) { $ModelsDir = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'LIA-X\Models' }

if (Test-Path $statePath) {
    try {
        $raw = Get-Content -Path $statePath -Raw -ErrorAction Stop
        $state = if ([string]::IsNullOrWhiteSpace($raw)) { $null } else { $raw | ConvertFrom-Json -AsHashtable }
        if ($state -and $state.ContainsKey('instances') -and $state.instances) {
            $kept = @()
            $removed = @()
            foreach ($inst in @($state.instances)) {
                $record = if ($inst.filename) { [string]$inst.filename } else { [string]$inst.model }
                $candidates = @()
                if ($record) { $candidates += (Join-Path $ModelsDir $record) }
                if ($inst.path) { $candidates += [string]$inst.path }
                $exists = $false
                foreach ($candidate in $candidates) {
                    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { $exists = $true; break }
                }
                if ($exists) {
                    $kept += $inst
                } else {
                    $removed += [string]$inst.model
                }
            }
            if ($removed.Count -gt 0) {
                Copy-Item -Path $statePath -Destination "$statePath.bak" -Force -ErrorAction SilentlyContinue
                Log "Instances fantômes retirées de l'état runtime (GGUF absent) : $($removed -join ', ')"
                # Le modèle principal est-il justement l'un des fantômes retirés ?
                $activeWasRemoved = $false
                foreach ($inst in @($state.instances)) {
                    $record = if ($inst.filename) { [string]$inst.filename } else { [string]$inst.model }
                    if ($removed -contains [string]$inst.model -and ($inst.active -or [string]$inst.model -ieq [string]$state.active_model)) {
                        $activeWasRemoved = $true; break
                    }
                }
                $state.instances = @($kept)
                if ($kept.Count -eq 0) {
                    foreach ($key in 'active_model', 'active_filename', 'active_path', 'started_at') {
                        if ($state.ContainsKey($key)) { $state[$key] = '' }
                    }
                    Log "Aucune instance valide : modèle principal purgé de l'état runtime."
                } elseif ($activeWasRemoved) {
                    # Re-pointer le modèle principal vers une instance réelle restante
                    $newActive = $kept | Where-Object { $_.running } | Select-Object -First 1
                    if (-not $newActive) { $newActive = $kept[0] }
                    foreach ($inst in $kept) { $inst.active = ($inst.id -eq $newActive.id) }
                    $state.active_model    = [string]$newActive.model
                    $state.active_filename = [string]$newActive.filename
                    $state.active_path     = [string]$newActive.path
                    $state.started_at      = [string]$newActive.started_at
                    Log "Modèle principal re-pointé sur l'instance restante : $($newActive.model)"
                }
                $state | ConvertTo-Json -Depth 12 | Set-Content -Path $statePath -Encoding UTF8
                Log "État runtime assaini : $($kept.Count) instance(s) conservée(s)."
            } else {
                Log "État runtime cohérent : $($kept.Count) instance(s), aucun fantôme."
            }
        }
    } catch {
        Log "ATTENTION : assainissement de l'état runtime impossible : $($_.Exception.Message)"
    }
} else {
    Log "Aucun état runtime à assainir ($statePath absent)."
}

# 4) Résumé
try {
    New-Item -ItemType Directory -Path (Split-Path $logPath -Parent) -Force | Out-Null
    $log | Set-Content -Path $logPath -Encoding UTF8
} catch {}

exit 0
