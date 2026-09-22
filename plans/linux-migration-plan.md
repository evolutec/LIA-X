# Plan d'adaptation LIA-X pour Linux

## Contexte
LIA-X est actuellement 100% Windows. L'orchestration est en PowerShell, les services utilisent NSSM, l'installateur est Inno Setup, et des appels Win32 API sont utilisés pour lancer l'explorateur depuis un service.

---

## 1. Architecture cible Linux

```
┌─────────────────────────────────────────────┐
│  LIA-X sur Linux                             │
├─────────────────────────────────────────────┤
│  Paquet .deb (Debian/Ubuntu/Mint)            │
│  → installation via dpkg/apt                 │
│  → services systemd créés automatiquement    │
├─────────────────────────────────────────────┤
│  systemd services:                           │
│  - lia-controller.service (Node.js/Python)  │
│  - lia-gpu-metrics.service                  │
│  - lia-model-loader.service                 │
├─────────────────────────────────────────────┤
│  model-manager/ (Express + React) — unchanged│
├─────────────────────────────────────────────┤
│  Docker containers — unchanged              │
│  (avec --add-host host.docker.internal)     │
├─────────────────────────────────────────────┤
│  scripts/lia.sh (remplace lia.ps1)          │
└─────────────────────────────────────────────┘
```

---

## 2. Réécriture complète (bloquants Linux)

### 2.1 `services/controller/llama-host-controller.ps1` → `services/controller/llama-host-controller.{js|py}`
- Remplacer `System.Net.HttpListener` par un serveur HTTP cross-platform (Node.js `http` module ou Python `http.server`/FastAPI)
- Remplacer les appels Win32 (`CreateProcessAsUser`, `OpenProcessToken`, `ShowWindow`, `SetForegroundWindow`) par `child_process.spawn()` (Node) ou `subprocess.Popen()` (Python)
- Remplacer `Get-CimInstance Win32_*` par des appels système Linux (`/proc`, `lspci`, `lscpu`, `free`, `nvidia-smi`)
- Remplacer `netstat -ano` / `Get-NetTCPConnection` par `ss -tulpn` ou `netstat -tulpn`
- Remplacer `C:\Windows\System32\nvidia-smi.exe` par recherche dans le PATH (`which nvidia-smi`)
- Garder la logique métier (lifecycle llama-server, ports 12434-12444)

### 2.2 `services/gpu-metrics/service.ps1` → `services/gpu-metrics/service.{js|py}`
- Remplacer `System.Net.HttpListener` par serveur HTTP cross-platform
- Remplacer WMI `Win32_VideoController`, `Win32_Processor`, `Win32_OperatingSystem` par `/proc/meminfo`, `lscpu`, `lspci`
- Remplacer `Get-Counter '\GPU Engine(*)\Utilization Percentage'` par `nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits` (NVIDIA) ou `radeontop`/`intel_gpu_top` (AMD/Intel)
- Remplacer `Get-CimInstance Win32_Process` par lecture de `/proc/[pid]` ou `ps`
- Garder l'endpoint port 13621 et le format de réponse JSON

### 2.3 `services/host-launcher/host-launcher.ps1` → supprimer (remplacé par `xdg-open`)
- Sur Linux, l'ouverture de dossier se fait directement avec `xdg-open /chemin/vers/dossier`
- Le concept de session 0 / CreateProcessAsUser n'existe pas sur Linux
- L'UI appellera directement `xdg-open` côté frontend via API, ou le controller exposera un endpoint qui exécute `xdg-open`

### 2.4 `services/shared/service-helpers.ps1` → supprimer (remplacé par systemd)
- NSSM n'existe pas sur Linux
- Créer des unit files systemd `.service` pour chaque service
- Les services systemd gèrent le redémarrage automatique, les logs (journald), et le démarrage au boot

### 2.5 `modules/*.ps1` → `modules/*.{js|py}`
- `modules/common.ps1` : fonctions Step/OK/FAIL, détection OS, gestion chemins
- `modules/docker.ps1` : gestion conteneurs Docker (déjà cross-platform via CLI Docker)
- `modules/hardware.ps1` : détection matérielle (remplacer WMI par `/proc`, `lspci`, etc.)
- `modules/llama.ps1` : gestion llama.cpp (téléchargement, build, releases) — garder la logique, adapter les chemins et outils
- `modules/services.ps1` : start/stop services (remplacer NSSM/Windows par systemctl)

### 2.6 `scripts/lia.ps1` → `scripts/lia.sh` (ou `lia.js`/`lia.py`)
- Garder la logique d'orchestration globale
- Détecter l'OS et appeler les bons binaires
- La partie Docker est déjà cross-platform
- Remplacer les appels NSSM/Windows par systemctl
- Remplacer les chemins Windows par des chemins Linux (`$HOME/.local/share/lia-x`, `/opt/lia-x`)

### 2.7 `install.ps1` → `install.sh` (ou `install.js`/`install.py`)
- Supprimer la logique MOTW (Mark Of The Web, Windows-only)
- Vérifier les dépendances Linux : Docker, Node.js, git, build-essential, etc.
- Créer la structure de répertoires (`/opt/lia-x` ou `$HOME/.local/share/lia-x`)
- Configurer les services systemd
- Lancer `scripts/lia.sh`

### 2.8 `installer/LIA-X.iss` → `installer/lia-x.deb` (paquet Debian/Ubuntu/Mint)
- Inno Setup est 100% Windows
- **Debian, Ubuntu et Linux Mint partagent le même format `.deb`**, donc un seul paquet couvre les trois distributions
- Construit avec `dpkg-deb` (pas besoin d'outil externe, présent sur toutes les distributions Debian)
- Structure du paquet :
  ```
  lia-x_1.0.0_amd64.deb
  └── /
      ├── opt/
      │   └── lia-x/
      │       ├── services/
      │       ├── modules/
      │       ├── scripts/
      │       ├── config.json
      │       ├── README.md
      │       └── Dockerfiles/
      ├── etc/
      │   └── systemd/
      │       └── system/
      │           ├── lia-controller.service
      │           ├── lia-gpu-metrics.service
      │           └── lia-model-loader.service
      ├── usr/
      │   └── share/
      │       └── applications/
      │           └── lia-x.desktop
      └── var/
          └── log/
              └── lia-x/
  ```
- Scripts de maintenance du paquet :
  - `postinst` : active et démarre les services systemd, crée les répertoires runtime/models/logs
  - `prerm` : arrête et désactive les services
  - `postrm` : nettoie les répertoires runtime/models/logs (sauf les modèles)
- Dépendances déclarées dans `control` :
  - `docker.io` ou `docker-ce` (conteneurs)
  - `nodejs` + `npm` (model-loader frontend)
  - `python3` (gpu-metrics, optionnel selon le choix)
  - `nvidia-smi` (optionnel, si GPU NVIDIA)
- Installation : `sudo dpkg -i lia-x_1.0.0_amd64.deb && sudo apt-get install -f`
- Désinstallation : `sudo apt remove lia-x`
- Le paquet peut être publié sur GitHub Releases en plus de l'installeur Windows `.exe`

### 2.9 `installer/nssm/` → supprimer
- Remplacé par systemd unit files

### 2.10 `tools/hw-smi/hw-smi.exe` → supprimer ou remplacer
- Binaire Windows pour métriques GPU
- Sur Linux, utiliser `nvidia-smi` (NVIDIA) ou des outils AMD/Intel directement

### 2.11 `tests/smoke.ps1` → `tests/smoke.sh`
- Réécrire les tests de fumée en bash ou Node.js
- Vérifier que les services répondent sur leurs ports

---

## 3. Modifications partielles

### 3.1 `config.json`
- **Compatible tel quel** (chemins relatifs)
- Ajouter une section `"linux": { ... }` pour les chemins spécifiques Linux si nécessaire
- Exemple : `"installDir": "/opt/lia-x"`, `"modelsDir": "$HOME/.local/share/lia-x/models"`

### 3.2 `model-manager/server.js`
- **Déjà cross-platform** (Node.js/Express)
- Vérifier que `host.docker.internal` fonctionne sur Linux (nécessite `--add-host host.docker.internal:host-gateway` dans `docker run`)
- Les chemins dans `Documentation.jsx` sont des exemples de documentation, pas du code fonctionnel

### 3.3 `Dockerfiles/`
- **Déjà compatibles Linux** (basés sur Debian bookworm-slim)
- Vérifier que `host.docker.internal` est bien géré avec `--add-host`

### 3.4 `.github/workflows/release.yml`
- Ajouter un job Linux pour créer un package `.deb`/`.tar.gz`
- Garder le job Windows pour l'installeur `.exe`
- Exemple de job Linux :
  ```yaml
  - name: Build Linux package
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Package LIA-X
        run: |
          tar -czf lia-x-linux.tar.gz \
            services/ modules/ scripts/ config.json \
            model-manager/ Dockerfiles/ README.md
  ```

### 3.5 `README.md`
- Ajouter une section "Installation sur Linux"
- Ajouter les instructions systemd
- Remplacer les exemples de chemins Windows par des chemins Linux
- Ajouter les prérequis Linux (Docker Engine, Node.js, etc.)

---

## 4. Nouveaux fichiers à créer

### 4.1 `services/controller/llama-host-controller.js` (ou `.py`)
- Serveur HTTP sur port 13579
- Endpoints : `GET /health`, `GET /status`, `POST /start`, `POST /stop`, `POST /restart`, `GET /logs`, `POST /open-models-folder`
- Logique de lifecycle llama-server (téléchargement, lancement, arrêt)
- Détection des ports occupés via `ss -tulpn`

### 4.2 `services/gpu-metrics/service.js` (ou `.py`)
- Serveur HTTP sur port 13621
- Collecte métriques GPU/CPU/RAM via `/proc` et `nvidia-smi`
- Endpoint `GET /metrics`

### 4.3 `services/systemd/lia-controller.service`
```ini
[Unit]
Description=LIA-X Controller
After=network.target docker.service

[Service]
Type=simple
WorkingDirectory=/opt/lia-x
ExecStart=/usr/bin/node services/controller/llama-host-controller.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

### 4.4 `services/systemd/lia-gpu-metrics.service`
```ini
[Unit]
Description=LIA-X GPU Metrics
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/lia-x
ExecStart=/usr/bin/python3 services/gpu-metrics/service.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### 4.5 `services/systemd/lia-model-loader.service`
```ini
[Unit]
Description=LIA-X Model Loader (Frontend)
After=network.target docker.service

[Service]
Type=simple
WorkingDirectory=/opt/lia-x/model-manager
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

### 4.6 `scripts/lia.sh`
- Script bash principal
- Détecter l'OS
- Sur Linux : `systemctl enable --now lia-controller.service lia-gpu-metrics.service lia-model-loader.service`
- Sur Windows : appeler `scripts/lia.ps1` (garder la compatibilité)

### 4.7 `scripts/install.sh`
- Vérifier les dépendances Linux : `docker`, `nodejs`, `npm`, `python3`, `git`, `nvidia-smi` (optionnel)
- Créer `/opt/lia-x` (ou `$HOME/.local/share/lia-x`)
- Copier les fichiers
- Créer les services systemd
- Lancer `scripts/lia.sh`

### 4.8 `.github/workflows/release.yml` (étendre le workflow existant)
- Ajouter un job `build-linux-deb` sur `ubuntu-latest`
- Construire le paquet `.deb` avec `dpkg-deb`
- Publier sur GitHub Releases en plus de l'installeur Windows `.exe`
- Exemple :
  ```yaml
  build-linux-deb:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Build .deb package
        run: |
          chmod +x installer/build-deb.sh
          ./installer/build-deb.sh
      - name: Upload .deb artifact
        uses: actions/upload-artifact@v4
        with:
          name: lia-x-deb
          path: dist/lia-x_*.deb
  ```

### 4.9 `installer/build-deb.sh`
- Script bash qui construit le paquet `.deb` avec `dpkg-deb`
- Structure temporaire : `build-deb/lia-x_1.0.0_amd64/`
- Copie des fichiers, création de l'arborescence DEBIAN/, exécution de `dpkg-deb --build`
- Output dans `dist/lia-x_1.0.0_amd64.deb`

### 4.10 `tests/smoke.sh`
- Tests de fumée Linux
- Vérifier que systemd répond : `systemctl is-active lia-controller`
- Vérifier les ports : `ss -tulpn | grep 13579`
- Vérifier les conteneurs Docker : `docker ps`

---

## 5. Ordre de migration recommandé

| Étape | Action | Fichiers concernés |
|-------|--------|-------------------|
| 1 | Créer le controller en Node.js | `services/controller/llama-host-controller.js` |
| 2 | Créer le service GPU metrics en Node.js/Python | `services/gpu-metrics/service.js` |
| 3 | Créer les unit files systemd | `services/systemd/*.service` |
| 4 | Créer `scripts/lia.sh` | `scripts/lia.sh` |
| 5 | Créer `scripts/install.sh` | `scripts/install.sh` |
| 6 | Supprimer/archiver les fichiers PowerShell Windows | `services/**/*.ps1`, `modules/*.ps1`, `installer/` |
| 7 | Créer le paquet `.deb` | `installer/build-deb.sh`, structure DEBIAN/ |
| 8 | Adapter le frontend pour Linux (chemins docs) | `Documentation.jsx`, `README.md` |
| 9 | Ajouter le workflow CI Linux | `.github/workflows/release.yml` |
| 10 | Tester sur Ubuntu/Debian/Mint | - |

---

## 6. Choix technologiques

| Composant | Windows actuel | Linux cible | Raison |
|-----------|---------------|-------------|--------|
| Controller | PowerShell HttpListener | Node.js `http` module | Cohérence avec le reste du projet, déjà utilisé pour model-manager |
| GPU Metrics | PowerShell HttpListener | Node.js `http` module | Cohérence, ou Python si plus léger |
| Orchestration | PowerShell | Bash | Standard Linux, léger |
| Services | NSSM | systemd | Standard Linux, intégré au système |
| Installateur | Inno Setup | Paquet `.deb` (dpkg-deb) | Debian/Ubuntu/Mint, installation/désinstallation propre |
| Détection matériel | WMI/CIM | `/proc`, `lspci`, `lscpu` | Standard Linux, pas de dépendance |

---

## 7. Points d'attention

- **Chemins** : passer de `C:\Users\evolu\Documents\LIA-X\...` à `/opt/lia-x/...` ou `$HOME/.local/share/lia-x/...`
- **Droits** : `/opt/lia-x` nécessite `sudo` pour l'installation, `$HOME/.local/share/lia-x` ne nécessite pas `sudo` mais les services systemd nécessitent des privilèges
- **Docker** : sur Linux, Docker Engine est installé directement (pas Docker Desktop), `host.docker.internal` fonctionne avec `--add-host`
- **GPU** : support NVIDIA (nvidia-smi), AMD (radeontop), Intel (intel_gpu_top)
- **Firewall** : sur Linux, `ufw` ou `firewalld` doit autoriser les ports 13579, 13580, 13621, 12434-12444, 3005, etc.
- **SELinux/AppArmor** : peut bloquer les services, à configurer si nécessaire

---

## 8. Fichiers à archiver (non supprimés immédiatement)

- `services/**/*.ps1` → `archive/windows/services/`
- `modules/*.ps1` → `archive/windows/modules/`
- `installer/` → `archive/windows/installer/`
- `install.ps1` → `archive/windows/install.ps1`
- `rebuild+recreate.ps1` → `archive/windows/rebuild+recreate.ps1`
- `recreate + check.ps1` → `archive/windows/recreate+check.ps1`
- `tools/hw-smi/` → `archive/windows/tools/hw-smi/`

Cela permet de garder une trace et de supporter les deux plateformes pendant la transition.
