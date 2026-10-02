# Installateur Windows LIA-X

Ce dossier contient les fichiers nécessaires pour construire `LIA-X-Setup.exe` avec Inno Setup.

## Contenu

- `LIA-X.iss` : script Inno Setup principal.
- `scripts/postinstall.ps1` : actions post-installation (build frontend, services, chemins).
- `nssm/win64/nssm.exe` : NSSM 2.24 embarqué pour l'installation des services Windows.
- `README.md` : ce fichier.

## Construction locale

> **Prérequis de compilation : Inno Setup 6.3 ou supérieur** (le script utilise
> `ArchitecturesAllowed=x64compatible`). Utilise de préférence Inno Setup 7.

1. Ouvrir `installer\LIA-X.iss` avec Inno Setup.
2. Vérifier les chemins `Source:` si la structure du repo change.
3. Lancer la compilation (Ctrl+F9 ou menu `Build`).

Le résultat est produit dans `dist\LIA-X-Setup.exe`.

```powershell
# version de secours du script
& 'C:\Program Files (x86)\Inno Setup 6\ISCC.exe' installer\LIA-X.iss

# version explicite (ce que fait la CI : /DAppVersion vient du tag)
& $env:ISCC_PATH installer\LIA-X.iss /DAppVersion=2.1.0
```

`installer\compile.ps1` fait la même chose en cherchant ISCC.exe dans les
emplacements standards.

## Assets graphiques

`make-assets.ps1` régénère `logo.ico`, `wizard.bmp`, `wizard-small.bmp` et
`logo-big.bmp` à partir de `model-manager\public\logo.svg`. Les `.bmp` doivent
rester en **24 bpp** (Inno ignore le canal alpha → fond noir sinon).

## Release GitHub (automatique)

Le fichier `LIA-X-Setup.exe` est publié automatiquement sur GitHub Releases :
<https://github.com/evolutec/LIA-X/releases>

À chaque tag `v*` (ou via `workflow_dispatch`), le workflow :
1. déduit la version du tag (le `v` est retiré : `v2.1.0` → `2.1.0`) ;
2. construit l'installateur avec Inno Setup (`/DAppVersion=<tag>`) ;
3. **échoue** si la version embarquée dans l'EXE ne correspond pas au tag ;
4. publie un `SHA256SUMS.txt` à côté de l'installateur ;
5. crée la release et téléverse l'installateur + la somme de contrôle.

> L'installateur n'est **pas encore signé** : ajouter `SignTool` dans `[Setup]`
> (avec `SignedUninstaller=yes`) dès qu'un certificat est disponible.

## Fonctionnement de l'installateur

Pages, dans l'ordre :

1. **Bienvenue** — présentation.
2. **Maintenance** (uniquement si LIA-X est déjà installé) : Réparer /
   Supprimer / Nouvelle installation.
3. **Interfaces IA** — cases à cocher LibreChat (3007), Open WebUI (3008),
   AnythingLLM (3006). Un avertissement s'affiche si le daemon Docker ne
   répond pas.
4. **Dossier d'installation** — `Program Files\LIA-X` par défaut.
5. **Composants** (tâches) — raccourci Bureau optionnel.
6. **Prêt à installer**.
7. **Installation** — 6 étapes (Docker, détection matérielle + runtime
   llama.cpp, services Windows, réseau + images Docker + voix, conteneurs,
   raccourcis), puis post-installation et tests de fumée.

Puis `postinstall.ps1` est exécuté : build du frontend `model-manager`,
écriture de `runtime/host-runtime-config.json`, services NSSM, raccourcis.
Enfin les onglets ouverts dans le navigateur : LIA-X (3005) + les
interfaces cochées.

### Ce qui n'existe PAS (à savoir)

- **Pas de page de prérequis** : les prérequis sont vérifiés *pendant*
  l'installation, et un échec arrête l'installateur avec un message explicite
  (Docker absent → arrêt ; Node.js absent → arrêt).
- **Pas de page « dossier des modèles »** : les modèles vont toujours dans
  `%USERPROFILE%\Documents\LIA-X\Models` (dossier canonique partagé avec le
  conteneur Docker et le LIA-X).
- **Pas de page « ports »** : les ports sont fixes (3005, 13579, 12434,
  13621, 3006-3008).

## Notes

- Les GGUF ne sont PAS inclus ; ils sont téléchargés/importés via l'UI.
- Docker Desktop est **obligatoire** : l'installateur ne l'installe pas
  silencieusement, il échoue avec un message et un lien de téléchargement.
- Node.js 20+ est **obligatoire** : le frontend est construit sur la machine de
  l'utilisateur pendant l'installation (≈ 39 Mo de `node_modules`).
  TODO(cx) : prébuild dans la CI pour supprimer cette dépendance.
- NSSM 2.24 est embarqué dans `installer\nssm\win64\nssm.exe`.
- Durée réelle : 15 à 35 min selon le backend et les images à télécharger.
