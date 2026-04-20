<div align="center">

<img src="./model-manager/public/logo.svg" width="150" alt="LIA Logo" />

<h1>LIA-X</h1>

<p><strong>Local Intelligence Assistant pour Windows, Docker et llama.cpp</strong></p>

<p>
  Stack IA locale Windows avec un contrôleur PowerShell, un Model Loader GGUF,
  et trois frontends Docker : AnythingLLM, Open WebUI et LibreChat.
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
- [Services](#services)
- [Architecture](#architecture)
- [Points clés](#points-clés)
- [Flux d'utilisation](#flux-dutilisation)
- [Structure du projet](#structure-du-projet)
- [Commandes utiles](#commandes-utiles)
- [Dépannage](#dépannage)

## Vue d'ensemble

LIA-X est une plate-forme locale pour tester et déployer des modèles GGUF sur Windows. Les services tournent dans Docker, tandis que l'inférence `llama.cpp` est orchestrée par un contrôleur PowerShell local.

Le contrôleur hôte `controller/llama-host-controller.ps1` supervise les processus `llama-server`, conserve l'état des instances et expose une API de contrôle sur le port `13579`.

`model-manager/server.js` sert le Model Loader et traduit les actions du frontend React (`model-manager/src/App.jsx`) en commandes vers le contrôleur. Il propose aussi un proxy OpenAI-compatible.

`install.ps1` et `scripts/lia.ps1` préparent l'environnement Windows, construisent les images Docker et démarrent les services sur le réseau `lia-network`.

## Services

| Service | URL | Rôle |
|---|---|---|
| Model Loader | http://localhost:3002 | Import GGUF, métadonnées, catalogue, proxy OpenAI |
| AnythingLLM | http://localhost:3001 | Interface de chat principale |
| Open WebUI | http://localhost:3003 | Interface de chat alternative |
| LibreChat | http://localhost:3004 | Frontend OpenAI-compatible |
| Contrôleur hôte | http://127.0.0.1:13579 | Contrôle des processus `llama-server` |
| `llama-server` | http://127.0.0.1:12434-12444 | Instance par modèle sur ports dynamiques |

## Architecture

- `controller/llama-host-controller.ps1` lance une instance `llama-server` par modèle et lui attribue un port libre.
- `model-manager/server.js` expose les routes `/api/*` et `/v1/*` pour les frontends et les clients OpenAI-compatible.
- `AnythingLLM`, `Open WebUI` et `LibreChat` consomment le proxy local du Model Loader.
- LibreChat est exposé sur le port hôte `3004`, mappé au port interne `3080`.
- Tous les containers sont reliés sur le réseau Docker `lia-network`.

## Points clés

- `scripts/lia.ps1` contient la configuration de ports et les commandes de démarrage des containers.
- `Dockerfiles/Dockerfile.librechat` configure LibreChat pour pointer vers `http://model-loader:3002/v1`.
- `Dockerfiles/Dockerfile.openwebui` configure Open WebUI pour utiliser le même proxy local.
- `model-manager/server.js` gère l'import, le chargement, la sélection et le déchargement de modèles.
- `runtime/host-runtime-state.json` sauvegarde l'état des modèles et aide au redémarrage du runtime.

## Flux d'utilisation

1. Exécuter `.\install.ps1`
2. Lancer Docker Desktop.
3. Ouvrir `http://localhost:3002` pour accéder au Model Loader.
4. Importer ou charger un fichier `.gguf` depuis `models/`.
5. Utiliser AnythingLLM (`3001`), Open WebUI (`3003`) ou LibreChat (`3004`) via le proxy `lia-local`.

## Structure du projet

```text
.
├── Dockerfiles/
│   ├── Dockerfile.anythingllm
│   ├── Dockerfile.librechat
│   ├── Dockerfile.model-loader
│   ├── Dockerfile.openwebui
│   └── librechat.yaml
├── controller/
│   └── llama-host-controller.ps1
├── install.ps1
├── model-manager/
│   ├── index.html
│   ├── package.json
│   ├── server-package.json
│   ├── server.js
│   ├── public/
│   │   └── logo.svg
│   └── src/
│       ├── App.css
│       ├── App.jsx
│       └── main.jsx
├── scripts/
│   └── lia.ps1
├── models/
└── runtime/
```

## Commandes utiles

```powershell
# Installer et démarrer la stack
.\install.ps1

# Vérifier la santé du Model Loader
Invoke-WebRequest -Uri "http://127.0.0.1:3002/health" -UseBasicParsing

# Vérifier le contrôleur
Invoke-WebRequest -Uri "http://127.0.0.1:13579/status" -UseBasicParsing

# Vérifier les modèles chargés
Invoke-WebRequest -Uri "http://127.0.0.1:3002/api/models/status" -UseBasicParsing
```

## Dépannage

- Si `lia-local` ne répond pas : vérifier `http://127.0.0.1:13579/status` puis `http://127.0.0.1:3002/api/models/status`.
- Si LibreChat ne démarre pas : consulter `docker logs -f librechat` et `docker logs -f librechat-mongo`.
- Si un frontend Docker ne voit pas `model-loader` : vérifier que `model-loader` est connecté à `lia-network`.
- Si un modèle `.gguf` n'est pas trouvé : déposer le fichier dans `models/` et relancer le chargement.
