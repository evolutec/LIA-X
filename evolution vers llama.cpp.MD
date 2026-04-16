# Evolution vers llama.cpp

## Objectif retenu

Migration de la stack actuelle vers llama.cpp avec les contraintes suivantes :

- bootstrap intégral depuis le script PowerShell ;
- exécution native Windows pour le runtime LLM ;
- sélection par l'utilisateur de l'interface à déployer ;
- conteneurs distincts pour Open WebUI, AnythingLLM et le Model Loader ;
- détection matérielle automatique et bascule sur le bon backend llama.cpp.

## Décision d'architecture

Le runtime llama.cpp ne tourne pas dans Docker.

Il tourne nativement sur l'hôte Windows, car c'est la seule manière réaliste de supporter avec un même script :

- NVIDIA via CUDA par défaut ;
- AMD via Vulkan ;
- Intel via Vulkan ;
- CPU fallback sans GPU compatible.

Les conteneurs Docker restent dédiés aux applications web et au plan de contrôle.

## Topologie cible

### Hôte Windows

- compilation de llama.cpp avec le backend utile pour la machine ;
- lancement de llama-server en local ;
- lancement d'un contrôleur hôte chargé de :
	- démarrer et arrêter llama-server ;
	- changer le modèle actif ;
	- exposer l'état runtime au Model Loader ;
	- conserver les métadonnées du backend et du modèle actif.

### Conteneur 1 : Model Loader

Rôle :

- interface React de gestion des modèles ;
- API de gestion de fichiers GGUF ;
- contrôle du runtime hôte via HTTP ;
- proxy OpenAI-compatible vers llama-server.

Le proxy expose un endpoint stable pour les autres services :

- http://model-loader:3002/v1

Le Model Loader devient donc la façade unique entre les interfaces web et le runtime hôte.

### Conteneur 2 : AnythingLLM

Rôle : interface RAG / workspace.

Connexion au backend :

- provider Generic OpenAI ;
- base URL : http://model-loader:3002/v1 ;
- modèle logique stable : lia-local ;
- embedder natif AnythingLLM conservé.

### Conteneur 3 : Open WebUI

Rôle : interface conversationnelle alternative.

Connexion au backend :

- OpenAI API activée ;
- Ollama désactivé par défaut ;
- URL OpenAI : http://model-loader:3002/v1.

## Réseau Docker

Tous les conteneurs sont reliés à un réseau dédié, par exemple :

- lia-network

Le conteneur Model Loader est le seul à parler à l'hôte Windows pour le contrôle runtime.

## Détection matérielle

Le script doit détecter le matériel GPU avant compilation.

Stratégie retenue :

- NVIDIA : build CUDA ; fallback Vulkan si CUDA indisponible ;
- AMD : build Vulkan ;
- Intel : build Vulkan ;
- aucun GPU reconnu : build CPU only.

La détection se base sur Win32_VideoController / CIM et sur la présence des toolkits requis.

## Dépendances à automatiser

Le script doit installer si nécessaire :

- Git ;
- CMake ;
- Ninja ;
- Visual Studio Build Tools 2022 ;
- Docker Desktop ;
- Vulkan SDK ;
- CUDA Toolkit seulement sur machines NVIDIA si absent.

## Build llama.cpp

Le script doit :

- cloner ou mettre à jour llama.cpp dans un dossier local ;
- compiler avec le backend choisi ;
- déposer les binaires dans un répertoire runtime dédié ;
- générer ou mettre à jour la configuration runtime ;
- démarrer le contrôleur hôte ;
- démarrer éventuellement llama-server avec le modèle actif si un GGUF est déjà présent.

## Choix utilisateur dans le script

Le script doit proposer explicitement :

1. Open WebUI
2. AnythingLLM
3. Les deux

En fonction du choix :

- le Model Loader est toujours déployé ;
- Open WebUI est déployé si choisi ;
- AnythingLLM est déployé si choisi.

## Gestion des modèles

Le stockage des modèles devient un répertoire GGUF local sur l'hôte Windows, monté dans le conteneur Model Loader.

Le Model Loader doit permettre :

- de lister les fichiers GGUF ;
- d'importer un GGUF depuis Hugging Face ;
- de supprimer un GGUF local ;
- de charger un modèle en relançant llama-server ;
- de décharger le modèle courant ;
- d'afficher le backend actif, le runtime et le modèle courant.

## Proxy OpenAI-compatible

Le Model Loader expose un proxy afin de stabiliser l'intégration des interfaces.

Endpoints minimaux :

- GET /v1/models
- POST /v1/chat/completions
- POST /v1/completions
- GET /health

Le proxy traduit le modèle logique lia-local vers le modèle GGUF actuellement actif.

## Impacts sur le dépôt

### pro-ipex.ps1

À refondre pour :

- abandonner WSL2 et Ollama ;
- détecter le matériel ;
- installer les dépendances ;
- compiler llama.cpp ;
- démarrer le contrôleur hôte ;
- lancer les conteneurs distincts selon le choix utilisateur.

### model-manager/server.js

À refondre pour :

- remplacer tous les appels à l'API Ollama ;
- gérer des fichiers GGUF ;
- appeler le contrôleur hôte ;
- servir de proxy OpenAI-compatible.

### model-manager/src/App.jsx

À adapter pour :

- supprimer le vocabulaire Ollama ;
- assumer un workflow GGUF / llama.cpp ;
- afficher backend, runtime, modèle actif et état du contrôleur.

### Docker

Le montage actuel AnythingLLM + Model Manager dans un même conteneur est abandonné.

Nouveaux principes :

- image dédiée Model Loader ;
- image officielle AnythingLLM ;
- image officielle Open WebUI.

## Critères de réussite

La migration est considérée correcte si :

- un seul script suffit à préparer la machine et lancer la stack ;
- le bon backend llama.cpp est choisi automatiquement ;
- le Model Loader peut charger / décharger un modèle GGUF ;
- Open WebUI et AnythingLLM peuvent dialoguer avec le runtime via le proxy du Model Loader ;
- le choix utilisateur d'interface est respecté au déploiement.
Oui, le script peut piloter une migration vers llama.cpp sur Windows, y compris l’installation de dépendances et la compilation. En revanche, il faut distinguer deux sujets :

construire et lancer llama.cpp en natif Windows ;
conserver la stack actuelle telle quelle.
Le point 1 est faisable pour OpenVINO et pour Vulkan. Le point 2 ne l’est pas en l’état, parce que le dépôt actuel est très couplé à l’API Ollama, pas seulement à “un moteur LLM”. On le voit dans pro-ipex.ps1:223, pro-ipex.ps1:289, pro-ipex.ps1:294, dans le bridge du Model Manager server.js:7-15 et dans l’image AnythingLLM Dockerfile.anythingllm:28-43.

Option A : OpenVINO

Oui, pro-ipex.ps1:132-310 pourrait récupérer CMake et Visual Studio Build Tools, puis lancer la compilation.

Faisable :

CMake est installable via winget.
Visual Studio Build Tools 2022 existe bien dans winget.
Git et Ninja sont aussi installables via winget.
La compilation peut être orchestrée par le script, à condition de charger l’environnement MSVC avant CMake.
Contraintes réelles :

OpenVINO n’apparaît pas dans winget sur la machine testée. Donc le script devrait télécharger l’archive ou l’installateur Intel directement, puis l’installer ou l’extraire lui-même.
La doc OpenVINO de llama.cpp attend aussi OpenCL via vcpkg côté Windows. Donc le script devrait probablement gérer en plus vcpkg et le package opencl.
Le build OpenVINO sous Windows passe normalement par un shell Visual Studio chargé avec les variables d’environnement MSVC. En PowerShell, c’est faisable, mais moins simple qu’un winget install classique. Le script devra soit appeler VsDevCmd.bat puis chaîner CMake dans le même processus, soit réinjecter les variables dans la session.
Côté runtime, OpenVINO sur GPU Intel demande souvent des variables d’environnement spécifiques, et le backend est encore en phase de maturation.
Point important pour ton usage : la doc llama.cpp OpenVINO mentionne des limites sur llama-server, notamment autour du parallélisme et des sessions. Pour une stack type chat applicatif, c’est un risque d’exploitation plus élevé que Vulkan.
Verdict :

Oui, techniquement automatisable par le script.
Oui, la compilation peut être gérée par le script.
Mais c’est la voie la plus fragile pour un objectif “tout en direct par un seul script”, surtout au premier run.
Option B : Vulkan

Oui, c’est l’option la plus simple si ton but est “tout faire par le script en natif Windows”.

Faisable :

Le Vulkan SDK est disponible via winget.
CMake, Git et Ninja aussi.
Pas besoin de Python.
Pas besoin de WSL.
Pas besoin de Docker pour le backend.
Le build llama.cpp avec Vulkan est direct et bien adapté à un script PowerShell.
Avantages par rapport à OpenVINO :

Moins de composants Intel spécifiques.
Moins de dépendances à préparer.
Moins de friction d’environnement que la chaîne OpenVINO + vcpkg + setupvars.
Meilleur candidat pour un bootstrap 100 % script sur Windows.
Verdict :

Oui, le script peut quasiment tout gérer pour installer, compiler et lancer llama.cpp en Vulkan.
C’est l’option la plus réaliste pour un “one-click bootstrap” Windows.
Le vrai blocage : la compatibilité avec la stack actuelle

Le dépôt ne consomme pas seulement une URL de modèle. Il consomme le comportement Ollama.

Exemples visibles dans server.js:7-15, server.js:359-511 :

liste de modèles via api/tags ;
modèles chargés en mémoire via api/ps ;
téléchargement via api/pull ;
chargement et déchargement via api/generate avec keep_alive ;
suppression via api/delete ;
création de modèle via api/create.
llama-server ne propose pas ce modèle d’administration à la Ollama. Il expose surtout une API compatible OpenAI et sert en pratique un modèle chargé par processus. Donc :

AnythingLLM peut potentiellement être rebranché vers llama-server si tu le configures en mode fournisseur OpenAI-compatible.
Le Model Manager actuel ne sera pas compatible sans refonte, car il est pensé pour les endpoints et le cycle de vie d’Ollama.
Le script peut donc automatiser le backend llama.cpp, mais pas préserver à l’identique les fonctions actuelles de gestion de modèles sans adaptation applicative.
Réponse directe à tes questions

Pour l’option A :

Oui, CMake et Visual Studio Build Tools peuvent être récupérés par le script.
Oui, la compilation peut être gérée par le script.
Mais OpenVINO lui-même demandera probablement un flux d’installation spécifique hors winget, avec plus de points de casse.
Pour l’option B :

Oui, le script peut pratiquement tout gérer pour installer les prérequis, compiler llama.cpp et lancer le serveur.
Non, pas toute la stack actuelle “sans autre changement”, car le dépôt est aujourd’hui structuré autour d’Ollama.
Recommandation

Si ton objectif prioritaire est : tout faire en direct par le script sur Windows, sans WSL ni Docker pour le backend, alors Vulkan est nettement le meilleur candidat.

Si ton objectif prioritaire est : exploiter au mieux un matériel Intel récent avec iGPU Xe, alors OpenVINO est faisable, mais le niveau de complexité et de fragilité du bootstrap est supérieur.

Si tu veux, je peux ensuite te faire un plan de migration purement théorique en 2 variantes :

variante minimale : remplacer seulement le backend par llama-server et reconfigurer AnythingLLM ;
variante complète : backend llama.cpp + nouveau Model Manager compatible llama.cpp.