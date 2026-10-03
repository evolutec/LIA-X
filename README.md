<div align="center">

<img src="./model-manager/public/logo.svg" width="150" alt="LIA Logo" />

<h1>LIA-X</h1>

<p><strong>Assistant IA local pour Windows</strong></p>

<p>
  LIA-X te permet de faire tourner des modèles de langage (LLM) directement sur ton PC Windows,
  sans envoyer tes données à des serveurs externes.
</p>

<p>
  <img alt="Windows 11" src="https://img.shields.io/badge/Windows-11-0078D4?style=for-the-badge&logo=windows&logoColor=white">
  <img alt="Docker Desktop" src="https://img.shields.io/badge/Docker-Desktop-2496ED?style=for-the-badge&logo=docker&logoColor=white">
  <img alt="llama.cpp" src="https://img.shields.io/badge/llama.cpp-native-111111?style=for-the-badge">
  <img alt="Multi-LLM" src="https://img.shields.io/badge/Multi--LLM-parallel-2EA043?style=for-the-badge">
  <img alt="LibreChat" src="https://img.shields.io/badge/LibreChat-ready-7C3AED?style=for-the-badge">
</p>

</div>

---

## 🚀 Installation

1. Télécharge `LIA-X-Setup.exe` sur [GitHub Releases](https://github.com/evolutec/LIA-X/releases)
2. Lance-le : Windows demandera l'élévation ( administrateur ), c'est normal —
   LIA-X installe des services Windows.
3. Suis les instructions à l'écran (~15 à 35 min : téléchargement du runtime
   llama.cpp, de Docker et construction des images).

Au démarrage, une page **Réparer / Supprimer / Nouvelle installation** apparaît
si LIA-X est déjà installé.

> ⚠️ L'installateur n'est **pas signé** : Windows SmartScreen affiche un
> avertissement « éditeur non reconnu ». Clique sur *Informations complémentaires*
> → *Exécuter quand même*, et vérifie le SHA256 avec le fichier `SHA256SUMS.txt`
> publié à côté de l'installateur.

L'installateur détecte ton matériel (GPU, CPU, RAM), choisit le backend le plus
performant (Vulkan, CUDA, ROCm ou CPU), installe les services Windows, démarre
Docker et déploie les conteneurs. À la fin, LIA-X s'ouvre dans ton
navigateur.

---

## 🖧 Partage sur le réseau local

LIA-X peut tourner sur **une seule machine** et être utilisé depuis tous
les postes du réseau, sans rien installer de plus sur ces postes.

### 1. Côté machine hôte

Tout écoute déjà sur toutes les interfaces (`0.0.0.0`) :

| Port | Rôle | Depuis les autres postes |
|------|------|--------------------------|
| **3005** | Model Loader : API OpenAI-compatible + interface web | **OUI** — c'est celui-là qu'il faut ouvrir |
| 13579 | Contrôleur hôte (charge/décharge les modèles) | techniques, non nécessaire |
| 12434 | llama-server (inférence directe) | non nécessaire, passer par 3005 |

Seul **3005** est utile aux clients. Le reste peut rester fermé au pare-feu.

### 2. Ouvrir le pare-feu Windows

Par défaut, Windows bloque les entrées. En **PowerShell administrateur** sur
la machine hôte :

```powershell
New-NetFirewallRule -DisplayName "LIA-X (API 3005)" -Direction Inbound `
  -Protocol TCP -LocalPort 3005 -Action Allow -Profile Domain,Private
```

Remplacez `Domain,Private` par `Any` si votre réseau est classé « Public ».
Limitez le périmètre à votre sous-réseau si vous le pouvez :

```powershell
New-NetFirewallRule -DisplayName "LIA-X (API 3005)" -Direction Inbound `
  -Protocol TCP -LocalPort 3005 -RemoteAddress 10.20.3.0/24 -Action Allow `
  -Profile Domain,Private
```

> Docker Desktop ajoute ses propres règles : vérifiez qu'aucune règle
> plus restrictive ne prend le dessus sur celle ci-dessus.

### 3. Côté postes clients

- **Navigateur** : `http://10.20.3.50:3005`
- **Client OpenAI / Cline / Continue / AnythingLLM** :

  | champ | valeur |
  |-------|---------|
  | Base URL | `http://10.20.3.50:3005/v1` |
  | API key | *vide* — aucune clé n'est requise |
  | Modèle | `lia-local` |

Rien à installer sur les postes clients : ni Docker, ni Node, ni Python.

### 4. Durcissement optionnel

Ces deux protections sont **désactivées par défaut** pour ne pas
gêner le partage réseau. À activer si la machine hôte est exposée à
Internet :

| variable | effet |
|----------|-------|
| `LIA_API_TOKEN=1` | exige `X-LIA-Token` sur les écritures `/api/*` |
| `LIA_ALLOWED_HOSTS=10.20.3.50,poste-maitre.lan` | rejette tout autre `Host` (anti DNS-rebinding) |

### 5. Ce que le partage ne change pas

Les modèles, les documents RAG et l'historique de chat restent sur la
machine hôte : chaque poste client ne voit que l'API.
## 📋 Prérequis

| Élément | Version minimale | Remarque |
|---------|-----------------|----------|
| Windows | 10 (x64) | Windows 11 recommandé ; Windows 7/8.1 refusés par l'installateur |
| Docker Desktop | Dernière version | **Obligatoire** : sans lui, l'installation s'arrête avec un message explicite |
| Node.js | 20+ | **Obligatoire** : le frontend est construit sur ta machine pendant l'installation |
| PowerShell | 7+ (recommandé) | Fonctionne avec 5.1 |
| RAM | 16 GB minimum | 32 GB recommandés pour des modèles > 7B |
| GPU | NVIDIA/AMD/Intel | Optionnel mais recommandé pour la vitesse |
| Espace disque | 20 GB libres | Pour les modèles + Docker |
| Connexion Internet | Requise | Runtime llama.cpp, images Docker, voix neuronale (~310 Mo) |

---

## 🎯 Que peut faire LIA-X ?

### 1. Chat avec un LLM local

- Télécharge des modèles GGUF (Llama, Mistral, Qwen, etc.)
- Discute avec eux via une interface web
- Les réponses sont générées localement, pas dans le cloud

### 2. Utilise tes propres outils

LIA-X expose une API compatible OpenAI. Tu peux donc l'utiliser avec :
- **Cursor, VS Code, Windsurf** : assistants de code locaux
- **Open WebUI** : interface de chat avancée (Docker)
- **LibreChat** : alternative open-source à ChatGPT (Docker)
- **AnythingLLM** : interface desktop (Docker)

### 3. Gère plusieurs modèles

- Charge plusieurs modèles en même temps
- Bascule entre eux en un clic
- Les instances sont gérées automatiquement (redémarrage si crash)

---

## 🖥️ Interfaces disponibles

| Interface | URL | Usage |
|-----------|-----|-------|
| **LIA-X** | http://localhost:3005 | Gestion des modèles, import GGUF, statut |
| **Open WebUI** | http://localhost:3008 | Chat avancé, RAG, plugins (Docker) |
| **LibreChat** | http://localhost:3007 | Chat multi-modèles (Docker) |
| **AnythingLLM** | http://localhost:3006 | Chat + workspaces (Docker) |

---

## 📦 Comment ajouter un modèle ?

1. Télécharge un fichier `.gguf` depuis [HuggingFace](https://huggingface.co) ou [Ollama Registry](https://ollama.com/library)
2. Place-le dans le dossier `%USERPROFILE%\Documents\LIA-X\Models` (dossier des modèles de LIA-X)
3. Ouvre http://localhost:3005
4. Le modèle apparaît automatiquement dans la liste
5. Clique sur "Charger" puis "Activer"

---

## 🔧 Commandes utiles

```powershell
# Vérifier que le LIA-X fonctionne
Start-Process "http://localhost:3005"

# Vérifier le statut du contrôleur
Invoke-WebRequest -Uri "http://127.0.0.1:13579/status" -UseBasicParsing

# Arrêter tous les services Docker
docker stop $(docker ps -q)
docker rm $(docker ps -aq)
```

---

## ❓ Dépannage

### L'interface ne se lance pas

1. Vérifie que Docker Desktop est bien démarré
2. Vérifie que les ports 3005, 3006, 3007, 3008 ne sont pas déjà utilisés
3. Redémarre le service LIA Controller depuis le Gestionnaire des services Windows

### Un modèle ne charge pas

- Vérifie que le fichier `.gguf` n'est pas corrompu
- Vérifie que tu as assez de RAM/VRAM
- Consulte les logs dans `logs/controller/` et `logs/runtime/`

### Docker ne démarre pas

- Redémarre Docker Desktop
- Vérifie que la virtualisation est activée dans le BIOS
- Sur Windows 11 Home, assure-toi que WSL2 est installé

### Le dossier des modèles ne s'ouvre pas

- Clique sur le bouton "Ouvrir le dossier" dans LIA-X
- Si ça ne marche pas, ouvre manuellement le dossier `%USERPROFILE%\Documents\LIA-X\Models`

### Désinstaller

Lance `LIA-X-Setup.exe` et choisis **Supprimer**, ou passe par
*Paramètres → Applications → LIA-X → Désinstaller*. Les volumes Docker et tes
modèles sont conservés ; réinstalle par la suite sans rien perdre.

> Ce qui reste sur le disque après désinstallation, et que le désinstalleur
> n'efface pas volontairement :
> - `%USERPROFILE%\Documents\LIA-X\Models` (tes GGUF) ;
> - le cache de langue OCR (`Models\.tesseract`, ~6 Mo) ;
> - la voix neuronale Kokoro (`Models\.cache\kokoro`, ~310 Mo).
>
> Pour une suppression complète : `Remove-Item "$env:USERPROFILE\Documents\LIA-X" -Recurse -Force`
> puis `docker volume prune`.

---

## 🔐 Sécurité

- Toutes les inférences sont locales : tes données ne quittent jamais ton PC
- L'API écoute uniquement sur `127.0.0.1` (pas d'accès depuis le réseau)
- Pas de télémétrie ni d'envoi de données vers des serveurs externes

---

## 📚 Documentation technique

Pour les développeurs, la documentation complète est dans
[`model-manager/src/Documentation.jsx`](model-manager/src/Documentation.jsx) et [`docs/`](docs/).

---

## 🤝 Contribuer

Les contributions sont les bienvenues ! N'hésite pas à ouvrir une issue ou une pull request.

---

## 📄 Licence

MIT