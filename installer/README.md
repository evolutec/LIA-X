# Installateur Windows LIA-X

Ce dossier contient les fichiers nécessaires pour construire `LIA-X-Setup.exe` avec Inno Setup.

## Contenu

- `LIA-X.iss` : script Inno Setup principal.
- `scripts/postinstall.ps1` : actions post-installation (build frontend, services, chemins).
- `nssm/win64/nssm.exe` : NSSM 2.24 embarqué pour l'installation des services Windows.
- `README.md` : ce fichier.

## Construction

1. Ouvrir `installer\LIA-X.iss` avec Inno Setup.
2. Vérifier les chemins `Source:` si la structure du repo change.
3. Lancer la compilation (Ctrl+F9 ou menu `Build`).

Le résultat est produit dans `dist\LIA-X-Setup.exe`.

## Fonctionnement de l'installateur

- Assistant en français avec page de vérification des prérequis :
  - Docker Desktop
  - Node.js 20+
  - PowerShell Core (pwsh) recommandé, fallback `powershell.exe`
- Choix du dossier d'installation (par défaut `Program Files\LIA-X` ou `%LOCALAPPDATA%\LIA-X`).
- Choix du dossier des modèles GGUF (par défaut `%USERPROFILE%\Documents\LIA-X\Models`).
- Choix des ports : Controller, llama-server, Model Loader.
- Copie des fichiers, puis exécution de `postinstall.ps1` qui :
  - build le frontend `model-manager`
  - écrit `runtime/host-runtime-config.json`
  - installe les services Windows via NSSM embarqué
  - crée les raccourcis Bureau / Menu Démarrer
- Ouverture automatique de `http://localhost:3005` à la fin.

## Notes

- Les GGUF ne sont PAS inclus ; ils sont téléchargés/importés via l'UI.
- Docker Desktop est requis pour les interfaces ; l'installateur ne l'installe pas silencieusement.
- NSSM 2.24 est embarqué dans `installer\nssm\win64\nssm.exe`.
