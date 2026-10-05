<div align="center">

<img src="./model-manager/public/logo.svg" width="150" alt="LIA Logo" />

<h1>LIA-X</h1>

<p><strong>Assistant IA local pour Windows</strong></p>

<p>
  LIA-X te permet de faire tourner des modèles de langage (LLM) directement sur ton PC Windows,
  sans envoyer tes données à des serveurs externes.
</p>

<p>
  <img alt="Windows 10/11" src="https://img.shields.io/badge/Windows-10%20%2F%2011-0078D4?style=for-the-badge&logo=windows&logoColor=white">
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
3. Suis les instructions à l'écran. Comptez **20 à 40 min** la première fois
   (runtime llama.cpp, voix neuronale ~310 Mo, construction de l'image,
   téléchargement des interfaces ~10 Go), **~10 min** si les images Docker sont
   déjà en cache.

Au démarrage, une page **Réparer / Supprimer / Nouvelle installation** apparaît
si LIA-X est déjà installé.

> ⚠️ L'installateur n'est **pas signé** : Windows SmartScreen affiche un
> avertissement « éditeur non reconnu ». Clique sur *Informations complémentaires*
> → *Exécuter quand même*, et vérifie le SHA256 avec le fichier `SHA256SUMS.txt`
> publié à côté de l'installateur.

### Quelle version utiliser ?

| Version | Statut |
|---------|--------|
| **v2.0.2** ([télécharger](https://github.com/evolutec/LIA-X/releases/tag/v2.0.2)) | ✅ **à utiliser** — corrige le blocage réseau de la v2.0.1 |
| v2.0.1 | ⚠️ **déconseillée** : la validation `Host` renvoie `421` aux clients distants. Son installateur reste téléchargeable, mais il est cassé pour le partage réseau |
| v2.0.0 | 🗄️ obsolète — tag pointant 5 commits en arrière, marquée « OBSOLETE » sur GitHub |

> Si tu as besoin de ce qui n'est pas encore dans un tag (correctifs du
> contrôleur, désinstallation, `/INTERFACES`), reconstruis l'installateur
> depuis `main` : `installer\compile.ps1`.

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
| **3005** | LIA-X : API OpenAI-compatible + interface web | **OUI** — c'est celui-là qu'il faut ouvrir |
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

## 📌 Modèles épinglés (résidence permanente en VRAM)

Un modèle **épinglé** (interrupteur « Épinglé » dans l'onglet Modèles) reste
entièrement chargé en mémoire vidéo : il ne se décharge jamais après
inactivité et répond sans latence de rechargement.

Techniquement, un modèle épinglé est démarré **sans** l'option
`--sleep-idle-seconds` de llama.cpp, qui est précisément ce qui vide la VRAM
après une période d'inactivité (60 s par défaut).

À vérifier soi-même (PowerShell) :

```powershell
Get-CimInstance Win32_Process -Filter "Name='llama-server.exe'" |
  ForEach-Object { "$($_.ProcessId) : " + ($_.CommandLine -match '--sleep-idle-seconds') }
# False = modèle résident (épinglé ou modèle principal en cours d'usage)
```

> **Épingler un modèle déjà chargé le redémarre.** L'option ne peut être
> appliquée qu'au lancement du processus ; le serveur arrête puis relance donc
> l'instance (~1 à 2 minutes pour un gros modèle). C'est visible sur la réponse
> de l'API : `{"pinned": true, "reloaded": {"applied": true}}`.

Deux limites à connaître :

- **Sans base de données** (PostgreSQL indisponible), l'épinglement est ignoré :
  le modèle sera déchargé normalement.
- **Désépingler** ne décharge pas le modèle immédiatement : il retrouve son
  comportement normal au prochain démarrage.

---

## 🔧 Commandes utiles

```powershell
# Ouvrir l'interface
Start-Process "http://localhost:3005"

# Vérifier le statut du contrôleur (les objets sont masqués : /status est volumineux)
(Invoke-WebRequest "http://127.0.0.1:13579/health" -TimeoutSec 10).StatusCode

# Arrêter les conteneurs LIA-X (et eux seuls)
docker stop lia-x lia-postgres

# Tout retirer : ATTENTION, à lire avant de lancer
#   docker rm $(docker ps -aq)        <-- bash : NE PAS coller dans PowerShell
#   docker ps -aq | ForEach-Object { docker rm -f $_ }   <-- équivalent PowerShell
# Cette commande supprime TOUS les conteneurs de la machine, y compris ceux
# d'autres projets (bases de données, outils…). À n'utiliser que si c'est voulu.
```

> Sous PowerShell 7, n'ajoutez pas `-UseBasicParsing` : le paramètre n'existe
> plus, la commande échoue. C'est aussi vrai de `GetResponseStream()`, absent
> de `HttpResponseMessage`.

---

## ❓ Dépannage

### L'interface ne se lance pas

1. Vérifie que Docker Desktop est bien démarré
2. Vérifie que les ports 3005, 3006, 3007, 3008 ne sont pas déjà utilisés
3. Redémarre le service LIA Controller depuis le Gestionnaire des services Windows

### Un modèle ne charge pas

- Vérifie que le fichier `.gguf` n'est pas corrompu
- Vérifie que tu as assez de RAM/VRAM — sur un iGPU, la mémoire est partagée
  avec la RAM système : comparer à la mémoire **utilisable**, pas au total
- Consulte les logs dans `C:\Program Files\LIA-X\logs\controller\` et
  `C:\Program Files\LIA-X\logs\runtime\`. ⚠️ Les journaux ne contiennent
  **plus** le contenu de tes requêtes (protection de la vie privée) : un
  diagnostic doit s'appuyer sur `/status`, pas sur les logs.
- ⚠️ Juste après l'installation, l'onglet Modèles peut afficher un état
  intermédiaire : les modèles sont restaurés **un par un**, 1 à 2 min chacun.
  Attendez, ou vérifiez les processus réellement lancés :
  ```powershell
  Get-CimInstance Win32_Process -Filter "Name='llama-server.exe'" |
    ForEach-Object { $_.CommandLine -match '-m\s+"([^"]+)"' }
  ```

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
- Pas de télémétrie ni d'envoi de données vers des serveurs externes
- L'API **écoute sur toutes les interfaces** (`0.0.0.0:3005`) pour être
  joignable depuis le réseau local. C'est un choix assumé : c'est ce qui permet
  à un poste maître de servir tous les autres. Si tu n'en as pas l'usage,
  **n'ouvre pas la règle de pare-feu** de la section « Partage sur le réseau
  local » : sans elle, le port 3005 reste inaccessible aux autres postes.
- Deux protections sont disponibles mais **désactivées par défaut** :
  `LIA_API_TOKEN=1` (jeton sur les écritures) et `LIA_ALLOWED_HOSTS=…`
  (anti DNS-rebinding). Voir § 4 de la section réseau.

---

## 📚 Documentation technique

Pour les développeurs, la documentation complète est dans
[`model-manager/src/Documentation/Documentation.jsx`](model-manager/src/Documentation/Documentation.jsx),
[`docs/`](docs/), et les consignes de travail dans [`AGENTS.md`](AGENTS.md).

---

## 🤝 Contribuer

Les contributions sont les bienvenues ! N'hésite pas à ouvrir une issue ou une pull request.

---

## 📄 Licence

LIA-X est distribué sous **licence MIT** — voir [`LICENSE`](LICENSE).

Les composants tiers embarqués (NSSM, images Docker des interfaces) conservent
leur propre licence ; voir [`THIRD_PARTY.md`](THIRD_PARTY.md) pour le détail.

> ⚠️ Open WebUI applique depuis la v0.6.6 une clause de protection du branding
> au-delà de 50 utilisateurs / 30 jours. LIA-X ne le retire pas et le
> redistribue tel quel : c'est l'exploitant du déploiement qui doit vérifier
> ses conditions d'usage.