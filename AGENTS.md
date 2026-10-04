# AGENTS.md — consignes de travail sur LIA-X

> **⚠️ DERNIÈRE VALIDATION : 2026-10-04 — release publiée v2.0.2, `main` = 5f1808a**
> `main` est **en avance** sur le tag (correctifs embeddings, désinstallation,
> `instances`, `/INTERFACES`).
> **Mettre à jour cette ligne à chaque validation de bout en bout**, et seulement
> après avoir exécuté la section 10 « Validation ».

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
  /INTERFACES=librechat,openwebui,anythingllm
```

| Paramètre | Effet |
|---|---|
| `/VERYSILENT` | sans interface — **seul moyen de choisir les cases** |
| `/INTERFACES=…` | `librechat`, `openwebui`, `anythingllm`. Absent = rien de coché |
| `/LOG=<fichier>` | journal détaillé, **indispensable pour tout diagnostic** |
| `/DAppVersion=` (compilation) | version injectée dans l'EXE et `package.json` |

Durée **20 à 40 min** (images d'interfaces ≈ 10 Go, build de l'image `lia-x`,
runtime llama.cpp téléchargé). Ne jamais dépasser 280 s sur une commande : lancer
en arrière-plan puis sonder.

### Désinstaller

```powershell
& 'C:\Program Files\LIA-X\unins000.exe' /VERYSILENT /SUPPRESSMSGBOXES /NORESTART
```

Conserve **modèles et volumes Docker**. Supprime `{app}`, services, conteneurs,
images LIA, raccourcis. `-Full` purge aussi les volumes (historique perdu).

Résidus normaux : `model-manager\dist\`, `runtime\host-runtime-state.json.bak`,
`is-*.tmp` d'Inno — artefacts générés à l'exécution, hors du journal
d'installation, donc non supprimés.

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
| PowerShell 7 | recommandé | 5.1 fonctionne, plus lent |
| RAM | 16 Go | 32 Go pour les modèles > 7B |
| Espace | 20 Go + modèles | images d'interfaces ≈ 10 Go |

---

## 4. Infrastructure

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

```powershell
New-NetFirewallRule -DisplayName "LIA-X (API 3005)" -Direction Inbound `
  -Protocol TCP -LocalPort 3005 -RemoteAddress 10.20.3.0/24 -Action Allow `
  -Profile Domain,Private
```

Côté clients : `http://<IP-HÔTE>:3005`, base URL `.../v1`, modèle `lia-local`,
**aucune clé API**. Rien à installer côté client.

La validation `Host` est **opt-in** (`LIA_ALLOWED_HOSTS`) : sans elle, aucune
restriction ; sinon les clients distants reçoivent `421`.

---

## 5. Modèles

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

## 6. Cycle de développement conteneur

```powershell
cd model-manager; npm run build
docker build -t lia-x -f Dockerfiles/Dockerfile.lia-x .
docker rm -f lia-x
docker run -d --name lia-x --network lia-network -p 3005:3005 `
  --add-host host.docker.internal:host-gateway `
  -e MODEL_STORAGE_DIR=/models -e RUNTIME_STATE_PATH=/runtime/host-runtime-state.json `
  -e METRICS_HOST_URL=http://host.docker.internal:13621 `
  -e EMBEDDING_MODEL_STATE_PATH=/models/.lia/embedding-model.json `
  -e HOST_MODELS_DIR="$env:USERPROFILE\Documents\LIA-X\Models" `
  -e PROXY_MODEL_ID=lia-local -e POSTGRES_HOST=lia-postgres `
  --mount "type=bind,source=$env:USERPROFILE\Documents\LIA-X\Models,target=/models" `
  --mount "type=bind,source=C:\Program Files\LIA-X\runtime,target=/runtime" `
  --restart unless-stopped lia-x
```

Itérer vite sur le **frontend seul** : `npm run build` puis
`docker cp model-manager\dist\. lia-x:/app/model-manager/dist`.

⚠️ **Fermer Docker Desktop arrête les conteneurs sans les relancer** :
`--restart unless-stopped` ne se déclenche qu'au redémarrage de Windows. Après
avoir fermé Docker, `docker start lia-x` est requis.

---

## 7. Options et variables d'environnement

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

## 8. Release et CI

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

## 9. Tests

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

## 10. Pièges connus

1. **PowerShell déroule un tableau à un élément.** `return $items` renvoie
   l'objet seul → JSON invalide. Écrire `return ,$items`. C'est ce qui cassait
   l'onglet Chat dès qu'un seul modèle était chargé.
2. **Un motif `.gitignore` nu est récursif.** `logs/` ignorait
   `model-manager/src/Logs/logs.css` et rendait le dépôt non compilable.
   Ancrer (`/logs/`).
3. **`nssm.exe` est l'image des deux services** : le SCM le verrouille. Il doit
   figurer dans `CloseApplicationsFilter` **et** les services doivent être
   arrêtés dans `PrepareToInstall` avant la copie.
4. **Inno Setup : `[Code]` = ASCII pur.** Un caractère non-ASCII fait échouer la
   compilation avec un message trompeur. `PrepareToInstall` est une
   **`function` qui renvoie un String**, pas une `procedure`.
5. **Écrire avec `[System.IO.File]::WriteAllText` écrase les fins de ligne** :
   le dépôt est en CRLF. Utiliser `WriteAllLines`, ou préserver.
6. **Vérifier sur les octets bruts.** `Invoke-RestMethod` désérialise un tableau
   à un élément en objet PowerShell et masque le bug.
7. **`Invoke-WebRequest` sous PowerShell 7** : lire le corps avec
   `-SkipHttpErrorCheck`, pas `GetResponseStream()` (absent sur `HttpResponseMessage`).
8. Ne jamais `git stash` pendant une opération destructive : cela emporte l'index.
9. Les **journaux ne contiennent plus les corps de requête** (vie privée) :
   un diagnostic doit s'appuyer sur `/status`, pas sur les logs.

---

## 11. Validation avant de déclarer un travail terminé

```powershell
# 1. Compilation de l'installateur
& "$env:LOCALAPPDATA\Programs\Inno Setup 7\ISCC.exe" installer\LIA-X.iss /DAppVersion=X.Y.Z

# 2. Frontend + tests
cd model-manager; npm run build; node scripts\test-rag.cjs

# 3. Cycle réel désinstallation → installation
& 'C:\Program Files\LIA-X\unins000.exe' /VERYSILENT /SUPPRESSMSGBOXES /NORESTART
installer\dist\LIA-X-Setup.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- `
  /INTERFACES=librechat,openwebui,anythingllm /LOG="$env:TEMP\install.log"

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
