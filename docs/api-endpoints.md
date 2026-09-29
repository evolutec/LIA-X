# LIA API Endpoints

## Vue d'ensemble

LIA expose deux couches principales d'API :

- **Contrôleur hôte** (`controller`), service Windows / script PowerShell sur le port `13579`
  - gestion des instances `llama-server`
  - démarrage / arrêt / redémarrage de modèles
- **Model Loader / UI** (`model-manager`), serveur Node.js sur `3002`
  - proxy OpenAI compatible `/v1`
  - API de découverte, chargement et sélection des modèles

## Open WebUI / AnythingLLM attentes

### Open WebUI

- `ENABLE_OPENAI_API=true`
- `OPENAI_API_BASE_URL=http://model-loader:3002`
- `OPENAI_API_BASE_URLS=http://model-loader:3002`
- `OPENAI_API_KEYS=not-used`
- `OPENAI_API_KEY=not-used`

Open WebUI utilise le proxy OpenAI du Model Loader pour parler au modèle principal via `lia-local`.

### AnythingLLM

- `LLM_PROVIDER=generic-openai`
- `GENERIC_OPEN_AI_BASE_PATH=http://model-loader:3002/v1`
- `GENERIC_OPEN_AI_MODEL_PREF=lia-local`

AnythingLLM envoie ses requêtes OpenAI vers le Model Loader et préfère le modèle stable `lia-local`.

## Contrôleur hôte (port 13579)

### Endpoints disponibles

- `GET /health`
  - Renvoie l'état du contrôleur.
- `GET /status`
  - Renvoie l'état runtime actuel et les instances chargées.
- `POST /start`
  - Démarre ou active un modèle.
  - Payload attendu : `{ "model": "<filename>.gguf", "context": <int>, "activate": <bool> }`
- `POST /stop`
  - Arrête un modèle.
  - Payload attendu : `{ "model": "<modelName>" }`
- `POST /restart`
  - Redémarre un modèle.
  - Payload attendu : `{ "model": "<modelName>", "id": "<instanceId>", "proxy_id": "<proxyId>", "port": <port> }`

> Important : le contrôleur **n'expose pas** d'API OpenAI `/v1/*`. Il gère uniquement le runtime et le cycle de vie des instances.

## Model Loader / serveur UI (port 3002)

### API de gestion des modèles

- `GET /health`
  - Vérifie que le serveur Model Loader est disponible.
- `GET /api/version`
  - Renvoie la version, le backend, et l'URL runtime.
- `GET /api/models/available`
  - Liste les fichiers GGUF disponibles sur disque.
- `GET /api/models`
  - Liste les modèles chargés en mémoire.
- `GET /api/modeles`
  - Alias francophone pour `/api/models`.
- `GET /modeles`
  - Alias direct ajouté pour la liste des modèles chargés.
- `GET /api/models/active`
  - Renvoie le modèle principal actuellement actif.
- `GET /api/models/status`
  - Statut détaillé, métriques et logs.
- `GET /api/models/details/:model`
  - Détails GGUF pour un modèle donné.
- `POST /api/models/download`
  - Télécharge un modèle GGUF.
- `POST /api/models/load`
  - Charge un modèle en mémoire sans l'activer.
- `POST /api/models/select`
  - Charge et active un modèle principal.
- `POST /api/models/unload`
  - Décharge un modèle.

### API OpenAI-compatible

- `GET /v1/models`
  - Renvoie le catalogue des modèles disponibles et l'état du proxy.
- `POST /v1/chat/completions`
- `POST /v1/completions`
- `POST /v1/embeddings`

### Alias de compatibilité

- `GET /models`
  - Alias vers `/v1/models`.
- `POST /chat/completions`
- `POST /completions`
- `POST /embeddings`

### Comportement du proxy `lia-local`

- `lia-local` est un identifiant stable pour le modèle principal.
- Si `model` est absent ou égal à `lia-local`, le serveur utilise le modèle actif courant.
- Les autres modèles chargés restent consultables via `/api/models`, `/api/modeles` ou `/modeles`.

## Résumé des attentes

- Le **modèle principal** doit être accessible via le proxy OpenAI du Model Loader sur `/v1/*` avec `model=lia-local` ou sans préciser de `model`.
- Les **modèles chargés** doivent être visibles via `/api/models`, `/api/modeles` et `/modeles`.
- Le **contrôleur** sur `13579` est uniquement un backend de gestion de runtime, pas un endpoint utilisateur OpenAI.
