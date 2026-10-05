# Composants tiers — LIA-X

LIA-X est sous licence MIT (voir [`LICENSE`](LICENSE)). Les éléments ci-dessous
conservent **leur propre licence**, inchangée. Ce fichier est un relevé, pas un
contrat : la référence reste le dépôt d'origine de chaque composant.

---

## 1. Binaire embarqué dans l'installateur

| Composant | Version | Licence | Usage |
|---|---|---|---|
| [NSSM](https://nssm.cc/) | 2.24 | Domaine public / permissive | `installer\nssm\win64\nssm.exe` — enveloppement des deux services Windows |

Redistribution sans obligation particulière.

---

## 2. Images Docker des interfaces

Images **téléchargées telles quelles** puis recopiées en `lia-*`. LIA-X n'en
modifie pas le code, seulement la configuration.

| Image amont | Référence figée | Licence | Condition |
|---|---|---|---|
| [LibreChat](https://github.com/danny-avila/librechat) | `ghcr.io/danny-avila/librechat@sha256:c5db3331…` (digest) | MIT | Aucune. Redistribution et rebranding libres |
| [Open WebUI](https://github.com/open-webui/open-webui) | `ghcr.io/open-webui/open-webui:v0.11.4` | BSD-3 modifiée (depuis v0.6.6) | ⚠️ **Clause de protection du branding** : au-delà de 50 utilisateurs sur 30 jours, ni le logo, ni le nom, ni les éléments visuels ne peuvent être retirés ou modifiés |
| [AnythingLLM](https://github.com/Mintplex-Labs/anything-llm) | `mintplexlabs/anythingllm:1.17.0` | MIT | Aucune |

### ⚠️ Open WebUI — point d'attention

LIA-X **conserve le branding intact** et ne redistribue pas de version
rebrandée : la redistribution est donc possible. En revanche, l'**exploitant** d'un
déploiement LIA-X qui expose Open WebUI à plus de 50 utilisateurs sur 30 jours
doit vérifier qu'il respecte la clause en vigueur de la version qu'il a
installée — ici **v0.11.4**, figée dans `config.json` et `postinstall.ps1`.

---

## 3. Versions figées

Les images amont étaient référencées avec un tag **flottant** (`latest` /
`main`). Deux installations à des dates différentes pouvaient donc obtenir des
versions différentes, **dont des licences différentes** — sans que LIA-X le
sache. C'est précisément le risque que la clause de branding d'Open WebUI rend
concret.

Références figées le 2026-10-05 :

| Composant | Avant | Après |
|---|---|---|
| Open WebUI | `:main` | `:v0.11.4` |
| AnythingLLM | `:latest` | `:1.17.0` |
| LibreChat | `:latest` | `@sha256:c5db3331…` |

> **LibreChat ne publie aucun tag de version** sur GHCR (seul `latest` existe,
> vérifié) : il est donc figé par **digest**, seul moyen de garantir
> l'immuabilité. Conséquence : LIA-X ne recevra pas les correctifs amont
> automatiquement — c'est le prix assumé du contrôle juridique. Relevé
> trimestriel recommandé.

---

## 4. Runtime téléchargé à l'installation

| Composant | Source | Licence | Vérification |
|---|---|---|---|
| [llama.cpp](https://github.com/ggml-org/llama.cpp) | releases officielles, adaptée au matériel | MIT | Somme SHA-256 contrôlée à l'installation |

Sélectionné par `installer\scripts\detect-hardware.ps1` selon le backend
détecté (CUDA / ROCm / Vulkan / CPU).

---

## 5. Base de données

| Composant | Image | Licence |
|---|---|---|
| PostgreSQL + pgvector | `postgres:16-alpine` | PostgreSQL License (BSD) / pgvector PostgreSQL License |
| MongoDB (LibreChat) | `mongo:6` | SSPL |

> MongoDB n'est embarqué que comme **image amont tirée par Docker**, jamais
> recompilé. La SSPL impose des conditions sur la *distribution* du serveur
> lui-même ; l'usage d'une image officielle via LibreChat n'y est pas soumis.
> Seule une redistribution d'une image que vous providez serait à examiner.

---

## 6. Dépendances npm

`model-manager/package.json` — licences déclarées dans `package-lock.json` :

| Licence | Observation |
|---|---|
| MIT | majoritaire |
| Apache-2.0 | présente |
| ISC / BSD | minoritaires |

Aucune dépendance à copyleft fort : la licence MIT de LIA-X est compatible avec
l'ensemble.

---

## 7. Autres systèmes embarqués

| Composant | Licence |
|---|---|
| PostgreSQL (client `pg`) | MIT |
| React, Vite | MIT |
| Inno Setup (compilateur, non redistribué) | permissive |

---

*Relevé établi le 2026-10-05. Toute dépendance ajoutée ultérieurement doit être
reportée ici avant publication.*
