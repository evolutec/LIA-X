<div align="center">

<img src="./model-manager/public/logo.svg" width="150" alt="LIA Logo" />

<h1>LIA-X</h1>

<p><strong>Local Intelligence Assistant pour Windows, Docker et llama.cpp</strong></p>

<p>
  Stack IA locale orientée Windows avec un runtime <strong>llama.cpp</strong>, un contrôleur hôte PowerShell,
  un <strong>Model Loader</strong> GGUF, et les frontends <strong>AnythingLLM</strong>, <strong>Open WebUI</strong> et <strong>LibreChat</strong>.
</p>

<p>
  <img alt="Windows 11" src="https://img.shields.io/badge/Windows-11-0078D4?style=for-the-badge&logo=windows&logoColor=white">
  <img alt="Docker Desktop" src="https://img.shields.io/badge/Docker-Desktop-2496ED?style=for-the-badge&logo=docker&logoColor=white">
  <img alt="llama.cpp" src="https://img.shields.io/badge/llama.cpp-native-111111?style=for-the-badge">
  <img alt="Multi-LLM" src="https://img.shields.io/badge/Multi--LLM-parallel-2EA043?style=for-the-badge">
  <img alt="LibreChat" src="https://img.shields.io/badge/LibreChat-ready-7C3AED?style=for-the-badge">
</p>

</div>

## Table des matières

- [Vue d'ensemble](#vue-densemble)
- [Nouveautés de cette version](#nouveautés-de-cette-version)
- [Services inclus](#services-inclus)
- [Architecture](#architecture)
- [Flux d'utilisation](#flux-dutilisation)
- [Fonctionnalités clés](#fonctionnalités-clés)
- [Structure du projet](#structure-du-projet)
- [Notes techniques](#notes-techniques)
- [Commandes utiles](#commandes-utiles)
- [Dépannage](#dépannage)

## Vue d'ensemble

LIA-X est une stack IA locale pensée pour Windows. La couche applicative s'exécute dans Docker, tandis que le script PowerShell sert de bootstrap pour l'installation des prérequis, la préparation du runtime et la configuration initiale.

Le runtime d'inférence reste piloté sur l'hôte Windows via [controller/llama-host-controller.ps1](controller/llama-host-controller.ps1), et les conteneurs accèdent au service local par `host.docker.internal`. Cette séparation garde une base simple à maintenir tout en permettant plusieurs interfaces web au-dessus du même socle de modèles.

## Nouveautés de cette version

- Plusieurs modèles GGUF peuvent maintenant être chargés en parallèle. Le contrôleur hôte gère plusieurs instances `llama-server`, attribue un port libre dans la plage `12434-12444`, et conserve l'état de chaque instance dans [runtime/host-runtime-state.json](runtime/host-runtime-state.json).
- Le modèle principal est celui qui est servi à AnythingLLM via le proxy `lia-local`, tandis que les modèles chargés sont exposés via `/api/models` (avec `/api/modeles` comme alias) pour LibreChat et AnythingLLM.
- Le Model Loader expose un proxy OpenAI-compatible stable via l'identifiant `lia-local`, tout en affichant l'état des modèles chargés, les métadonnées GGUF et le modèle principal.
- LibreChat a été ajouté comme frontend supplémentaire, avec une image Docker dédiée, une configuration préintégrée et un backend MongoDB associé.
- Les frontends AnythingLLM, Open WebUI et LibreChat sont désormais déployés comme conteneurs Docker distincts sur un même réseau applicatif.
- Le script [install.ps1](install.ps1) sert désormais de wrapper pour [scripts/lia.ps1](scripts/lia.ps1) et initialise la stack.
- Le contrôleur hôte détecte automatiquement le meilleur backend disponible, avec priorité CUDA pour NVIDIA, Vulkan pour AMD/Intel, puis CPU en repli.

## Services inclus

| Service | URL | Rôle |
|---|---|---|
| Model Loader | http://localhost:3002 | UI et API de contrôle des modèles GGUF, import, métadonnées, proxy OpenAI local et catalogue des modèles chargés via `/api/models` |
| AnythingLLM | http://localhost:3001 | Interface de chat et de workflow documentaire |
| Open WebUI | http://localhost:3003 | Interface de chat alternative branchée sur `lia-local` |
| LibreChat | http://localhost:3004 | Frontend OpenAI-compatible supplémentaire |
| Host controller | http://127.0.0.1:13579 | Pilotage des instances `llama-server` |
| llama-server | http://127.0.0.1:12434-12444 | Une instance par modèle chargé, selon les ports disponibles |
| LibreChat MongoDB | interne Docker | Stockage de LibreChat |

Le proxy OpenAI du Model Loader publie un modèle stable nommé `lia-local`. AnythingLLM reçoit le modèle principal via ce proxy, tandis que LibreChat et AnythingLLM peuvent consulter les modèles chargés via `/api/models` (ou `/api/modeles` en alias).

## Architecture

```mermaid
flowchart LR
    W[Windows 11] --> B[install.ps1
bootstrap / installation]
    B --> C[llama-host-controller.ps1
:13579]
    C --> R[Instances llama-server
:12434-12444
1 modèle par instance]

    W --> D[Docker Desktop]
    D --> M[Model Loader\n:3002]
    D --> A[AnythingLLM\n:3001]
    D --> O[Open WebUI\n:3003]
    D --> L[LibreChat\n:3004]
    D --> G[librechat-mongo]

    M -->|host.docker.internal| C
    M -->|host.docker.internal| R
    A --> M
    O --> M
    L --> M
```

Le point important est le suivant : un seul modèle est servi par instance `llama-server`, mais plusieurs instances peuvent coexister en mémoire en parallèle. Le modèle principal est celui servi au chat principal via `lia-local`, et le catalogue des modèles chargés reste visible via `/api/models`.

## Correspondance App.jsx ↔ server.js ↔ controller

### Vue d'ensemble
- `model-manager/src/App.jsx` appelle l'API du Model Loader.
- `model-manager/server.js` convertit ces appels en opérations sur le contrôleur hôte et/ou en lecture locale de fichiers.
- Le frontend n'appelle jamais `llama-host-controller.ps1` directement.

### Requêtes de lecture d'état
- `App.jsx` `refreshVersion()`
  - `GET /api/version`
  - `server.js` utilise `getRuntimeStatus()` → `controllerRequest('/status')`
- `App.jsx` `refreshAvailableFiles()`
  - `GET /api/models/available`
  - `server.js` liste les fichiers GGUF locaux et exclut le modèle principal déterminé par `resolveActiveModel()`
- `App.jsx` `refreshLoadedModels()`
  - `GET /api/modeles`
  - `server.js` renvoie `buildLoadedModelList(snapshot.runtime)` depuis le runtime ou le fallback `runtime/host-runtime-state.json`
- `App.jsx` `refreshActiveModel()`
  - `GET /api/models/active`
  - `server.js` renvoie le modèle principal via `resolveActiveModel(snapshot.runtime)`
- `App.jsx` `refreshStatusInfo()`
  - `GET /api/models/status`
  - `server.js` résume le runtime et les instances chargées via `buildLoadedModelList(runtime)`

### Actions de modèle
- `App.jsx` `handleLoadFile(modelName)`
  - `POST /api/models/load` `{ model }`
  - `server.js` appelle `buildModelStartRequest(model)` puis `controllerRequest('/start')`
- `App.jsx` `handleSelectLoaded(modelName)`
  - `POST /api/models/select` `{ model }`
  - `server.js` réalise la même logique que `/api/models/load` pour démarrer/activer le modèle
- `App.jsx` `handleUnloadModel(modelName)`
  - `POST /api/models/unload` `{ model }`
  - `server.js` appelle `controllerRequest('/stop')`
- `App.jsx` `handleDeleteFile(filename)`
  - `DELETE /api/models/files/:filename`
  - `server.js` résout le modèle local, arrête l'instance active si nécessaire, puis supprime le fichier
- `App.jsx` `handleOpenModelDetails(modelName)`
  - `GET /api/models/details/:model`
  - `server.js` retourne les métadonnées GGUF via `getModelGgufDetails(model)`

### Import et téléchargement
- `App.jsx` `handleDownloadUrl()` et `handleDownloadAndLoadUrl()`
  - `POST /api/models/download`
  - `server.js` importe depuis Ollama Library ou télécharge depuis Hugging Face, puis retourne le nom du fichier
  - `handleDownloadAndLoadUrl()` effectue ensuite `POST /api/models/load` pour charger immédiatement le modèle

### Points controller
- `/status` : utilisé par `getRuntimeStatus()` pour connaître l'état global et les instances en cours.
- `/start` : utilisé par `/api/models/load` et `/api/models/select` pour démarrer une instance `llama-server`.
- `/stop` : utilisé par `/api/models/unload` et lors de la suppression d'un fichier principal.
- `/restart` : implémenté dans `server.js` mais non utilisé directement par `App.jsx`.

### Comportement principal / fallback
- `resolveActiveModel(runtime)` cherche d'abord `runtime.active_model`, puis une instance `active`, puis une instance `running`.
- `readRuntimeStateFallback()` permet à `server.js` d'utiliser l'état persistant dans `runtime/host-runtime-state.json` si le contrôleur n'est pas disponible.

## Flux d'utilisation

1. Lancer [install.ps1](install.ps1) pour installer les prérequis, préparer les images et initialiser la stack.
2. Ouvrir Docker Desktop si ce n'est pas déjà fait.
3. Aller sur [Model Loader](http://localhost:3002) pour importer un modèle GGUF depuis Hugging Face ou Ollama Library.
4. Charger un modèle, puis en charger d'autres si besoin. Chaque modèle occupe sa propre instance `llama-server` sur un port libre.
5. Utiliser le proxy `lia-local` depuis AnythingLLM, Open WebUI ou LibreChat. AnythingLLM reçoit le modèle principal, tandis que `/api/modeles` expose les modèles chargés pour la découverte et la sélection.

Exemples de références acceptées dans le Model Loader :

- `https://huggingface.co/.../resolve/main/model.gguf`
- `gemma3n:e4b`
- `https://ollama.com/library/gemma3n:e4b`

## Fonctionnalités clés

- Le Model Loader liste les modèles locaux, affiche leur statut, importe des fichiers GGUF, supprime des modèles et extrait des métadonnées détaillées.
- [model-manager/server.js](model-manager/server.js) expose les routes `/health`, `/api/version`, `/api/models/available`, `/api/models/status`, `/api/models/details/:model`, `/api/models/load`, `/api/models/select`, `/api/models/unload` et les routes OpenAI compatibles `/v1/models`, `/v1/chat/completions`, `/v1/completions`, `/v1/embeddings`. La route `/v1/models` renvoie le catalogue complet des modèles chargés, avec l'alias stable `lia-local` conservé pour compatibilité.
- [model-manager/server.js](model-manager/server.js) expose aussi `/api/modeles`, qui renvoie la liste des modèles chargés en mémoire pour les interfaces qui veulent afficher le catalogue courant, avec un fallback sur l'état runtime monté si le contrôleur répond lentement.
- [model-manager/src/App.jsx](model-manager/src/App.jsx) présente l'état runtime, les modèles en mémoire, les métadonnées GGUF et les raccourcis vers les différents frontends.
- [controller/llama-host-controller.ps1](controller/llama-host-controller.ps1) gère plusieurs instances, persiste l'état, détecte les backends disponibles et surveille les ports actifs pour éviter les doublons.
- [Dockerfiles/Dockerfile.librechat](Dockerfiles/Dockerfile.librechat) injecte la configuration LibreChat pour pointer vers `http://model-loader:3002/v1`.
- [Dockerfiles/Dockerfile.openwebui](Dockerfiles/Dockerfile.openwebui) configure Open WebUI pour utiliser le même proxy OpenAI local.
- [Dockerfiles/Dockerfile.anythingllm](Dockerfiles/Dockerfile.anythingllm) conserve la configuration de démarrage adaptée à la stack LIA-X.
- Le Model Loader conserve un identifiant de proxy stable, `lia-local`, ce qui simplifie la configuration côté frontend.

## Structure du projet

```text
.
├── Dockerfiles/
│   ├── Dockerfile.anythingllm
│   ├── Dockerfile.librechat
│   ├── Dockerfile.model-loader
│   ├── Dockerfile.openwebui
│   └── librechat.yaml
├── install.ps1
├── controller/
│   └── llama-host-controller.ps1
├── scripts/
│   ├── controller-service.ps1
│   └── lia.ps1
├── notes.md
├── README.md
├── model-manager/
│   ├── index.html
│   ├── package.json
│   ├── package-lock.json
│   ├── server-package.json
│   ├── server.js
│   ├── public/
│   │   └── logo.svg
│   ├── src/
│   │   ├── App.css
│   │   ├── App.jsx
│   │   └── main.jsx
│   └── vite.config.js
├── models/
└── runtime/
```

## Notes techniques

### Bootstrap et installation

Le script [install.ps1](install.ps1) vérifie les prérequis, installe Docker Desktop si nécessaire, prépare le réseau Docker `lia-network`, télécharge ou réutilise les binaires `llama.cpp`, puis construit et lance les conteneurs applicatifs.

### Contrôleur hôte

[controller/llama-host-controller.ps1](controller/llama-host-controller.ps1) est le point de vérité pour l'exécution locale des modèles. Il :

- détecte automatiquement le meilleur backend disponible avec fallback CUDA, Vulkan ou CPU ;
- autorise plusieurs instances `llama-server` en parallèle ;
- assigne un port libre à chaque instance ;
- garde l'état des processus actifs ;
- expose les informations de runtime aux autres services.

### Model Loader

[model-manager/server.js](model-manager/server.js) traduit les actions du frontend vers le contrôleur hôte et vers le runtime local. Il :

- importe des modèles depuis Hugging Face ou Ollama Library ;
- lit les métadonnées GGUF et le contexte détecté ;
- gère le chargement, le déchargement et la sélection des modèles ;
- expose un proxy OpenAI-compatible pour les autres interfaces ;
- expose `/api/modeles` pour lister les modèles chargés, avec un fallback sur `runtime/host-runtime-state.json` monté dans le conteneur quand le contrôleur est lent, tout en gardant le modèle principal comme cible du proxy `lia-local` vers AnythingLLM ;
- applique un circuit breaker côté requêtes vers le contrôleur.

### Frontends Docker

- [Dockerfiles/Dockerfile.anythingllm](Dockerfiles/Dockerfile.anythingllm) est utilisé pour construire le conteneur AnythingLLM avec la configuration LIA.
- [Dockerfiles/Dockerfile.openwebui](Dockerfiles/Dockerfile.openwebui) configure Open WebUI pour parler au Model Loader local.
- [Dockerfiles/Dockerfile.librechat](Dockerfiles/Dockerfile.librechat) et [Dockerfiles/librechat.yaml](Dockerfiles/librechat.yaml) définissent l'intégration LibreChat vers le même proxy.

## Commandes utiles

```powershell
# Bootstrap et installation
.\install.ps1

# Vérifier la santé du Model Loader
Invoke-WebRequest -Uri "http://127.0.0.1:3002/health" -UseBasicParsing

# Vérifier le runtime et les instances actives
Invoke-WebRequest -Uri "http://127.0.0.1:13579/status" -UseBasicParsing

# Vérifier le statut détaillé des modèles
Invoke-WebRequest -Uri "http://127.0.0.1:3002/api/models/status" -UseBasicParsing

# Logs du conteneur Model Loader
docker logs -f model-loader

# Logs du conteneur AnythingLLM
docker logs -f anythingllm

# Logs du conteneur Open WebUI
docker logs -f open-webui

# Logs du conteneur LibreChat
docker logs -f librechat

# Logs de MongoDB pour LibreChat
docker logs -f librechat-mongo
```

## Dépannage

- Si `lia-local` ne retourne rien, vérifier [http://127.0.0.1:13579/status](http://127.0.0.1:13579/status) puis [http://127.0.0.1:3002/api/models/status](http://127.0.0.1:3002/api/models/status).
- Si un modèle ne s'ouvre pas, vérifier qu'un fichier `.gguf` valide est bien présent dans le répertoire modèles et que la plage de ports `12434-12444` n'est pas saturée.
- Si LibreChat ne démarre pas, consulter `docker logs -f librechat` puis `docker logs -f librechat-mongo`.
- Si un frontend Docker ne voit pas le proxy local, vérifier que le conteneur `model-loader` est bien présent sur `lia-network`.
- Si Docker Desktop n'est pas démarré, relancer Docker puis exécuter à nouveau [install.ps1](install.ps1).

LIA-X reste un socle local-first pour le chat, l'import de modèles GGUF, les tests multi-modèles et l'expérimentation multi-interfaces sur Windows.
