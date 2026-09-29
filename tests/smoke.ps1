# ─────────────────────────────────────────────────────────────────────────────
# tests/smoke.ps1 — Tests de fumée LIA-X
# Usage : pwsh -File tests\smoke.ps1
# Valide, après chaque installation/reinstallation, que la chaîne complète
# fonctionne : controller → model-loader → llama-server → inférence.
# Code de sortie 0 = tout OK, 1 = au moins un échec.
# ─────────────────────────────────────────────────────────────────────────────
$ErrorActionPreference = 'Continue'
$failures = @()

function Assert-Condition([string]$Name, [bool]$Condition, [string]$Detail = '') {
    if ($Condition) {
        Write-Host "  [OK]   $Name" -ForegroundColor Green
    } else {
        Write-Host "  [FAIL] $Name : $Detail" -ForegroundColor Red
        $script:failures += "$Name : $Detail"
    }
}

function Invoke-JsonOrText([string]$Url, [int]$TimeoutSec = 15, [int]$Retries = 3) {
    # Retry : un /start en cours (chargement d'un gros GGUF = 30-60 s de
    # controller mono-thread bloqué) ne doit pas faire échouer le smoke.
    for ($i = 0; $i -le $Retries; $i++) {
        try {
            $resp = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec $TimeoutSec
            return @{ ok = $true; status = [int]$resp.StatusCode; body = $resp.Content; elapsed = 0 }
        } catch {
            if ($i -lt $Retries) { Start-Sleep -Seconds 10; continue }
            return @{ ok = $false; status = 0; body = $_.Exception.Message; elapsed = 0 }
        }
    }
}

Write-Host '=== LIA-X Smoke Tests ===' -ForegroundColor Cyan
$root = Split-Path -Parent $PSScriptRoot

# ── 1. Service controller ────────────────────────────────────────────────────
Write-Host "`n[1/7] Service 'LIA Controller'"
$svc = Get-Service 'LIA Controller' -ErrorAction SilentlyContinue
Assert-Condition 'Service present et demarre' ($svc -and $svc.Status -eq 'Running') "status=$(if($svc){$svc.Status}else{'absent'})"

# ── 2. Controller HTTP ───────────────────────────────────────────────────────
Write-Host "`n[2/7] Controller HTTP 13579"
$t0 = [Diagnostics.Stopwatch]::StartNew()
$status = Invoke-JsonOrText 'http://127.0.0.1:13579/status' 20
$t0.Stop()
Assert-Condition 'GET /status repond' ($status.ok -and $status.status -eq 200) $status.body
Assert-Condition 'Latence /status < 3 s' ($t0.ElapsedMilliseconds -lt 3000) "$([int]$t0.ElapsedMilliseconds) ms"
if ($status.ok) {
    try { $parsed = $status.body | ConvertFrom-Json } catch { $parsed = $null }
    Assert-Condition 'State parseable avec schema_version>=2' ($parsed -and $parsed.schema_version -ge 2) 'schema_version manquant (< 2)'
}

# ── 3. Pas de crash-loop ─────────────────────────────────────────────────────
Write-Host "`n[3/7] Stabilite (anti crash-loop)"
$debugLog = Join-Path $root 'logs\controller\controller-debug.log'
if (Test-Path $debugLog) {
    # On ne regarde que les 30 dernières minutes : un crash-loop historique
    # (log ancien) ne doit pas faire échouer le test.
    $cutoff = (Get-Date).AddMinutes(-30)
    $recent = Get-Content $debugLog -Tail 500 | ForEach-Object {
        if ($_ -match '^\[(.+?)\]') {
            try {
                $ts = [datetime]::Parse($Matches[1])
                if ($ts -ge $cutoff) { [pscustomobject]@{ ts = $ts; line = $_ } }
            } catch {}
        }
    }
    $startupTimes = @($recent | Where-Object { $_.line -match 'Startup: listener lie' } | ForEach-Object { $_.ts })
    $maxStartsInFiveMinutes = 0
    foreach ($startup in $startupTimes) {
        $count = @($startupTimes | Where-Object { $_ -ge $startup -and $_ -le $startup.AddMinutes(5) }).Count
        if ($count -gt $maxStartsInFiveMinutes) { $maxStartsInFiveMinutes = $count }
    }
    $bindFailCount = @($recent | Where-Object { $_.ts -ge (Get-Date).AddMinutes(-10) -and $_.line -match '\[BindFail\]' }).Count

    Assert-Condition 'Pas de crash-loop controller' `
        ($maxStartsInFiveMinutes -le 2 -and $bindFailCount -le 2) `
        "max=$maxStartsInFiveMinutes startups/5 min, bindfail=$bindFailCount/10 min"
} else {
    Write-Host '  [SKIP] controller-debug.log introuvable'
}

# ── 4. Model-loader (Docker) ─────────────────────────────────────────────────
Write-Host "`n[4/7] Model-loader 3005"
$health = Invoke-JsonOrText 'http://127.0.0.1:3005/health' 15
Assert-Condition 'GET /health repond' ($health.ok -and $health.status -eq 200) $health.body
if ($health.ok) {
    try { $h = $health.body | ConvertFrom-Json } catch { $h = $null }
    Assert-Condition 'Controller joignable depuis le container' ($h -and $h.controller_ok -eq $true) ($h?.detail ?? 'controller_ok=false')
}
$containerOk = $false
docker ps --format '{{.Names}}|{{.Status}}' 2>$null | ForEach-Object {
    if ($_ -match '^model-loader\|Up .*\(healthy\)') { $containerOk = $true }
}
Assert-Condition 'Container model-loader healthy' $containerOk 'container absent ou unhealthy'

# ── 5. Proxy OpenAI-compatible ───────────────────────────────────────────────
Write-Host "`n[5/7] Proxy OpenAI-compatible"
$models = Invoke-JsonOrText 'http://127.0.0.1:3005/v1/models' 15
Assert-Condition 'GET /v1/models repond' ($models.ok -and $models.status -eq 200) $models.body

# ── 6. Inférence réelle (si un modèle est actif) ─────────────────────────────
Write-Host "`n[6/7] Inférence chat (modele principal)"
try {
    $chatBody = @{ model = 'lia-local'; messages = @(@{ role = 'user'; content = 'Dis OK.' }); max_tokens = 24; stream = $false } | ConvertTo-Json -Depth 5
    $chat = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3005/v1/chat/completions' -Method POST -ContentType 'application/json' -Body $chatBody -TimeoutSec 120
    Assert-Condition 'POST /v1/chat/completions 200' ($chat.StatusCode -eq 200) "status=$($chat.StatusCode)"
    try {
        $message = ($chat.Content | ConvertFrom-Json).choices[0].message
        # Les modèles "reasoning" (ex: Qwopus) remplissent reasoning_content et
        # laissent content vide tant que la réflexion n'est pas terminée :
        # les deux sont acceptés.
        $text = @($message.content, $message.reasoning_content) |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -First 1
        Assert-Condition 'Reponse non vide (content ou reasoning_content)' (-not [string]::IsNullOrWhiteSpace($text)) 'contenu vide'
    } catch {
        Assert-Condition 'Reponse JSON exploitable' $false $chat.Content
    }
} catch {
    Assert-Condition 'POST /v1/chat/completions 200' $false $_.Exception.Message
}

# ── 7. Embeddings (si un modèle compatible existe) ───────────────────────────
Write-Host "`n[7/7] Embeddings"
$embeddingModel = $null
try {
    $embeddingPref = Invoke-JsonOrText 'http://127.0.0.1:3005/api/embedding-model' 15
    if ($embeddingPref.ok -and $embeddingPref.status -eq 200) {
        $pref = $embeddingPref.body | ConvertFrom-Json
        if ($pref.embedding_model) { $embeddingModel = [string]$pref.embedding_model }
    }
} catch {}

if (-not $embeddingModel) {
    try {
        $available = Invoke-JsonOrText 'http://127.0.0.1:3005/api/models/available' 20
        if ($available.ok -and $available.status -eq 200) {
            $files = @((($available.body | ConvertFrom-Json).files))
            $embeddingModel = @($files | Where-Object {
                $name = [string]$_.name
                $lower = $name.ToLowerInvariant()
                $lower -eq 'nomic-embed-text' -or
                $lower.StartsWith('nomic-embed-text') -or
                $lower -eq 'qwen3-embedding-4b' -or
                $lower.StartsWith('qwen3-embedding-4b') -or
                $lower.StartsWith('all-minilm') -or
                $lower.StartsWith('embed')
            } | Select-Object -First 1).name
        }
    } catch {}
}

if (-not $embeddingModel) {
    Write-Host '  [SKIP] Aucun modèle local compatible embedding détecté'
} else {
    try {
        $embeddingBody = @{ model = $embeddingModel; input = 'test embedding lia-x' } | ConvertTo-Json -Depth 4
        $embedding = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3005/v1/embeddings' -Method POST -ContentType 'application/json' -Body $embeddingBody -TimeoutSec 180
        Assert-Condition 'POST /v1/embeddings 200' ($embedding.StatusCode -eq 200) "status=$($embedding.StatusCode)"
        try {
            $parsedEmbedding = $embedding.Content | ConvertFrom-Json
            $vector = @($parsedEmbedding.data)[0].embedding
            Assert-Condition 'Vecteur embedding non vide' ($vector -and @($vector).Count -gt 0) 'embedding vide'
        } catch {
            Assert-Condition 'Réponse embeddings JSON exploitable' $false $embedding.Content
        }
    } catch {
        Assert-Condition 'POST /v1/embeddings 200' $false $_.Exception.Message
    }
}

# ── Bilan ────────────────────────────────────────────────────────────────────
Write-Host "`n=== BILAN ===" -ForegroundColor Cyan
if ($failures.Count -eq 0) {
    Write-Host 'TOUS LES TESTS PASSENT ✅' -ForegroundColor Green
    exit 0
} else {
    Write-Host "$($failures.Count) ECHEC(S) :" -ForegroundColor Red
    $failures | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
    exit 1
}
