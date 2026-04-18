# Project Instructions

This repository is built around a Dockerized `model-loader` service (`lia-model-loader`) and a Windows runtime controller (`llama-host-controller.ps1`). To keep changes effective and avoid stale behavior, follow these rules strictly:

1. Rebuild and restart the Docker container for any code changes in:
   - `model-manager/server.js`
   - `model-manager/src/**/*`
   - `Dockerfile.model-loader`
   - any runtime or controller integration that affects `model-loader`

2. After rebuilding, restart the `model-loader` container with the same runtime environment:
   - image: `lia-model-loader:latest`
   - container name: `model-loader`
   - host network access to `host.docker.internal:13579`
   - mount `/models` and `/runtime` as configured in `lia.ps1`

3. Always verify the runtime controller before trusting `model-loader`:
   - ensure `llama-host-controller.ps1` is running on port `13579`
   - verify `http://host.docker.internal:13579/status` is reachable from inside `model-loader`
   - verify `http://localhost:3002/health` returns an OK response from `model-loader`

4. When unloading a model:
   - target a specific model name in `/api/models/unload`
   - do not send an empty stop payload when multiple instances may exist
   - verify the corresponding `llama-server` process has exited

5. Validate service behavior after restart:
   - `/api/version` should return `200 OK`
   - `/api/modeles` should reflect current loaded models and active model
   - `/v1/models` should report the stable proxy `lia-local` and the active model

Example prompts to apply this rule:
- "Rebuild the `lia-model-loader` container after changes to `model-manager/server.js`."
- "Verify `host.docker.internal:13579` is reachable from inside the `model-loader` container before testing the UI."
- "After unloading a model, confirm the matching `llama-server` process has stopped."

This is a project-specific hard convention: container-backed changes must be deployed through Docker build/restart and validated with both controller and model-manager health checks.