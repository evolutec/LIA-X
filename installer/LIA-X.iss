; ==============================================================================
; LIA-X Setup for Windows 10/11
; Inno Setup 7 script — conforme aux scripts scripts/lia.ps1 + modules/docker.ps1
; ==============================================================================

#define AppName "LIA-X"
#define AppVersion "0.1.0"
#define AppPublisher "LIA-X"
#define DefaultInstallDir "{autopf}\LIA-X"
#define DefaultModelsDir "{userdocs}\LIA-X\Models"

[Setup]
AppId={{LIA-X-2026-09-17}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={#DefaultInstallDir}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
OutputDir=dist
OutputBaseFilename=LIA-X-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=classic
SetupLogging=yes
MinVersion=6.1sp1
CloseApplications=yes
CloseApplicationsFilter=*.exe
RestartApplications=no
VersionInfoVersion={#AppVersion}
VersionInfoCompany={#AppPublisher}
SetupIconFile=logo.ico
WizardImageFile=wizard.bmp
WizardSmallImageFile=wizard-small.bmp
; Entree "Applications et features" (Registre -> Uninstall) : sans DisplayIcon,
; Windows affiche une icone generique. {app}\logo.ico est installe par [Files].
UninstallDisplayIcon={app}\logo.ico
; L'entree doit apparaitre dans Parametres > Applications, et permettre le
; desinstallation via le lien classique. NoModify/NoRepair restent a 0
; (defaut) : la desinstallation est possible depuis Parametres.
UninstallDisplayName={#AppName} {#AppVersion}

[Languages]
Name: "french"; MessagesFile: "compiler:Languages\French.isl"

[Files]
; hardware.ps1 est deploye dans {app}\installer\scripts\ avec les autres
; scripts de l'installateur.detect-hardware.ps1 le dot-source (exit 1 s'il est
; absent) et postinstall.ps1 s'en sert pour revalider le binaire llama.cpp.
 Source: "..\installer\scripts\hardware.ps1"; DestDir: "{app}\installer\scripts"; Flags: ignoreversion
Source: "..\services\shared\service-helpers.ps1"; DestDir: "{app}\services\shared"; Flags: ignoreversion
Source: "..\services\controller\llama-host-controller.ps1"; DestDir: "{app}\services\controller"; Flags: ignoreversion
Source: "..\services\controller\install-service.ps1"; DestDir: "{app}\services\controller"; Flags: ignoreversion
Source: "..\services\gpu-metrics\service.ps1"; DestDir: "{app}\services\gpu-metrics"; Flags: ignoreversion
Source: "..\services\gpu-metrics\install-service.ps1"; DestDir: "{app}\services\gpu-metrics"; Flags: ignoreversion
Source: "..\config.json"; DestDir: "{app}"; Flags: ignoreversion
; ── Scripts de l'installateur ──────────────────────────────────────────────
; Tous les scripts Powershell de l'installateur sont regroupes dans
; installer\scripts\ et deploies dans {app}\installer\scripts\. Aucun n'est
; pose a la racine de {app} : ils resolvent tous leurs chemins via le
; parametre -RootDir / -InstallDir (jamais $PSScriptRoot), donc le
; sous-dossier n'a aucune incidence.
 Source: "..\installer\scripts\postinstall.ps1"; DestDir: "{app}\installer\scripts"; Flags: ignoreversion
 Source: "..\installer\scripts\uninstall-cleanup.ps1"; DestDir: "{app}\installer\scripts"; Flags: ignoreversion
; Enveloppe de detect-hardware.ps1 appelee par CurStepChanged (etape 2/6) :
; c'est elle qui fait la redirection *>&1 | Tee-Object, impossible depuis
; Exec() d'Inno (CreateProcess, aucun shell intermediaire).
 Source: "..\installer\scripts\run-hw-detect.ps1"; DestDir: "{app}\installer\scripts"; Flags: ignoreversion
 Source: "..\installer\scripts\detect-hardware.ps1"; DestDir: "{app}\installer\scripts"; Flags: ignoreversion
 Source: "..\installer\scripts\cleanup-stale-runtime.ps1"; DestDir: "{app}\installer\scripts"; Flags: ignoreversion
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\docs\*"; DestDir: "{app}\docs"; Flags: ignoreversion recursesubdirs
Source: "..\tests\smoke.ps1"; DestDir: "{app}\tests"; Flags: ignoreversion
Source: "..\model-manager\package.json"; DestDir: "{app}\model-manager"; Flags: ignoreversion
Source: "..\model-manager\package-lock.json"; DestDir: "{app}\model-manager"; Flags: ignoreversion
Source: "..\model-manager\vite.config.js"; DestDir: "{app}\model-manager"; Flags: ignoreversion
Source: "..\model-manager\index.html"; DestDir: "{app}\model-manager"; Flags: ignoreversion
Source: "..\model-manager\server.js"; DestDir: "{app}\model-manager"; Flags: ignoreversion
Source: "..\model-manager\server-package.json"; DestDir: "{app}\model-manager"; Flags: ignoreversion
Source: "..\model-manager\src\*"; DestDir: "{app}\model-manager\src"; Flags: ignoreversion recursesubdirs
Source: "..\model-manager\public\*"; DestDir: "{app}\model-manager\public"; Flags: ignoreversion recursesubdirs
; Le runtime llama.cpp n'est PAS embarque : le backend adapte au materiel
; (CUDA / ROCm / Vulkan / CPU) est telecharge a l'installation par
; detect-hardware.ps1 depuis les releases officielles github.com/ggml-org/llama.cpp,
; puis verifie par empreinte SHA-256. Cela evite d'embarquer 85 Mo de binaire
; Vulkan qui serait inutilise sur une machine NVIDIA ou AMD.
; tools/ n'est plus embarque : hw-smi.exe est une application Win32 fenetree
; sans mode JSON, inutilisable depuis un service. Les metriques GPU viennent
; des compteurs Windows (services\gpu-metrics\service.ps1).
Source: "..\services\host-launcher\host-launcher.ps1"; DestDir: "{app}\services\host-launcher"; Flags: ignoreversion
Source: "logo.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "nssm\win64\nssm.exe"; DestDir: "{app}\tools\nssm"; Flags: ignoreversion
Source: "..\Dockerfiles\*"; DestDir: "{app}\Dockerfiles"; Flags: ignoreversion recursesubdirs
Source: "logo-big.bmp"; DestDir: "{tmp}"; Flags: dontcopy

[Directories]
Name: "{app}\logs\controller"; Permissions: users-modify
Name: "{app}\logs\runtime"; Permissions: users-modify
; Les modèles GGUF ne sont PAS stockés dans {app} : ils vivent dans
; {userdocs}\LIA-X\Models (= C:\Users\<utilisateur>\Documents\LIA-X\Models),
; créé par l'installateur et utilisé par le conteneur model-loader.
; Le dossier {userdocs}\LIA-X\Models est cree par [Code] (ForceDirectories) et postinstall.ps1.

[InstallDelete]
; Nettoyage des raccourcis cassés créés par les anciennes versions :
; - LIA-X Model Manager.lnk avait une cible vide ou pointait vers server.js
;   (double-clic sans effet) → remplacé par le raccourci internet .url créé
;   par la section [Icons] ci-dessous.
; - Documentation LIA-X.lnk pointait vers un .md sans association Windows
;   (« Windows ne peut pas ouvrir ce fichier »).
Type: files; Name: "{commonprograms}\LIA-X\LIA-X Model Manager.lnk"
Type: files; Name: "{commonprograms}\LIA-X\Documentation LIA-X.lnk"
; (l ancien « Ajouter interfaces LIA-X.lnk » pointait vers scripts\lia.ps1,
;  retire du depot avec l'installation par script direct — plus rien a nettoyer ici)
Type: files; Name: "{autodesktop}\LIA-X Model Manager.lnk"
Type: files; Name: "{userdesktop}\LIA-X Model Manager.lnk"

[Tasks]
Name: "desktopicon"; Description: "Créer un raccourci sur le Bureau"; GroupDescription: "Raccourcis supplémentaires:"; Flags: checkedonce

[Run]
; Section volontairement vide : postinstall.ps1 est appele par
; CurStepChanged(ssPostInstall) (voir fin de cette procedure). Le declarer ici
; meme sans le drapeau postinstall le ferait s'executer une SECONDE fois a la
; fermeture de l'assistant ; avec ce drapeau, Inno ajoute en plus une case a
; cocher « Executer powershell.exe » sur la page de fin.

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\installer\scripts\uninstall-cleanup.ps1"" -InstallDir ""{app}"""; Flags: runhidden waituntilterminated; RunOnceId: "LiaCleanup"

[UninstallDelete]
Type: files; Name: "{app}\.install-paths.json"
Type: files; Name: "{commonprograms}\LIA-X\LIA-X Model Manager.url"
Type: files; Name: "{commonprograms}\LIA-X\LIA-X Model Manager.lnk"
Type: files; Name: "{commonprograms}\LIA-X\Documentation LIA-X.lnk"
Type: files; Name: "{commonprograms}\LIA-X\LIA-X - Ajouter interfaces.lnk"
Type: files; Name: "{userprograms}\LIA-X\LIA-X Model Manager.url"
Type: files; Name: "{userprograms}\LIA-X\LIA-X Model Manager.lnk"
Type: files; Name: "{userprograms}\LIA-X\Documentation LIA-X.lnk"
Type: files; Name: "{userprograms}\LIA-X\LIA-X - Ajouter interfaces.lnk"
Type: files; Name: "{userstartup}\LIA-X Host Launcher.lnk"
Type: files; Name: "{userdesktop}\LIA-X Model Manager.url"
Type: files; Name: "{userdesktop}\LIA-X Model Manager.lnk"
Type: files; Name: "{autodesktop}\LIA-X Model Manager.url"
Type: files; Name: "{autodesktop}\LIA-X Model Manager.lnk"
Type: filesandordirs; Name: "{userprograms}\LIA-X"
; Le runtime llama.cpp est TELECHARGE a l'installation (31 a 245 Mo selon le
; backend) et n'est donc pas connu de l'ISS : [UninstallDelete] est le seul
; moyen de le supprimer. uninstall-cleanup.ps1 fait de meme en defense, pour
; les fichiers encore verrouilles par un processus residuel.
Type: filesandordirs; Name: "{app}\runtime\llama-releases"
; Fichiers d'etat GENERES par detect-hardware.ps1, donc non installes par
; [Files] et invisibles pour Inno : a supprimer explicitement.
Type: files; Name: "{app}\runtime\host-runtime-config.json"
Type: files; Name: "{app}\runtime\hardware-profile.json"
Type: files; Name: "{app}\runtime\host-runtime-state.json"
; Ces dossiers ne sont PAS vides apres la desinstallation :
;  - logs\ : ecrit par les services (nssm, controleur) et recree a chaque
;    demarrage ; Inno ne supprime pas un dossier non vide non declare.
;  - model-manager\node_modules : genere par postinstall.ps1 (npm install),
;    donc absent de [Files] et invisible pour Inno (~39 Mo).
Type: filesandordirs; Name: "{app}\logs"
Type: filesandordirs; Name: "{app}\model-manager\node_modules"

[Icons]
Name: "{commonprograms}\LIA-X\LIA-X Model Manager"; Filename: "http://localhost:3005"; IconFilename: "{app}\logo.ico"; IconIndex: 0; Comment: "Interface LIA-X (Model Manager)"
Name: "{commonprograms}\LIA-X\Documentation LIA-X"; Filename: "{app}\docs"; Comment: "Documentation LIA-X (dossier docs)"
Name: "{autodesktop}\LIA-X Model Manager"; Filename: "http://localhost:3005"; IconFilename: "{app}\logo.ico"; IconIndex: 0; Comment: "Interface LIA-X (Model Manager)"; Tasks: desktopicon

[Code]
var
  InterfacesPage, MaintenancePage: TWizardPage;
  chkLibreChat, chkOpenWebUI, chkAnythingLLM: TNewCheckBox;
  optRepair, optRemove, optNewInstall: TNewRadioButton;
  MaintenanceMode: String;
  LiaClosingForUninstall: Boolean;
  DockerWarning: TNewStaticText;
  LogMemo: TMemo;
  FinishLogo: TBitmapImage;

{ ── Journal affiché directement dans la fenêtre de l'installateur ──────────── }
procedure Log(const S: String);
begin
  if LogMemo <> nil then
  begin
    LogMemo.Lines.Add(S);
    LogMemo.Refresh;
    WizardForm.Refresh;
  end;
end;

procedure LogStep(const S: String);
begin
  Log('');
  Log('== ' + S + ' ==');
end;

{ ── Localisation de docker.exe ─────────────────────────────────────────────── }
function DockerPath: String;
begin
  Result := ExpandConstant('{pf}\Docker\Docker\resources\bin\docker.exe');
  if not FileExists(Result) then
    Result := 'docker.exe';
end;

function DockerDaemonOk: Boolean;
var
  ResultCode: Integer;
begin
  Exec(DockerPath, 'info', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := ResultCode = 0;
end;

{ Docker Desktop absent ou arrêté : tentative de démarrage automatique }
procedure EnsureDocker;
var
  DockerDesktop: String;
  ResultCode: Integer;
  I: Integer;
begin
  DockerDesktop := ExpandConstant('{pf}\Docker\Docker\Docker Desktop.exe');
  if DockerDaemonOk then
  begin
    Log('Docker : daemon opérationnel.');
    exit;
  end;
  if FileExists(DockerDesktop) then
  begin
    Log('Docker daemon non prêt : démarrage automatique de Docker Desktop...');
    Exec(DockerDesktop, '', '', SW_SHOWMINIMIZED, ewNoWait, ResultCode);
    for I := 1 to 24 do
    begin
      Sleep(5000);
      if DockerDaemonOk then
      begin
        Log('Docker : daemon opérationnel (après ' + IntToStr(I * 5) + ' s).');
        exit;
      end;
    end;
    Log('ATTENTION : Docker daemon toujours non prêt après 120 s.');
  end
  else
    Log('ATTENTION : Docker Desktop introuvable. Installez-le depuis https://www.docker.com/products/docker-desktop/');
end;

function ContainerExists(const ContainerName: String): Boolean;
var
  ResultCode: Integer;
begin
  Exec(DockerPath, 'inspect -f "{{.Id}}" ' + ContainerName, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := ResultCode = 0;
end;

function IsContainerRunning(const ContainerName: String): Boolean;
var
  ResultCode: Integer;
begin
  Exec('cmd.exe', '/c "' + DockerPath + '" ps -q --filter "name=^' + ContainerName + '$" | findstr .', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := ResultCode = 0;
end;

{ Conforme à modules/docker.ps1 : Remove-Container puis recréation }
procedure RemoveContainer(const ContainerName: String);
var
  ResultCode: Integer;
begin
  if ContainerExists(ContainerName) then
  begin
    if IsContainerRunning(ContainerName) then
      Log('  Conteneur ' + ContainerName + ' en cours : arrêt.');
    Exec(DockerPath, 'rm -f ' + ContainerName, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Log('  Conteneur ' + ContainerName + ' supprimé.');
  end;
end;

function ImagePresent(const ImageName: String): Boolean;
var
  ResultCode: Integer;
begin
  Exec(DockerPath, 'image inspect ' + ImageName, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := ResultCode = 0;
end;

procedure PullImage(const ImageName: String);
var
  ResultCode: Integer;
begin
  Log('  Image absente, téléchargement : ' + ImageName);
  Exec(DockerPath, 'pull ' + ImageName, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  if not ImagePresent(ImageName) then
    Log('  ERREUR : téléchargement impossible : ' + ImageName);
end;

procedure EnsureNetwork(const NetworkName: String);
var
  ResultCode: Integer;
begin
  Exec(DockerPath, 'network inspect ' + NetworkName, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  if ResultCode <> 0 then
  begin
    Log('  Création du réseau Docker ' + NetworkName);
    Exec(DockerPath, 'network create ' + NetworkName, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end
  else
    Log('  Réseau Docker ' + NetworkName + ' : déjà présent.');
end;

function IsServiceRunning(const ServiceName: String): Boolean;
var
  ResultCode: Integer;
begin
  Exec('cmd.exe', '/c sc query "' + ServiceName + '" | find "RUNNING"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := ResultCode = 0;
end;

function ServiceExists(const ServiceName: String): Boolean;
var
  ResultCode: Integer;
begin
  Exec('cmd.exe', '/c sc query "' + ServiceName + '" | find "STATE"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := ResultCode = 0;
end;

{ ── Conteneurs applicatifs (paramètres identiques à scripts/lia.ps1) ───────── }

procedure RunModelLoaderContainer(const InstallDir, ModelsDir: String);
var
  ResultCode: Integer;
  Args: String;
begin
  Args := 'run -d --name model-loader --network lia-network -p 3005:3005' +
    ' --add-host host.docker.internal:host-gateway' +
    ' -e LLAMA_HOST_CONTROL_URL=http://host.docker.internal:13579' +
    ' -e LLAMA_SERVER_BASE_URL=http://host.docker.internal:12434' +
    ' -e METRICS_HOST_URL=http://host.docker.internal:13621' +
    ' -e MODEL_STORAGE_DIR=/models' +
    ' -e RUNTIME_STATE_PATH=/runtime/host-runtime-state.json' +
    ' -e EMBEDDING_MODEL_STATE_PATH=/models/.lia/embedding-model.json' +
    ' -e PROXY_MODEL_ID=lia-local' +
    ' -e "HOST_MODELS_DIR=' + ModelsDir + '"' +
    ' -e "HOST_INSTALL_DIR=' + InstallDir + '"' +
    ' --mount "type=bind,source=' + ModelsDir + ',target=/models"' +
    ' --mount "type=bind,source=' + InstallDir + '\runtime,target=/runtime,readonly"' +
    ' --restart unless-stopped' +
    ' --health-cmd "curl -fsS http://127.0.0.1:3005/health > /dev/null || exit 1"' +
    ' --health-interval 15s --health-timeout 10s --health-retries 2' +
    ' lia-model-loader:latest';
  Exec(DockerPath, Args, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  if ResultCode = 0 then
    Log('  model-loader démarré sur http://localhost:3005')
  else
    Log('  ERREUR : démarrage de model-loader impossible.');
end;

procedure BuildModelLoaderImage(const InstallDir: String);
var
  ResultCode: Integer;
begin
  Log('  Construction de l''image lia-model-loader:latest ...');
  Exec(DockerPath, 'build -t lia-model-loader:latest -f "' + InstallDir + '\Dockerfiles\Dockerfile.model-loader" "' + InstallDir + '"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  if ResultCode = 0 then
    Log('  Image lia-model-loader:latest prête.')
  else
    Log('  ERREUR : build de lia-model-loader impossible.');
end;

procedure RunAnythingLLMContainer;
var
  ResultCode: Integer;
  ImageName, Args: String;
begin
  ImageName := 'mintplexlabs/anythingllm:latest';
  if not ImagePresent(ImageName) then
    PullImage(ImageName);
  Args := 'run -d --name anythingllm --network lia-network -p 3006:3001' +
    ' --add-host host.docker.internal:host-gateway' +
    ' -e STORAGE_DIR=/app/server/storage' +
    ' -e LLM_PROVIDER=generic-openai' +
    ' -e GENERIC_OPEN_AI_BASE_PATH=http://host.docker.internal:3005/v1' +
    ' -e GENERIC_OPEN_AI_MODEL_PREF=lia-local' +
    ' -e GENERIC_OPEN_AI_API_KEY=not-used' +
    ' -e GENERIC_OPEN_AI_MODEL_TOKEN_LIMIT=8192' +
    ' -e EMBEDDING_ENGINE=native' +
    ' -e NO_PROXY=model-loader,localhost,127.0.0.1,host.docker.internal' +
    ' -e no_proxy=model-loader,localhost,127.0.0.1,host.docker.internal' +
    ' -v anythingllm-storage:/app/server/storage' +
    ' --restart unless-stopped ' + ImageName;
  Exec(DockerPath, Args, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  if ResultCode = 0 then
    Log('  anythingllm démarré sur http://localhost:3006')
  else
    Log('  ERREUR : démarrage de anythingllm impossible.');
end;

procedure RunOpenWebUIContainer;
var
  ResultCode: Integer;
  ImageName, Args: String;
begin
  ImageName := 'ghcr.io/open-webui/open-webui:main';
  if not ImagePresent(ImageName) then
    PullImage(ImageName);
  Args := 'run -d --name openwebui --network lia-network -p 3008:8080' +
    ' --add-host host.docker.internal:host-gateway' +
    ' -e WEBUI_AUTH=False' +
    ' -e WEBUI_SECRET_KEY=lia-local-secret' +
    ' -e ENABLE_OLLAMA_API=false' +
    ' -e ENABLE_OPENAI_API=true' +
    ' -e OPENAI_API_BASE_URL=http://host.docker.internal:3005/v1' +
    ' -e OPENAI_API_BASE_URLS=http://host.docker.internal:3005/v1' +
    ' -e OPENAI_API_KEYS=not-used' +
    ' -e OPENAI_API_KEY=not-used' +
    ' -v open-webui-data:/app/backend/data' +
    ' --restart unless-stopped' +
    ' --health-cmd "curl -fsS http://127.0.0.1:8080/ > /dev/null || exit 1"' +
    ' --health-interval 30s --health-timeout 5s --health-start-period 60s --health-retries 3' +
    ' ' + ImageName;
  Exec(DockerPath, Args, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  if ResultCode = 0 then
    Log('  openwebui démarré sur http://localhost:3008')
  else
    Log('  ERREUR : démarrage de openwebui impossible.');
end;

procedure RunLibreChatContainer;
var
  ResultCode: Integer;
  ImageName, Args: String;
begin
  { MongoDB requis pour LibreChat — conforme à lia.ps1 }
  RemoveContainer('librechat-mongo');
  Args := 'run -d --name librechat-mongo --network lia-network' +
    ' -v librechat-mongo:/data/db --restart unless-stopped mongo:6';
  Exec(DockerPath, Args, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  if ResultCode = 0 then
    Log('  librechat-mongo démarré.')
  else
    Log('  ERREUR : démarrage de librechat-mongo impossible.');

  ImageName := 'ghcr.io/danny-avila/librechat:latest';
  if not ImagePresent(ImageName) then
    PullImage(ImageName);
  Args := 'run -d --name librechat --network lia-network -p 3007:3080' +
    ' --add-host host.docker.internal:host-gateway' +
    ' -e CONFIG_PATH=/app/librechat.yaml' +
    ' -e MONGO_URI=mongodb://librechat-mongo:27017/LibreChat' +
    ' -e JWT_SECRET=7b9d6f2a3c8e5b1d4f7a9c3e8b2d5f1a7c9e3b6d2f8a5c1e4b7d9f3a8c2e5b1d' +
    ' -e JWT_REFRESH_SECRET=5a8c2e6b9d3f5a7c1e4b8d2f6a9c3e7b5d1a4f8c2e6b9d3f5a7c1e4b8d2f6a9c' +
    ' -e ALLOW_EMAIL_LOGIN=true -e ALLOW_REGISTRATION=true -e ALLOW_SOCIAL_LOGIN=false' +
    ' -e OPENAI_API_KEY=not-used' +
    ' -e OPENAI_BASE_URL=http://host.docker.internal:3005/v1' +
    ' -e OPENAI_API_BASE_URL=http://host.docker.internal:3005/v1' +
    ' -e OPENAI_API_BASE_URLS=http://host.docker.internal:3005/v1' +
    ' -e OPENAI_REVERSE_PROXY=http://host.docker.internal:3005/v1' +
    ' -e OPENAI_MODELS_FETCH=true -e OPENAI_MODELS=lia-local' +
    ' -e AUTO_FETCH_MODELS=true' +
    ' -e CUSTOM_MODELS=[{"user":"system","name":"lia-local","displayName":"LIA Local LLM","modelName":"lia-local","icon":"llama"}]' +
    ' -e ENABLE_OPENAI=true -e OPENAI_PROXY_ENABLED=true -e DEBUG_OPENAI=true' +
    ' -e DISABLE_TELEMETRY=true' +
    ' -v librechat-data:/app/api/data' +
    ' --restart unless-stopped ' + ImageName;
  Exec(DockerPath, Args, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  if ResultCode = 0 then
    Log('  librechat démarré sur http://localhost:3007')
  else
    Log('  ERREUR : démarrage de librechat impossible.');
end;
{ ── Raccourcis (fichiers .url : fonctionne pour les adresses http) ─────────── }
procedure CreateUrlShortcut(const LinkPath, Url, IconPath: String);
begin
  ForceDirectories(ExtractFilePath(LinkPath));
  SaveStringToFile(LinkPath,
    '[InternetShortcut]' #13#10 'URL=' + Url + #13#10 +
    'IconIndex=0' #13#10 'IconFile=' + IconPath + #13#10, False);
end;
{ ── Services Windows via NSSM ──────────────────────────────────────────────── }
procedure InstallNssmService(const NssmPath, ServiceName, Pwsh, Script, Params, LogDir, Description: String);
var
  ResultCode: Integer;
begin
  if ServiceExists(ServiceName) then
  begin
    if IsServiceRunning(ServiceName) then
    begin
      Log('  Service ' + ServiceName + ' déjà installé et en cours : aucune action.');
      exit;
    end;
    Log('  Service ' + ServiceName + ' présent mais arrêté : remplacement.');
    Exec(NssmPath, 'stop "' + ServiceName + '"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec(NssmPath, 'remove "' + ServiceName + '" confirm', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end;
  Exec(NssmPath, 'install "' + ServiceName + '" ' + Pwsh + ' -NoProfile -ExecutionPolicy Bypass -File "' + Script + '" ' + Params, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(NssmPath, 'set "' + ServiceName + '" DisplayName "' + ServiceName + '"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(NssmPath, 'set "' + ServiceName + '" Description "' + Description + '"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(NssmPath, 'set "' + ServiceName + '" AppStdout "' + LogDir + '\nssm-stdout.log"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(NssmPath, 'set "' + ServiceName + '" AppStderr "' + LogDir + '\nssm-stderr.log"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(NssmPath, 'set "' + ServiceName + '" Start SERVICE_DELAYED_AUTO_START', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(NssmPath, 'start "' + ServiceName + '"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  if ResultCode = 0 then
    Log('  Service ' + ServiceName + ' installé et démarré.')
  else
    Log('  ATTENTION : démarrage du service ' + ServiceName + ' à vérifier.');
end;

{ Un service NSSM en PAUSED doit être stoppé avant toute suppression }
procedure ForceStopAndRemove(const NssmPath, ServiceName: String);
var
  ResultCode: Integer;
begin
  Exec(NssmPath, 'stop "' + ServiceName + '"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(NssmPath, 'remove "' + ServiceName + '" confirm', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('cmd.exe', '/c sc query "' + ServiceName + '" | find "STATE" >nul 2>&1 && sc.exe delete "' + ServiceName + '"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

procedure RemoveLiaServices(const NssmPath, Pwsh, InstallDir: String);
var
  ResultCode: Integer;
begin
  ForceStopAndRemove(NssmPath, 'LIA Controller');
  ForceStopAndRemove(NssmPath, 'LIA GPU Metrics');
  Exec(Pwsh, '-NoProfile -Command "Get-Service ''LIA Controller'',''LIA GPU Metrics'' -ErrorAction SilentlyContinue | Remove-Service -Force"', InstallDir, SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Log('  Services Windows LIA supprimés.');
end;

function IsServicePaused(const ServiceName: String): Boolean;
var
  ResultCode: Integer;
begin
  Exec('cmd.exe', '/c sc query "' + ServiceName + '" | find "PAUSED"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := ResultCode = 0;
end;

{ Vérifie l'état d'un service et le démarre si nécessaire }
procedure EnsureOneServiceStarted(const NssmPath, Pwsh, ServiceName: String);
var
  ResultCode: Integer;
begin
  if not ServiceExists(ServiceName) then
  begin
    Log('  ATTENTION : service ' + ServiceName + ' absent.');
    exit;
  end;
  if IsServiceRunning(ServiceName) then
  begin
    Log('  ' + ServiceName + ' : déjà en cours d''exécution.');
    exit;
  end;
  if IsServicePaused(ServiceName) then
  begin
    { NSSM met le service en PAUSED quand le processus est mort → restart }
    Log('  ' + ServiceName + ' : état PAUSED détecté, redémarrage...');
    Exec(NssmPath, 'restart "' + ServiceName + '"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end
  else
  begin
    Exec(NssmPath, 'start "' + ServiceName + '"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    if (ResultCode <> 0) or not IsServiceRunning(ServiceName) then
      Exec(Pwsh, '-NoProfile -Command "Start-Service ''" + ServiceName + "'' -ErrorAction SilentlyContinue"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end;
  if IsServiceRunning(ServiceName) then
    Log('  ' + ServiceName + ' démarré.')
  else
    Log('  ATTENTION : ' + ServiceName + ' n''a pas pu être démarré (voir logs\nssm-*).');
end;

{ Vérifie l'état réel des services et les démarre uniquement si nécessaire }
procedure EnsureLiaServicesStarted(const NssmPath, Pwsh: String);
begin
  EnsureOneServiceStarted(NssmPath, Pwsh, 'LIA Controller');
  EnsureOneServiceStarted(NssmPath, Pwsh, 'LIA GPU Metrics');
end;

function BoolToStrIS7(Value: Boolean): String;
begin
  if Value then
    Result := 'true'
  else
    Result := 'false';
end;

function JsonEscape(const S: String): String;
var
  I: Integer;
  C: Char;
begin
  Result := '';
  for I := 1 to Length(S) do
  begin
    C := S[I];
    if C = '\' then
      Result := Result + '\\'
    else if C = '"' then
      Result := Result + '\"'
    else
      Result := Result + C;
  end;
end;

function GetLibreChat(Param: String): String;
begin
  Result := BoolToStrIS7(chkLibreChat.Checked);
end;

function GetOpenWebUI(Param: String): String;
begin
  Result := BoolToStrIS7(chkOpenWebUI.Checked);
end;

function GetAnythingLLM(Param: String): String;
begin
  Result := BoolToStrIS7(chkAnythingLLM.Checked);
end;

procedure InitializeWizard();
var
  InstallInfoPath: String;
  SurfaceW: Integer;
begin
  InterfacesPage := CreateCustomPage(wpSelectDir, 'Interfaces IA', 'Choisissez les interfaces à installer.');
  SurfaceW := InterfacesPage.Surface.Width - ScaleX(8);

  chkLibreChat := TNewCheckBox.Create(WizardForm);
  chkLibreChat.Parent := InterfacesPage.Surface;
  chkLibreChat.Caption := 'LibreChat (port 3007)';
  chkLibreChat.Top := ScaleY(4);
  chkLibreChat.Left := ScaleX(4);
  chkLibreChat.Width := SurfaceW;

  chkOpenWebUI := TNewCheckBox.Create(WizardForm);
  chkOpenWebUI.Parent := InterfacesPage.Surface;
  chkOpenWebUI.Caption := 'Open WebUI (port 3008)';
  chkOpenWebUI.Top := ScaleY(28);
  chkOpenWebUI.Left := ScaleX(4);
  chkOpenWebUI.Width := SurfaceW;

  chkAnythingLLM := TNewCheckBox.Create(WizardForm);
  chkAnythingLLM.Parent := InterfacesPage.Surface;
  chkAnythingLLM.Caption := 'AnythingLLM (port 3006)';
  chkAnythingLLM.Top := ScaleY(52);
  chkAnythingLLM.Left := ScaleX(4);
  chkAnythingLLM.Width := SurfaceW;

  { Avertissement Docker affiché dans la page : aucune popup }
  DockerWarning := TNewStaticText.Create(WizardForm);
  DockerWarning.Parent := InterfacesPage.Surface;
  DockerWarning.Top := ScaleY(84);
  DockerWarning.Left := ScaleX(4);
  DockerWarning.Width := SurfaceW;
  DockerWarning.WordWrap := True;
  DockerWarning.Visible := False;
  if not DockerDaemonOk then
  begin
    DockerWarning.Caption := 'Docker Desktop n''est pas détecté ou n''est pas démarré.' + #13#10 +
      'Il sera démarré automatiquement pendant l''installation si possible.';
    DockerWarning.Visible := True;
  end;

  { Zone de journal affichée sur la page d'installation (à la place des popups) }
  LogMemo := TMemo.Create(WizardForm);
  LogMemo.Parent := WizardForm.ProgressGauge.Parent;
  LogMemo.ReadOnly := True;
  LogMemo.ScrollBars := ssVertical;
  LogMemo.Font.Name := 'Consolas';
  LogMemo.Font.Size := 8;
  LogMemo.SetBounds(WizardForm.ProgressGauge.Left,
    WizardForm.ProgressGauge.Top + WizardForm.ProgressGauge.Height + ScaleY(12),
    WizardForm.ProgressGauge.Parent.Width - WizardForm.ProgressGauge.Left * 2,
    WizardForm.ProgressGauge.Parent.Height - WizardForm.ProgressGauge.Top - WizardForm.ProgressGauge.Height - ScaleY(40));
  LogMemo.Visible := False;

  { Logo agrandi affiché sur la page finale (remplace le petit logo étiré) }
  ExtractTemporaryFile('logo-big.bmp');
  FinishLogo := TBitmapImage.Create(WizardForm);
  FinishLogo.Bitmap.LoadFromFile(ExpandConstant('{tmp}\logo-big.bmp'));
  FinishLogo.Parent := WizardForm;
  FinishLogo.SetBounds(WizardForm.ClientWidth - ScaleX(130), ScaleY(8), ScaleX(120), ScaleY(125));
  FinishLogo.Visible := False;

  { Page maintenance si LIA-X deja installe : creee juste apres Welcome pour
    apparaitre AVANT Interfaces IA / Dossier / Taches. Detecte le dossier
    reel via le marqueur .install-paths.json (install dans autopf-LIA-X
    ou ailleurs), sinon via l'AppId dans le registre.

    ATTENTION : NE PAS utiliser ExpandConstant sur la constante app ICI. On
    est dans InitializeWizard, donc AVANT son initialisation ->
    « An attempt was made to expand the "app" constant before it was
    initialized ». On passe donc par autopf (toujours resolu) ou par le
    registre, jamais par app. }
  InstallInfoPath := '';
  if FileExists(ExpandConstant('{autopf}\LIA-X\.install-paths.json')) then
    InstallInfoPath := ExpandConstant('{autopf}\LIA-X\.install-paths.json');
  if InstallInfoPath = '' then
  begin
    if RegQueryStringValue(HKLM,
      'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{LIA-X-2026-09-17}_is1',
      'Inno Setup: App Path', InstallInfoPath) then
      InstallInfoPath := InstallInfoPath + '\.install-paths.json'
    else
      InstallInfoPath := '';
  end;
  if (InstallInfoPath <> '') and FileExists(InstallInfoPath) then
  begin
    MaintenancePage := CreateCustomPage(wpWelcome, 'Maintenance', 'LIA-X est déjà installé. Choisissez une action.');
    SurfaceW := MaintenancePage.Surface.Width - ScaleX(8);

    optRepair := TNewRadioButton.Create(WizardForm);
    optRepair.Parent := MaintenancePage.Surface;
    optRepair.Caption := 'Réparer (conserve volumes Docker et modèles, réinstalle services et conteneurs)';
    optRepair.SetBounds(ScaleX(4), ScaleY(4), SurfaceW, ScaleY(20));
    optRepair.Checked := True;

    optRemove := TNewRadioButton.Create(WizardForm);
    optRemove.Parent := MaintenancePage.Surface;
    optRemove.Caption := 'Supprimer (lance le désinstalleur : services, conteneurs et raccourcis ; volumes et modèles conservés)';
    optRemove.SetBounds(ScaleX(4), ScaleY(40), SurfaceW, ScaleY(20));

    optNewInstall := TNewRadioButton.Create(WizardForm);
    optNewInstall.Parent := MaintenancePage.Surface;
    optNewInstall.Caption := 'Nouvelle installation (remplace l''existante)';
    optNewInstall.SetBounds(ScaleX(4), ScaleY(76), SurfaceW, ScaleY(20));
  end;
end;

{ Le désinstalleur DOIT tuer llama-server.exe AVANT de supprimer les fichiers :
  sinon ggml-*.dll verrouillées => échec de désinstallation. [UninstallRun]
  exécute uninstall-cleanup.ps1, mais en ceinture + bretelles on fait aussi
  un arrêt natif ici (pas de dépendance PowerShell). Ordre : services
  d'abord (sinon le contrôleur relance llama-server), puis processus. }
function InitializeUninstall(): Boolean;
var
  Res: Integer;
begin
  Result := True;
  Exec('sc.exe', 'stop "LIA Controller"', '', SW_HIDE, ewWaitUntilTerminated, Res);
  Exec('sc.exe', 'stop "LIA GPU Metrics"', '', SW_HIDE, ewWaitUntilTerminated, Res);
  { taskkill SANS /T et SANS ewWaitUntilTerminated : /T + attente bloquent
    la fermeture si un processus enfant refuse de mourir. Le kill complet
    (avec /T) est fait par uninstall-cleanup.ps1 en [UninstallRun]. }
  Exec('taskkill.exe', '/F /IM llama-server.exe', '', SW_HIDE, ewNoWait, Res);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Res: Integer;
begin
  { Dernier recours juste avant la suppression des fichiers : si un
    llama-server a redemarre entre InitializeUninstall et la suppression
    (controleur pas encore mort), on le retue ici — en ewNoWait pour ne
    jamais bloquer la fermeture de la fenetre. }
  if CurUninstallStep = usUninstall then
    Exec('taskkill.exe', '/F /IM llama-server.exe', '', SW_HIDE, ewNoWait, Res);
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if FinishLogo <> nil then
    FinishLogo.Visible := (CurPageID = wpFinished);

  // Mode suppression de secours (desinstalleur introuvable) : on arrive malgre
  // tout sur la page de fin D'INSTALLATION. On y adapte le libelle de confirmation.
  //
  // Aucune case parasite ne subsiste : « Voir README.md » vientait du drapeau
  // isreadme sur README.md et « Executer powershell.exe » du drapeau postinstall
  // sur l'entree [Run] — les deux ont ete retires (postinstall.ps1 est appele
  // directement par CurStepChanged).
  if (MaintenanceMode = 'remove') and (CurPageID = wpFinished) then
    WizardForm.FinishedLabel.Caption :=
      'LIA-X a ete supprime (volumes Docker et modeles conserves).';
end;

{ La page "Interfaces IA" n'a aucun sens en mode suppression : on la saute,
  ainsi que les pages Dossier / Groupe / Tâches / Prêt-à-installer qui
  parleraient d'"installer" alors qu'on va désinstaller. }
function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;
  if (MaintenancePage <> nil) and (MaintenanceMode = 'remove') then
  begin
    if ((InterfacesPage <> nil) and (PageID = InterfacesPage.ID))
       or (PageID = wpSelectDir) or (PageID = wpSelectProgramGroup)
       or (PageID = wpSelectTasks) or (PageID = wpReady) then
      Result := True;
  end;
end;

{ Choix "Supprimer" => on bascule vers le vrai désinstalleur Windows au lieu
  de continuer l'assistant d'installation : c'est lui qui sait supprimer les
  fichiers verrouillés (ggml-*.dll), les services NSSM et le registre. }

// L'erreur runtime « An attempt was made to expand the "app" constant before
// it was initialized » venait de ExpandConstant('{uninstallexe}') appele dans
// NextButtonClick, PAS de WizardForm.Close : cette constante n'est plus
// evaluee la-bas, le chemin du desinstalleur vient du registre.
// (PostMessage / SetTimer / WM_CLOSE ne sont pas exposes par le Pascal Script
// d'Inno Setup 7 : « Unknown identifier » — impossible de differer la
// fermeture, on ferme donc directement.)

{ Pas de confirmation "annuler l'installation" quand on bascule vers le
  desinstalleur : l'utilisateur a explicitement choisi "Supprimer".
  NOTE : Cancel doit rester True (autoriser la fermeture), seul Confirm
  passe a False (pas de dialogue). Mettre Cancel a False BLOQUE la
  fermeture — c'etait le bug "la fenetre ne se ferme pas". }
procedure CancelButtonClick(CurPageID: Integer; var Cancel, Confirm: Boolean);
begin
  if LiaClosingForUninstall then
    Confirm := False;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Uninst: String;
  Res: Integer;
begin
  Result := True;
  if (MaintenancePage <> nil) and (CurPageID = MaintenancePage.ID) then
  begin
    if optRepair.Checked then
      MaintenanceMode := 'repair'
    else if optRemove.Checked then
      MaintenanceMode := 'remove'
    else
      MaintenanceMode := 'new';
    // Bascule vers le vrai désinstalleur, sans la confirmation "Voulez-vous
    // annuler l'installation ?".
    //
    // AUCUN ExpandConstant ici : la constante app n'est pas garantie
    // initialisée au moment de cette callback (erreur fatale « An attempt was
    // made to expand the "app" constant before it was initialized »). On lit
    // donc le chemin déjà stocké dans le registre — en CONSERVANT les
    // guillemets, sinon "C:\Program Files\LIA-X\unins000.exe" est inexploitable
    // pour Exec. Si la clé est absente, on laisse l'assistant poursuivre en
    // mode suppression interne (ssPostInstall), qui fait le même travail.
    //
    // NB : `and` n'est pas court-circuit en Pascal Script — les conditions
    // sont testées dans des if imbriqués.
    if MaintenanceMode = 'remove' then
    begin
      Uninst := '';
      if RegQueryStringValue(HKLM,
           'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{LIA-X-2026-09-17}_is1',
           'UninstallString', Uninst) and (Uninst <> '') then
      begin
        LiaClosingForUninstall := True;
        Exec('"' + RemoveQuotes(Uninst) + '"', '', '', SW_SHOW, ewNoWait, Res);
        WizardForm.Close;
        Result := False;
      end;
    end;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
  InstallDir, ModelsDir, RuntimeDir, ConfigPath, StatePath, NssmPath: String;
  Pwsh, InstallInfo, HwLogStr: String;
  HwLog: AnsiString;
  ControllerInstallScript, GpuMetricsInstallScript: String;
  ControllerScript, GpuMetricsScript: String;
  ControllerLogDir, MetricsLogDir: String;
  StartMenuFolder: String;
  SmokeScript: String;
begin
  if CurStep = ssInstall then
  begin
    if LogMemo <> nil then
      LogMemo.Visible := True;
    exit;
  end;

  if CurStep <> ssPostInstall then
    exit;

  InstallDir := ExpandConstant('{app}');
  { ExpandConstant ne resout PAS les defines preprocesseur : il ne comprend
    que les constantes Inno. Y passer un define produisait une chaine
    litterale, et ForceDirectories creait un dossier au nom non resolu dans
    app. On construit donc le chemin a partir de userdocs directement. }
  ModelsDir := ExpandConstant('{userdocs}\LIA-X\Models');
  RuntimeDir := ExpandConstant('{app}\runtime');
  ConfigPath := RuntimeDir + '\host-runtime-config.json';
  StatePath := RuntimeDir + '\host-runtime-state.json';
  NssmPath := InstallDir + '\tools\nssm\nssm.exe';
  ControllerScript := InstallDir + '\services\controller\llama-host-controller.ps1';
  GpuMetricsScript := InstallDir + '\services\gpu-metrics\service.ps1';
  ControllerLogDir := InstallDir + '\logs\controller\lia-controller';
  MetricsLogDir := InstallDir + '\logs\lia-gpu-metrics';
  SmokeScript := InstallDir + '\tests\smoke.ps1';

  { MaintenanceMode est deja fixe dans NextButtonClick au moment du choix
    sur la page Maintenance ; on ne l'ecrase que si la page n'existait pas. }
  if MaintenancePage = nil then
    MaintenanceMode := 'new';

  ForceDirectories(ModelsDir);
  ForceDirectories(RuntimeDir);
  ForceDirectories(InstallDir + '\logs\controller');
  ForceDirectories(InstallDir + '\logs\runtime');
  ForceDirectories(ControllerLogDir);
  ForceDirectories(MetricsLogDir);

  if Exec('pwsh', '-NoProfile -Command "exit 0"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0) then
    Pwsh := 'pwsh'
  else
    Pwsh := 'powershell.exe';

  { Tuer llama-server AVANT toute copie : sinon ggml-*.dll verrouillees
    => "DeleteFile a echoue ; code 5" sur les reinstallations. }
  if MaintenanceMode <> 'remove' then
  begin
    Exec('taskkill.exe', '/F /IM llama-server.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    RemoveLiaServices(NssmPath, Pwsh, InstallDir);
  end;

  LogStep('Étape 1/6 : Docker');
  EnsureDocker;

  { Mode suppression interne (secours si le vrai desinstalleur est absent) :
    pas d'etapes 2-6, pas de tests de fumee, pas d'ouverture navigateur. }
  if MaintenanceMode = 'remove' then
  begin
    LogStep('Suppression de LIA-X');
    RemoveLiaServices(NssmPath, Pwsh, InstallDir);
    LogStep('Suppression des conteneurs (volumes et modèles conservés)');
    RemoveContainer('librechat');
    RemoveContainer('librechat-mongo');
    RemoveContainer('openwebui');
    RemoveContainer('open-webui');
    RemoveContainer('anythingllm');
    RemoveContainer('anything-llm');
    RemoveContainer('model-loader');
    StartMenuFolder := ExpandConstant('{commonprograms}\LIA-X');
    DeleteFile(StartMenuFolder + '\LIA-X Model Manager.url');
    DeleteFile(StartMenuFolder + '\LIA-X Model Manager.lnk');
    DeleteFile(StartMenuFolder + '\Documentation LIA-X.lnk');
    DeleteFile(ExpandConstant('{userdesktop}\LIA-X Model Manager.url'));
    DeleteFile(ExpandConstant('{userdesktop}\LIA-X Model Manager.lnk'));
    DeleteFile(InstallDir + '\.install-paths.json');
    // Les raccourcis reels sont crees par postinstall.ps1 via
    // [Environment]::GetFolderPath() : Bureau utilisateur (OneDrive possible),
    // Menu Demarrer UTILISATEUR et dossier Demarrage. Les lignes ci-dessus
    // ne les touchent pas : d'ou des raccourcis orphelins apres suppression.
    DeleteFile(ExpandConstant('{userprograms}\LIA-X\LIA-X Model Manager.lnk'));
    DeleteFile(ExpandConstant('{userprograms}\LIA-X\LIA-X Model Manager.url'));
    DeleteFile(ExpandConstant('{userprograms}\LIA-X\LIA-X - Ajouter interfaces.lnk'));
    DeleteFile(ExpandConstant('{userprograms}\LIA-X\Documentation LIA-X.lnk'));
    DeleteFile(ExpandConstant('{userstartup}\LIA-X Host Launcher.lnk'));
    DeleteFile(ExpandConstant('{desktop}\LIA-X Model Manager.lnk'));
    DeleteFile(ExpandConstant('{desktop}\LIA-X Model Manager.url'));
    // Secours : le script de nettoyage officiel (services, llama-server,
    // conteneurs, raccourcis) s'il est encore present sur disque.
    if FileExists(InstallDir + '\installer\scripts\uninstall-cleanup.ps1') then
      Exec('cmd.exe', '/c ""' + Pwsh + '" -NoProfile -ExecutionPolicy Bypass -File "' +
        InstallDir + '\installer\scripts\uninstall-cleanup.ps1" -InstallDir "' +
        InstallDir + '""', InstallDir, SW_HIDE, ewWaitUntilTerminated, ResultCode);
    LogStep('Suppression terminée. Volumes Docker et modèles conservés.');
    exit;
  end;

  if MaintenanceMode <> 'new' then
  begin
    LogStep('Nettoyage de l''installation existante');
    RemoveLiaServices(NssmPath, Pwsh, InstallDir);
    RemoveContainer('librechat');
    RemoveContainer('librechat-mongo');
    RemoveContainer('openwebui');
    RemoveContainer('open-webui');
    RemoveContainer('anythingllm');
    RemoveContainer('anything-llm');
    RemoveContainer('model-loader');
  end;

  LogStep('Étape 2/6 : Détection matérielle et configuration runtime');
  { Détection du matériel + choix du backend (conforme lia.ps1 : Get-BackendPlan)

    NE JAMAIS passer `*>&1 | Tee-Object ...` (ni `> log 2>&1`) dans le
    parametre `Params` de Exec() : Inno appelle CreateProcess directement, sans
    shell intermediaire, donc ces operateurs ne sont PAS interpretes. Ils sont
    recus par detect-hardware.ps1 comme arguments positionnels, le binding echoue
    et l'installateur leve « Détection matérielle échouée » alors que la
    detection marche parfaitement en ligne de commande.

    La redirection est donc faite par l'enveloppe PowerShell
    installer\scripts\run-hw-detect.ps1, qui appelle detect-hardware.ps1 et
    fait le `*>&1 | Tee-Object` en interne — le seul niveau ou ces operateurs
    sont reellement evalues. Elle propage aussi le code de sortie reel. }
  if Exec(Pwsh, '-NoProfile -ExecutionPolicy Bypass -File "' +
      InstallDir + '\installer\scripts\run-hw-detect.ps1" -RootDir "' + InstallDir +
      '" -ModelsDir "' + ModelsDir + '" -LogPath "' + InstallDir + '\logs\hw-detect.log"',
      InstallDir, SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0) then
  begin
    { Le stderr contient souvent des warnings benignes (noms deculture
      manquants, etc.) : on ne le traite pas comme une erreur. }
    if FileExists(InstallDir + '\logs\hw-detect.log') then
    begin
      LoadStringFromFile(InstallDir + '\logs\hw-detect.log', HwLog);
      HwLogStr := HwLog;
      Log(HwLogStr);
    end;
    Log('  runtime/host-runtime-config.json généré selon le matériel détecté.');
  end
  else
  begin
    Log('  ERREUR : la détection matérielle n''a pas pu produire une configuration runtime valide (code ' + IntToStr(ResultCode) + ').');
    if FileExists(InstallDir + '\logs\hw-detect.log') then
    begin
      LoadStringFromFile(InstallDir + '\logs\hw-detect.log', HwLog);
      HwLogStr := HwLog;
      Log(HwLogStr);
    end;
    Log('  Installation interrompue pour éviter un backend Vulkan arbitraire ou des paramètres GPU incorrects.');
    RaiseException('Détection matérielle échouée. Consultez ' + InstallDir + '\logs\hw-detect.log.');
  end;
  if not FileExists(StatePath) then
    SaveStringToFile(StatePath, '{}', False);

  InstallInfo := '{' +
    '"install_dir": "' + JsonEscape(InstallDir) + '",' +
    '"models_dir": "' + JsonEscape(ModelsDir) + '",' +
    '"controller_port": 13579,' +
    '"llama_port": 12434,' +
    '"loader_port": 3005,' +
    '"librechat": ' + BoolToStrIS7(chkLibreChat.Checked) + ',' +
    '"open_webui": ' + BoolToStrIS7(chkOpenWebUI.Checked) + ',' +
    '"anything_llm": ' + BoolToStrIS7(chkAnythingLLM.Checked) +
    '}';
  SaveStringToFile(InstallDir + '\.install-paths.json', InstallInfo, False);

  LogStep('Étape 3/6 : Services Windows');
  { Conforme à lia.ps1 : Ensure-ControllerServiceInstalled / Start-HostMetricsService
    via les scripts officiels install-service.ps1 (gèrent NSSM, pwsh, démarrage et
    vérification du port, ordre critique arrêt/suppression) }
  ControllerInstallScript := InstallDir + '\services\controller\install-service.ps1';
  GpuMetricsInstallScript := InstallDir + '\services\gpu-metrics\install-service.ps1';
  { nssm.exe doit être trouvable par Get-NssmExecutable (Get-Command nssm.exe) :
    on préfixe le PATH avec le dossier tools\nssm de l'installation }
  if FileExists(ControllerInstallScript) then
  begin
    Log('  Installation / mise à jour du service LIA Controller...');
    Exec('cmd.exe', '/c set "PATH=' + InstallDir + '\tools\nssm;%PATH%" && "' + Pwsh + '" -NoProfile -ExecutionPolicy Bypass -File "' + ControllerInstallScript + '" -RootDir "' + InstallDir + '"', InstallDir, SW_HIDE, ewWaitUntilTerminated, ResultCode);
    if ResultCode = 0 then
      Log('  Service LIA Controller installé.')
    else
      Log('  ATTENTION : installation du service LIA Controller a échoué (code ' + IntToStr(ResultCode) + ').');
  end
  else
    Log('  ATTENTION : services\controller\install-service.ps1 introuvable.');

  if FileExists(GpuMetricsInstallScript) then
  begin
    Log('  Installation / mise à jour du service LIA GPU Metrics...');
    Exec('cmd.exe', '/c set "PATH=' + InstallDir + '\tools\nssm;%PATH%" && "' + Pwsh + '" -NoProfile -ExecutionPolicy Bypass -File "' + GpuMetricsInstallScript + '" -RootDir "' + InstallDir + '"', InstallDir, SW_HIDE, ewWaitUntilTerminated, ResultCode);
    if ResultCode = 0 then
      Log('  Service LIA GPU Metrics installé.')
    else
      Log('  ATTENTION : installation du service LIA GPU Metrics a échoué (code ' + IntToStr(ResultCode) + ').');
  end
  else
    Log('  ATTENTION : services\gpu-metrics\install-service.ps1 introuvable.');

  { Vérifie l'état réel : démarre uniquement si nécessaire }
  EnsureLiaServicesStarted(NssmPath, Pwsh);

  LogStep('Étape 4/6 : Réseau Docker et model-loader');
  EnsureNetwork('lia-network');
  if DockerDaemonOk then
  begin
    { Nettoyage des contrôleurs obsolètes (ex. lancés depuis un dépôt de dev)
      qui occupent le port 13579 et chargent des modèles hors du dossier installé }
    Log('  Arrêt des contrôleurs/instances llama-server obsolètes...');
    Exec(Pwsh, '-NoProfile -ExecutionPolicy Bypass -File "' + InstallDir + '\installer\scripts\cleanup-stale-runtime.ps1" -InstallDir "' + InstallDir + '" -ModelsDir "' + ModelsDir + '"', InstallDir, SW_HIDE, ewWaitUntilTerminated, ResultCode);
    if ResultCode = 0 then
      Log('  Contrôleurs obsolètes traités et état runtime assaini (voir logs\cleanup-runtime.log).')
    else
      Log('  ATTENTION : nettoyage des contrôleurs obsolètes en échec (code ' + IntToStr(ResultCode) + ').');
    BuildModelLoaderImage(InstallDir);
    RemoveContainer('model-loader');
    RunModelLoaderContainer(InstallDir, ModelsDir);
  end
  else
    Log('  ERREUR : Docker indisponible, conteneurs non installés.');

  LogStep('Étape 5/6 : Conteneurs applicatifs');
  if DockerDaemonOk then
  begin
    if chkAnythingLLM.Checked then
    begin
      RemoveContainer('anythingllm');
      RunAnythingLLMContainer;
    end;
    if chkOpenWebUI.Checked then
    begin
      RemoveContainer('openwebui');
      RunOpenWebUIContainer;
    end;
    if chkLibreChat.Checked then
    begin
      RemoveContainer('librechat');
      RunLibreChatContainer;
    end;
  end;

  LogStep('Étape 6/6 : Raccourcis');
  { Créés nativement par Inno via la section [Icons] :
    - Menu Démarrer \LIA-X\LIA-X Model Manager (.url, port 3005)
    - Menu Démarrer \LIA-X\Documentation LIA-X
    - Bureau \LIA-X Model Manager (si tâche desktopicon cochée) }
  Log('  Raccourcis Menu Démarrer et Bureau créés par l''installateur.');

  LogStep('Vérification de la stack (tests de fumée)');
  if FileExists(SmokeScript) and DockerDaemonOk then
  begin
    Log('  Attente de la disponibilité des services (20 s)...');
    Sleep(20000);
    Exec(Pwsh, '-NoProfile -ExecutionPolicy Bypass -File "' + SmokeScript + '"', InstallDir, SW_HIDE, ewWaitUntilTerminated, ResultCode);
    if ResultCode = 0 then
      Log('  Tous les tests de fumée passent.')
    else
      Log('  ATTENTION : certains tests de fumée ont échoué (code ' + IntToStr(ResultCode) + ').');
  end
  else
    Log('  [SKIP] tests de fumée non exécutés.');

  LogStep('Installation terminée !');
  Log('  Model Loader -> http://localhost:3005');
  if chkAnythingLLM.Checked then
    Log('  AnythingLLM  -> http://localhost:3006');
  if chkOpenWebUI.Checked then
    Log('  Open WebUI   -> http://localhost:3008');
  if chkLibreChat.Checked then
    Log('  LibreChat    -> http://localhost:3007');

  { Page de fin adaptée au mode : pas de "cliquez sur Terminer pour lancer" }
  if MaintenanceMode = 'repair' then
    WizardForm.FinishedLabel.Caption := 'Réparation de LIA-X terminée. Les services et conteneurs ont été réinstallés.'
  else if MaintenanceMode = 'new' then
    WizardForm.FinishedLabel.Caption := 'Installation de LIA-X terminée.';

  if MaintenanceMode <> 'remove' then
  begin
    { postinstall.ps1 est appele ici, et NON via [Run] + drapeau postinstall.
      Ce drapeau ajoute une case a cocher « Executer powershell.exe » sur la page
      de fin ; or ce script fait partie de l'installation (build du frontend,
      Docker, conteneurs) — il doit toujours s'executer, pas a la demande.
      CurStepChanged(ssPostInstall) s'execute au meme moment que la section
      Run (juste apres les etapes 1/6 a 6/6) : l'ordre est donc inchange. }
    LogStep('Post-installation (frontend, Docker, conteneurs)');
    Exec(Pwsh, '-NoProfile -ExecutionPolicy Bypass -File "' + InstallDir +
      '\installer\scripts\postinstall.ps1" -InstallDir "' + InstallDir +
      '" -ModelsDir "' + ModelsDir + '" -ControllerPort 13579 -LlamaPort 12434 -LoaderPort 3005',
      InstallDir, SW_HIDE, ewWaitUntilTerminated, ResultCode);
    if ResultCode = 0 then
      Log('  Post-installation terminee.')
    else
      Log('  ATTENTION : la post-installation a signale une erreur (code ' + IntToStr(ResultCode) + ').');

    { Ouverture des onglets : model-loader + interfaces selectionnees.
      Jamais en mode remove : on vient de tout supprimer. }
    ShellExec('open', 'http://localhost:3005', '', '', SW_SHOWNORMAL, ewNoWait, ResultCode);
    if chkAnythingLLM.Checked then
      ShellExec('open', 'http://localhost:3006', '', '', SW_SHOWNORMAL, ewNoWait, ResultCode);
    if chkOpenWebUI.Checked then
      ShellExec('open', 'http://localhost:3008', '', '', SW_SHOWNORMAL, ewNoWait, ResultCode);
    if chkLibreChat.Checked then
      ShellExec('open', 'http://localhost:3007', '', '', SW_SHOWNORMAL, ewNoWait, ResultCode);
  end;
end;
