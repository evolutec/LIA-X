# Recréation des conteneurs d'interfaces avec les versions FIGÉES.
# Généré à partir de installer/scripts/postinstall.ps1 (mêmes options, même ordre).
# Les volumes et les secrets existants sont conservés.
$ErrorActionPreference = 'Continue'
$secrets = Get-Content 'C:\Program Files\LIA-X\runtime\secrets.json' -Raw | ConvertFrom-Json

function Step($m) { Write-Host "== $m" -ForegroundColor Cyan }

Step 'Réseau'
docker network inspect lia-network *> $null
if ($LASTEXITCODE -ne 0) { docker network create lia-network | Out-Null }

Step 'LibreChat (digest figé)'
docker rm -f librechat-mongo librechat 2>$null | Out-Null
docker run -d --name librechat-mongo --network lia-network -v librechat-mongo:/data/db --restart unless-stopped mongo:6 | Out-Null
docker run -d --name librechat --network lia-network -p 3007:3080 --add-host host.docker.internal:host-gateway `
  -e CONFIG_PATH=/app/librechat.yaml `
  -e MONGO_URI=mongodb://librechat-mongo:27017/LibreChat `
  -e "JWT_SECRET=$($secrets.librechat_jwt_secret)" `
  -e "JWT_REFRESH_SECRET=$($secrets.librechat_jwt_refresh)" `
  -e ALLOW_EMAIL_LOGIN=true -e ALLOW_REGISTRATION=true -e ALLOW_SOCIAL_LOGIN=false `
  -e OPENAI_API_KEY=not-used `
  -e OPENAI_BASE_URL=http://lia-x:3005/v1 `
  -e OPENAI_API_BASE_URL=http://lia-x:3005/v1 `
  -e OPENAI_API_BASE_URLS=http://lia-x:3005/v1 `
  -e OPENAI_REVERSE_PROXY=http://lia-x:3005/v1 `
  -e OPENAI_MODELS_FETCH=true -e OPENAI_MODELS=lia-local `
  -e AUTO_FETCH_MODELS=true `
  -e ENABLE_OPENAI=true -e OPENAI_PROXY_ENABLED=true `
  -e DISABLE_TELEMETRY=true `
  -v librechat-data:/app/api/data --restart unless-stopped `
  ghcr.io/danny-avila/librechat@sha256:c5db3331b845e1f289f8d04c0c77936c4bbe372f76730a804abc1c37e44d23a9 | Out-Null

Step 'Open WebUI v0.11.4'
docker rm -f openwebui 2>$null | Out-Null
docker run -d --name openwebui --network lia-network -p 3008:8080 --add-host host.docker.internal:host-gateway `
  -e WEBUI_AUTH=False -e "WEBUI_SECRET_KEY=$($secrets.webui_secret)" `
  -e ENABLE_OLLAMA_API=false -e ENABLE_OPENAI_API=true `
  -e OPENAI_API_BASE_URL=http://lia-x:3005/v1 `
  -e OPENAI_API_BASE_URLS=http://lia-x:3005/v1 `
  -e OPENAI_API_KEYS=not-used -e OPENAI_API_KEY=not-used `
  -v open-webui-data:/app/backend/data --restart unless-stopped `
  ghcr.io/open-webui/open-webui:v0.11.4 | Out-Null

Step 'AnythingLLM 1.17.0'
docker rm -f anythingllm 2>$null | Out-Null
docker run -d --name anythingllm --network lia-network -p 3006:3001 --add-host host.docker.internal:host-gateway `
  -e STORAGE_DIR=/app/server/storage -e LLM_PROVIDER=generic-openai `
  -e GENERIC_OPEN_AI_BASE_PATH=http://lia-x:3005/v1 `
  -e GENERIC_OPEN_AI_MODEL_PREF=lia-local -e GENERIC_OPEN_AI_API_KEY=not-used `
  -e GENERIC_OPEN_AI_MODEL_TOKEN_LIMIT=8192 -e EMBEDDING_ENGINE=native `
  -v anythingllm-storage:/app/server/storage --restart unless-stopped `
  mintplexlabs/anythingllm:1.17.0 | Out-Null

Start-Sleep -Seconds 20
docker ps --format '{{.Names}}|{{.Status}}' | Out-File "$env:TEMP\containers-final.txt" -Encoding utf8
Write-Host 'TERMINE'
