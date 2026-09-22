# LIA-X

**Assistant IA local pour Windows**

LIA-X te permet de faire tourner des modèles de langage (LLM) directement sur ton PC Windows, sans envoyer tes données à des serveurs externes.

```
┌─────────────────────────────────────────────┐
│  LIA-X en résumé                           │
├─────────────────────────────────────────────┤
│  ✓ LLM local (llama.cpp)                   │
│  ✓ Interface web simple                    │
│  ✓ Chat avec tes propres modèles           │
│  ✓ Compatible avec les outils OpenAI       │
│  ✓ Docker inclus pour plus d'interfaces    │
└─────────────────────────────────────────────┘
```

---

## 🚀 Installation rapide

### Option 1 : Installeur Windows (.exe)

1. Télécharge `LIA-X-Setup.exe` sur [GitHub Releases](https://github.com/evolutec/LIA-X/releases)
2. Lance l'installateur en tant qu'administrateur
3. Suis les instructions à l'écran
4. Redémarre Windows si demandé

### Option 2 : Script PowerShell

```powershell
# Ouvre PowerShell en tant qu'administrateur
.\install.ps1
```

---

## 📋 Prérequis

| Élément | Version minimale | Remarque |
|---------|-----------------|----------|
| Windows | 11 | Windows 10 non testé |
| Docker Desktop | Dernière version | Obligatoire pour les interfaces |
| PowerShell | 7+ (recommandé) | Fonctionne avec 5.1 |
| RAM | 16 GB minimum | 32 GB recommandés pour des modèles > 7B |
| GPU | NVIDIA/AMD/Intel | Optionnel mais recommandé pour la vitesse |
| Espace disque | 20 GB libres | Pour les modèles + Docker |

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
| **Model Loader** | http://localhost:3005 | Gestion des modèles, import GGUF, statut |
| **Open WebUI** | http://localhost:3008 | Chat avancé, RAG, plugins (Docker) |
| **LibreChat** | http://localhost:3007 | Chat multi-modèles (Docker) |
| **AnythingLLM** | http://localhost:3006 | Chat + workspaces (Docker) |

---

## 📦 Comment ajouter un modèle ?

1. Télécharge un fichier `.gguf` depuis [HuggingFace](https://huggingface.co) ou [Ollama Registry](https://ollama.com/library)
2. Place-le dans le dossier `models/` du projet
3. Ouvre http://localhost:3005
4. Le modèle apparaît automatiquement dans la liste
5. Clique sur "Charger" puis "Activer"

---

## 🔧 Commandes utiles

```powershell
# Démarrer la stack complète
.\install.ps1

# Vérifier que le Model Loader fonctionne
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

- Clique sur le bouton "Ouvrir le dossier" dans Model Loader
- Si ça ne marche pas, ouvre manuellement le dossier `models/` du projet

---

## 🛠️ Structure du projet

```
LIA-X/
├── install.ps1              # Installation complète
├── config.json              # Configuration (ports, chemins)
├── scripts/                 # Scripts d'orchestration
├── services/                # Services Windows (controller, GPU, launcher)
├── model-manager/           # Interface web + API
├── Dockerfiles/             # Images Docker (Open WebUI, LibreChat, etc.)
├── models/                  # Dossier des modèles GGUF (à créer)
├── runtime/                 # État runtime (généré automatiquement)
└── logs/                    # Logs des services
```

---

## 🔐 Sécurité

- Toutes les inférences sont locales : tes données ne quittent jamais ton PC
- L'API écoute uniquement sur `127.0.0.1` (pas d'accès depuis le réseau)
- Pas de télémétrie ni d'envoi de données vers des serveurs externes

---

## 📚 Documentation technique

Pour les développeurs, la documentation complète est dans [`model-manager/src/Documentation.jsx`](model-manager/src/Documentation.jsx:1) et [`docs/`](docs/).

---

## 🤝 Contribuer

Les contributions sont les bienvenues ! N'hésite pas à ouvrir une issue ou une pull request.

---

## 📄 Licence

MIT — voir le fichier `LICENSE` pour plus de détails.
