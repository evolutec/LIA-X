# AGENTS.md — consignes de travail sur LIA-X

> **⚠️ DERNIÈRE VALIDATION : 2026-10-04 — release publiée v2.0.2, `main` = a417fb0**
> `main` est **en avance** sur le tag : correctifs du contrôleur (`instances`,
> `embedding`), désinstallation (purge des images), `/INTERFACES`, RAG.
> La dernière release **v2.0.2** est la seule utilisable : v2.0.1 renvoie
> `421` aux clients réseau, v2.0.0 est obsolète.
> **Mettre à jour cette ligne à chaque validation de bout en bout**, et seulement
> après avoir exécuté la section 12 « Validation ».

---

## 1. Ce qu'est LIA-X

Assistant IA **100 % local** pour Windows. Un modèle de langue tourne sur la
machine de l'utilisateur via llama.cpp ; l'interface est une SPA servie par un
conteneur Node. Aucun envoi de données vers l'extérieur (les icônes de liens
externes ont été retirées pour cette raison).

Trois surfaces : la **web UI** (port 3005), une **API OpenAI-compatible**
(`/v1/chat/completions`, `/v1/completions`, `/v1/embeddings`), et un **RAG**
(import de documents, recherche vectorielle pgvector, injection de contexte).

---

## 2. Installation

### Construire l'installateur

```powershell
cd installer
& "$env:LOCALAPPDATA\Programs\Inno Setup 7\ISCC.exe" LIA-X.iss /DAppVersion=2.0.3
```

- **ISCC 6.3+ obligatoire** (le script utilise `ArchitecturesAllowed=x64compatible`).
- Durée **3 à 8 min** : lancer en arrière-plan, sinon le délai des commandes
  est dépassé.
- Les **erreurs de compilation `[Code]` n'apparaissent que dans `.err`**, jamais
  dans `.log`. Toujours lire les deux.

### Installer

```powershell
installer\dist\LIA-X-Setup.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- `
  /ACCEPTLICENSE /INTERFACES=librechat,openwebui,anythingllm
```

| Paramètre | Effet |
|---|---|
| `/VERYSILENT` | sans interface — **seul moyen de choisir les cases** |
| `/ACCEPTLICENSE` | **obligatoire** avec `/VERYSILENT` : accepte la licence MIT. Sans lui, l'installation s'arrête sur une erreur explicite — on n'accepte jamais un contrat à la place de l'utilisateur |
| `/INTERFACES=…` | `librechat`, `openwebui`, `anythingllm`. Absent = rien de coché |
| `/LOG=<fichier>` | journal détaillé, **indispensable pour tout diagnostic** |
| `/DAppVersion=` (compilation) | version injectée dans l'EXE et `package.json` |

Durée **très variable**, et c'est le cache Docker qui commande :

| Situation | Durée |
|---|---|
| images déjà en cache (réinstallation) | **~10 min** |
| première installation, 3 interfaces | **20 à 40 min** |

Ce qui coûte le plus : la construction de l'image `lia-x` (`npm ci` + build
Vite) et le téléchargement des images d'interfaces (≈ 10 Go) si absentes. Ne
jamais dépasser 280 s sur une commande : lancer en arrière-plan puis sonder.

### Désinstaller

```powershell
& 'C:\Program Files\LIA-X\unins000.exe' /VERYSILENT /SUPPRESSMSGBOXES /NORESTART
```

Conserve **modèles et volumes Docker**. Supprime `{app}`, services, conteneurs,
images LIA, raccourcis. `-Full` purge aussi les volumes (historique perdu).

Résidus normaux : `model-manager\dist\`, `runtime\host-runtime-state.json.bak`,
`is-*.tmp` d'Inno — artefacts générés à l'exécution, hors du journal
d'installation, donc non supprimés.

Deux points souvent mal compris :

- **`host-runtime-state.json` n'est PAS supprimé** (voir § 6) : les modèles
  rejoués survivent donc à une désinstallation.
- Des dossiers littéraux `{userdocs}` et `models` peuvent subsister dans
  `{app}\runtime` : ce sont des résidus d'une ancienne disposition, sans effet.

### Ce que l'installation télécharge ou construit (hors images Docker)

| Poste | Poids | Remarque |
|---|---|---|
| runtime llama.cpp | 19 à 245 Mo | selon le backend, vérifié SHA-256 |
| voix neuronale Kokoro | ~310 Mo | dans `Models\.cache\kokoro`, au premier usage |
| `node_modules` | ~39 Mo | **construit sur le poste** par `postinstall.ps1` |

D'où l'exigence **Node.js** : l'image Docker est reconstruite chez
l'utilisateur, et le frontend l'est deux fois (sur le poste, puis dans
l'image).

### Emplacement

`{autopf}` → **`C:\Program Files\LIA-X`** (mode 64 bits, registre dans la ruche
HKLM native). ⚠️ Ce n'est **pas** `Program Files (x86)`. Ne jamais « corriger »
ce point sur la foi d'un ancien doublon périmé.

---

## 3. Prérequis

| Élément | Exigence | Si absent |
|---|---|---|
| **Docker Desktop** | obligatoire | l'installation **échoue** (contrôle bloquant) |
| **Node.js 20+** | obligatoire | le frontend est **construit sur le poste** |
| Windows | **10 x64** | `MinVersion=10.0` ; Windows 7/8.1 refusés. Windows 11 recommandé |
| PowerShell 7 | recommandé | 5.1 fonctionne, plus lent |
| RAM | 16 Go | 32 Go pour les modèles > 7B |
| Espace | 20 Go + modèles | images d'interfaces ≈ 10 Go |

---

## 4. Détection matérielle (à l'installation)

Étape **2/6** de l'assistant, avant toute création de service. Elle décide du
backend llama.cpp et des réglages par défaut. **Refaite à chaque installation
et à chaque Réparer.**

### Chaîne

```
installer\scripts\hardware.ps1          moteur d'analyse (sans effet de bord)
  Get-HardwareProfile                   CPU, RAM, GPU (WMI), iGPU vs dGPU
  Get-BackendCapabilities               cuda / rocm / vulkan réellement utilisables
  Get-BackendPlan                       choisit et justifie le backend
  Get-RecommendedRuntimeConfig          contexte, gpu_layers, sleep par défaut
  Test-LlamaBinary                      le binaire téléchargé démarre-t-il ?
  Save-HardwareProfile                  écrit hardware-profile.json
        ↓
installer\scripts\detect-hardware.ps1   orchestration
  Resolve-LlamaReleaseTag               tag de release officielle
  Try-DownloadLlamaCppRelease           runtime téléchargé, vérifié SHA-256
  Remove-StaleLlamaReleases             purge les runtimes devenus inutiles
        ↓
{app}\runtime\hardware-profile.json     ce qui a été détecté (lu par l'UI)
{app}\runtime\host-runtime-config.json   config permanente, éditable à la main
```

### Backends, par ordre de préférence

| Backend | Détecté par | `source` |
|---|---|---|
| **CUDA** | `nvidia-smi.exe` interrogeant **réellement** le pilote | `nvidia-smi` |
| **ROCm** | `rocm-smi.exe`, **ou** DLL HIP / `HIP_PATH` | `rocm-smi` / `hip-runtime` |
| **Vulkan** | `vulkaninfo.exe`, **ou** ICD registre, **ou** `vulkan-1.dll` | `vulkaninfo` |
| **CPU** | toujours disponible | `always` |

⚠️ La présence de l'outil ne suffit pas : `nvidia-smi` installé mais pilote
non fonctionnel est classé **non disponible** (`available: false`, avec le
`detail` du motif de rejet).

### Mémoire GPU : le cas des iGPU

Sur un iGPU (Intel Arc, AMD intégré) il n'y a **pas de VRAM dédiée** : la
mémoire est unifiée avec la RAM. Mesures réelles sur cette machine :

```
gpu.memory.is_unified       = true
gpu.memory.dedicated_bytes  = 0
gpu.memory.unified_bytes    = 17179869184   (16 Go)
gpu.memory.usable_bytes     = 10307921510   (9,6 Go réellement exploitables)
gpu.memory.system_ram_bytes = 33840226304   (31,5 Go de RAM)
```

⚠️ **Comparer la consommation à `usable_bytes`, jamais à `unified_bytes`** :
dépasser la RAM réellement disponible fait échouer le chargement.

`best_device.adapter_ram_bytes` (4,3 Go ici) est le total **annoncé par le
pilote**, souvent fantaisiste sur iGPU ; `dedicated_estimated_bytes` (16 Go) est
la mémoire unifiée réelle. Ne pas les confondre.

### Runtime llama.cpp

Téléchargé depuis les releases officielles de `ggml-org/llama.cpp` et
**vérifié par SHA-256** avant installation. Les releases obsolètes sont purgées à
chaque passage, pour ne pas conserver ~250 Mo par release.

### Réglages recommandés

`Get-RecommendedRuntimeConfig` produit `default_context`, `default_gpu_layers`
et `sleep_idle_seconds`, bornés par le contexte natif du GGUF. Ce sont des
**suggestions** : modifiables dans l'onglet Modèles (« Mise à jour auto »),
et toute modification exige un rechargement explicite de l'instance.

### Forcer un backend

`host-runtime-config.json` est la source de vérité partagée avec l'UI :

```json
{ "backend": "cpu", "default_gpu_layers": 0, "default_context": 4096 }
```

Puis relancer la détection (assistant en mode **Réparer**, ou
`detect-hardware.ps1`). Un fichier absent ou corrompu **ne bloque pas** :
la détection automatique reprend la main.

### Diagnostic — à faire dans cet ordre

```powershell
Get-Content 'C:\Program Files\LIA-X\runtime\hardware-profile.json' -Raw | ConvertFrom-Json
Get-Content 'C:\Program Files\LIA-X\runtime\host-runtime-config.json' -Raw | ConvertFrom-Json
Get-Content 'C:\Program Files\LIA-X\logs\hw-detect.log' -Tail 40
```

`logs\hw-detect.log` indique pour chaque backend le `source` retenu et le motif
de rejet. **À lire en premier** quand un modèle ne se charge pas ou quand le
GPU est ignoré.

---

## 5. Infrastructure

### Conteneurs (réseau `lia-network`)

| Conteneur | Port hôte | Rôle | Image |
|---|---|---|---|
| `lia-x` | **3005** | LIA-X : API + UI | `lia-x:latest` |
| `lia-postgres` | — (interne) | historique + RAG, pgvector | `postgres:16` |
| `openwebui` | 3008 | interface chat | `lia-openwebui:latest` |
| `anythingllm` | 3006 | interface RAG | `lia-anythingllm:latest` |
| `librechat` | 3007 | interface chat | `lia-librechat:latest` |
| `librechat-mongo` | — (interne) | LibreChat | `mongo:6` |

### Services Windows

| Service | Port | Rôle |
|---|---|---|
| `LIA Controller` | **13579** | charge/décharge les modèles, lance `llama-server.exe` |
| `LIA GPU Metrics` | 13621 | métriques CPU/GPU, **écoute sur `127.0.0.1` uniquement** |

Images via NSSM (`{app}\tools\nssm\nssm.exe`). Logs : `{app}\logs\controller\`,
`{app}\logs\runtime\`.

### Ports et exposition

| Port | Exposition | Remarque |
|---|---|---|
| 3005 | `0.0.0.0` | **le seul à ouvrir** pour le partage réseau |
| 13579, 12434 | `0.0.0.0` | obligatoire : le conteneur joint l'hôte via `host.docker.internal` |
| 13621 | `127.0.0.1` | — |

### Partage réseau (poste maître + clients)

`10.20.3.0/24` est **un exemple** : le remplacer par le sous-réseau des postes
clients (les trois premiers octets de l'IP de l'hôte).

```powershell
New-NetFirewallRule -DisplayName "LIA-X (API 3005)" -Direction Inbound `
  -Protocol TCP -LocalPort 3005 -RemoteAddress 10.20.3.0/24 -Action Allow `
  -Profile Domain,Private
```

Côté clients : `http://<IP-HÔTE>:3005`, base URL `.../v1`, modèle `lia-local`,
**aucune clé API**. Rien à installer côté client.

⚠️ `<IP-HÔTE>` est l'**IPv4 de la machine hôte** (`ipconfig` → carte Ethernet
ou Wi-Fi), pas celle du client, et **jamais `localhost` / `127.0.0.1`** depuis un
autre poste. Ne jamais figer une adresse d'exemple dans la doc : c'est déjà
l'erreur commise, et elle envoie l'utilisateur vers un hôte inexistant.

La validation `Host` est **opt-in** (`LIA_ALLOWED_HOSTS`) : sans elle, aucune
restriction ; sinon les clients distants reçoivent `421`.

---

## 6. Modèles

- Emplacement canonique : `%USERPROFILE%\Documents\LIA-X\Models`, monté dans le
  conteneur en `/models`. **Ne jamais le changer** : le montage et le Model
  Loader en dépendent.
- Noms interdits : le deux-points `:` (illisible via le montage Windows).
- Non versionnés par git ; conservés par le désinstalleur.

### Épinglage = résidence VRAM permanente

Un modèle épinglé est démarré **sans** `--sleep-idle-seconds` : il ne se
décharge jamais après inactivité.

```powershell
# Faux = résident
Get-CimInstance Win32_Process -Filter "Name='llama-server.exe'" |
  ForEach-Object { "$($_.ProcessId) : " + ($_.CommandLine -match '--sleep-idle-seconds') }
```

Limites : sans PostgreSQL l'épinglement est ignoré ; désépingler ne décharge
pas immédiatement ; **épingler un modèle déjà chargé le redémarre** (stop +
start, 1 à 2 min) car l'option n'est appliquée qu'au lancement.

### Quels modèles sont rechargés au démarrage — et où c'est décidé

Il y a **deux endroits distincts**, et ils n'ont pas le même destin lors d'une
désinstallation. C'est la source n°1 de confusion sur « il est épinglé mais pas
chargé ».

| Information | Où elle vit | Que devient-elle après désinstallation |
|---|---|---|
| **quels modèles rejouer** (modèle, port, contexte, gpu_layers, `sleep_idle_seconds`, `active`) | `{app}\runtime\host-runtime-state.json` | **conservée** : fichier créé à l'exécution, donc inconnu d'Inno et laissé en place. En revanche, un nettoyage manuel de `{app}\runtime`, ou une réinstallation sur un dossier `{app}` vierge, le font disparaître |
| **quels modèles sont épinglés** | table `pinned_models`, PostgreSQL (volume `lia-postgres-data`) | **conservée** (le volume est préservé) |

Conséquence : une réinstallation **sans** conservation de `{app}\runtime`
retrouve les modèles épinglés en base, mais plus aucun à rejouer → ils
apparaissent épinglés tout en n'étant pas chargés. C'est le symptôme exact
« épinglé mais pas chargé ».

Au démarrage du contrôleur, la séquence de restauration relit
`host-runtime-state.json` :

```
Startup: restoring active   id=… model=… port=… ctx=… ngl=…
Startup: restoring inactive id=… model=… port=… ctx=… ngl=…
```

⚠️ La restauration est **séquentielle** : chaque `llama-server` met 1 à 2 min à
démarrer. Juste après une installation, l'onglet Modèles affiche donc un **état
intermédiaire** (le premier modèle présent, le second pas encore) sans rien
signaler. Vérifier les processus avant de conclure à un défaut :

```powershell
Get-CimInstance Win32_Process -Filter "Name='llama-server.exe'" |
  ForEach-Object { $_.CommandLine -match '-m\s+"([^"]+)"' }   # ce qui tourne VRAIMENT
```

Si un modèle est épinglé en base mais absent de cette liste, c'est qu'il n'a
pas été rejoué : vérifier que `host-runtime-state.json` contient bien une entrée
`running: true` pour lui.

### Mémoire — ne pas se fier à la colonne « Mémoire » du Gestionnaire

Avec `-ngl 999` (tout déchargé en VRAM) et `mmap` actif (défaut, pas de
`--no-mmap`) :

| Modèle | Working Set | Commit privé | GPU |
|---|---|---|---|
| 8,5 Go | **77 Mo** | 10 078 Mo | 9 506 Mo |

Les poids sont en VRAM et le GGUF est *mappé* sans être touché. Signature d'un
modèle résident : Working Set minuscule + Commit énorme + GPU saturé.

### Embeddings

- Détection par **métadonnées GGUF** (`{arch}.pooling_type`, architecture
  d'encodeur), repli sur le nom. Le nom seul se trompait dans les deux sens :
  `qwen3-embedding-0.6b` était refusé, tout `embed*` accepté à tort.
- `/v1/models` expose `embedding_declared` (détection), `embedding_active`
  (drapeau réel) et `embedding_source`.
- Le drapeau `--embedding` ne s'applique **qu'au lancement**. Un `/start` sur
  une instance vivante ne la relance pas (« fast path » du contrôleur) : il faut
  **arrêter puis démarrer**.
- Le RAG **aligne automatiquement** la colonne `vector(N)` sur le modèle choisi
  (lecture de `pg_attribute`) et purge les fragments de l'ancienne dimension.

---

## 7. Cycle de développement conteneur

```powershell
cd model-manager; npm run build
docker build -t lia-x -f Dockerfiles/Dockerfile.lia-x .

docker rm -f lia-x model-loader          # model-loader = ancien nom (migration)
docker rmi lia-model-loader:latest

docker run -d --name lia-x --network lia-network -p 3005:3005 `
  --add-host host.docker.internal:host-gateway `
  -e LLAMA_HOST_CONTROL_URL=http://host.docker.internal:13579 `
  -e LLAMA_SERVER_BASE_URL=http://host.docker.internal:12434 `
  -e METRICS_HOST_URL=http://host.docker.internal:13621 `
  -e MODEL_STORAGE_DIR=/models `
  -e RUNTIME_STATE_PATH=/runtime/host-runtime-state.json `
  -e EMBEDDING_MODEL_STATE_PATH=/models/.lia/embedding-model.json `
  -e PROXY_MODEL_ID=lia-local `
  -e "HOST_MODELS_DIR=$env:USERPROFILE\Documents\LIA-X\Models" `
  -e "HOST_INSTALL_DIR=C:\Program Files\LIA-X" `
  --mount "type=bind,source=$env:USERPROFILE\Documents\LIA-X\Models,target=/models" `
  --mount "type=bind,source=C:\Program Files\LIA-X\runtime,target=/runtime,readonly" `
  --restart unless-stopped `
  --health-cmd "curl -fsS http://127.0.0.1:3005/health > /dev/null || exit 1" `
  --health-interval 15s --health-timeout 10s --health-retries 2 `
  lia-x
```

Cette commande doit rester **alignée sur `RunLiaXContainer`** dans
`installer\LIA-X.iss`. Trois points omisivables qui cassent le diagnostic :

- `LLAMA_HOST_CONTROL_URL` : sans lui, le proxy n'atteint pas le contrôleur ;
- `/runtime` monté **`readonly`**, comme à l'installation. Un montage en
  lecture-écriture autorise le conteneur à écrire dans le dossier runtime de la
  machine hôte, ce que l'installateur interdit ;
- `--health-cmd` : c'est lui qui fait apparaître `healthy` ou `unhealthy` dans
  `docker ps`.

Itérer vite sur le **frontend seul** : `npm run build` puis
`docker cp model-manager\dist\. lia-x:/app/model-manager/dist`.

⚠️ **Fermer Docker Desktop arrête les conteneurs sans les relancer** :
`--restart unless-stopped` ne se déclenche qu'au redémarrage de Windows. Après
avoir fermé Docker, `docker start lia-x` est requis.

---

## 8. Options et variables d'environnement

| Variable | Effet |
|---|---|
| `LIA_API_TOKEN=1` | exige `X-LIA-Token` (ou `?lia_token=`) sur `/api/*` mutantes |
| `LIA_ALLOWED_HOSTS=a,b` | rejette tout autre en-tête `Host` (anti DNS-rebinding) |
| `MODEL_MANAGER_PORT` | port de l'API (3005) |
| `MODEL_STORAGE_DIR` | dossier des modèles dans le conteneur (`/models`) |
| `HOST_MODELS_DIR` | chemin hôte, pour « Ouvrir le dossier » et le raccourci |
| `RUNTIME_STATE_PATH` | état runtime monté en lecture seule |
| `METRICS_HOST_URL` | service GPU metrics (13621) |

Le token d'API est **auto-configurant** : généré au premier démarrage, persisté
dans `/models/.lia/api-token`, injecté dans le HTML de la SPA (même origine).
`/v1/*` n'est **jamais** protégé : Open WebUI, AnythingLLM et LibreChat
appellent cette surface.

---

## 9. Release et CI

| Workflow | Déclencheur | Contenu |
|---|---|---|
| `ci.yml` | push `main`, PR | syntaxe JS/CJS/PS, `test-rag`, build Vite, secrets, port 3002 |
| `release.yml` | tag `v*` | version depuis le tag, `package.json` aligné, **build obligatoire**, ISCC, contrôle de version, SHA256, release |

Règles à ne pas casser :
- la version vient **du tag** via `GITHUB_REF_NAME`, jamais d'expression
  `${{ }}` (elle a rendu l'étape inopérante) ;
- `package.json.version` doit correspondre au tag, sinon `/api/version` ment ;
- **ne jamais publier sans que `npm run build` passe**.

---

## 10. Tests

```powershell
node --check model-manager\server.js          # syntaxe
node model-manager\scripts\test-rag.cjs       # RAG, sans base ni réseau
cd model-manager; npm run build               # syntaxe JSX
tests\smoke.ps1                               # bout en bout, après install
```

**Aucun test ne couvre l'état runtime.** Trois défauts rencontrés
(`logs.css` absent du dépôt, architecture d'installation, `instances` en objet
lorsqu'il n'y a qu'un modèle) n'étaient apparus qu'en exécutant un scénario
réel, jamais en statique.

Test à ajouter en priorité, quelques lignes : **`/status` doit renvoyer
`instances` sous forme de tableau même avec une seule instance**.

---

## 11. Pièges connus

1. **PowerShell déroule un tableau à un élément.** `return $items` renvoie
   l'objet seul → JSON invalide. Écrire `return ,$items`. C'est ce qui cassait
   l'onglet Chat dès qu'un seul modèle était chargé.
2. **Un motif `.gitignore` nu est récursif.** `logs/` ignorait
   `model-manager/src/Logs/logs.css` et rendait le dépôt non compilable.
   Ancrer (`/logs/`).
3. **`nssm.exe` est l'image des deux services** : le SCM le verrouille. Il doit
   figurer dans `CloseApplicationsFilter` **et** les services doivent être
   arrêtés dans `PrepareToInstall` avant la copie.
4. **Inno Setup, section `[Code]` : préfère l'ASCII, mais ce n'est pas une
   interdiction.** Les chaînes accentuées compilent (les messages
   `RaiseException` en contiennent). Le vrai piège est ailleurs : un caractère
   non-ASCII **précède une déclaration** fait échouer la compilation sur
   l'identifiant, avec un message trompeur — c'est arrivé sur
   `PrepareToInstall`. Autre point : `PrepareToInstall` est une **`function` qui
   renvoie un String**, pas une `procedure`.
5. **Écrire avec `[System.IO.File]::WriteAllText` écrase les fins de ligne** :
   le dépôt est en CRLF. Utiliser `WriteAllLines`, ou préserver.
6. **Vérifier sur les octets bruts.** `Invoke-RestMethod` désérialise un tableau
   à un élément en objet PowerShell et masque le bug.
7. **`Invoke-WebRequest` sous PowerShell 7** : lire le corps avec
   `-SkipHttpErrorCheck`, pas `GetResponseStream()` (absent sur `HttpResponseMessage`).
8. Ne jamais `git stash` pendant une opération destructive : cela emporte l'index.
9. Les **journaux ne contiennent plus les corps de requête** (vie privée) :
   un diagnostic doit s'appuyer sur `/status`, pas sur les logs.
10. **`and` n'est PAS court-circuit en Pascal Script.** Écrire
    `if (Page <> nil) and (CurPageID = Page.ID)` déréférence `Page.ID` même
    quand `Page` est `nil` → access violation. Imbriquer les `if`.
11. **Ne jamais affecter `WizardForm.NextButton.OnClick`.** Chez Inno, cela
    *remplace* la navigation interne : le premier clic est consommé et il faut
    deux clics pour avancer. Le bon point d'ancrage est la fonction
    `NextButtonClick(CurPageID)`, surchargeable sans casser la navigation.
    Même logique pour un désactivement : `NextButton.Enabled := False` dans
    `InitializeWizard` condamne *toutes* les pages, pas seulement la page
    visée. Passer par `CurPageChanged`.
12. **`WizardForm.OnPageChanged` n'existe pas.** Le hook s'appelle
    `CurPageChanged`, en procédure, détecté automatiquement — surtout ne pas
    l'affecter. Et `OnCancelClick` attend la signature
    `(CurPageID; var Cancel, Confirm)`, alors qu'un `OnClick` de bouton attend
    seulement `(Sender)` : d'où un `Type mismatch` si on les confond.

---

## 12. Validation avant de déclarer un travail terminé

```powershell
# 1. Compilation de l'installateur
& "$env:LOCALAPPDATA\Programs\Inno Setup 7\ISCC.exe" installer\LIA-X.iss /DAppVersion=X.Y.Z

# 2. Frontend + tests
cd model-manager; npm run build; node scripts\test-rag.cjs

# 3. Cycle réel désinstallation → installation
& 'C:\Program Files\LIA-X\unins000.exe' /VERYSILENT /SUPPRESSMSGBOXES /NORESTART
installer\dist\LIA-X-Setup.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- `
  /ACCEPTLICENSE /INTERFACES=librechat,openwebui,anythingllm /LOG="$env:TEMP\install.log"

# 4. Conservation : modèles et volumes intacts
Get-ChildItem "$env:USERPROFILE\Documents\LIA-X\Models" -Filter *.gguf | Measure-Object
docker volume ls -q | Measure-Object

# 5. Fonctionnel
docker ps --format '{{.Names}}|{{.Status}}'
foreach ($p in 3005,3006,3007,3008,13579) {
  (Invoke-WebRequest "http://127.0.0.1:$p/health" -TimeoutSec 20 -SkipHttpErrorCheck).StatusCode
}
```

Puis **ouvrir réellement chaque onglet dans un navigateur et lire la console**.
Une API qui répond `200` ne prouve pas que la page s'affiche.

Mettre à jour la ligne de validation en tête de fichier une fois l'ensemble vert.
