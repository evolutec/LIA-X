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
VersionInfoVersion={#AppVersion}
VersionInfoCompany={#AppPublisher}
SetupIconFile=logo.ico
WizardImageFile=wizard.bmp
WizardSmallImageFile=wizard-small.bmp

[Languages]
Name: "french"; MessagesFile: "compiler:Languages\French.isl"

[Files]
Source: "..\modules\*"; DestDir: "{app}\modules"; Flags: ignoreversion
Source: "..\services\shared\service-helpers.ps1"; DestDir: "{app}\services\shared"; Flags: ignoreversion
Source: "..\services\controller\llama-host-controller.ps1"; DestDir: "{app}\services\controller"; Flags: ignoreversion
Source: "..\services\controller\install-service.ps1"; DestDir: "{app}\services\controller"; Flags: ignoreversion
Source: "..\services\gpu-metrics\service.ps1"; DestDir: "{app}\services\gpu-metrics"; Flags: ignoreversion
Source: "..\services\gpu-metrics\install-service.ps1"; DestDir: "{app}\services\gpu-metrics"; Flags: ignoreversion
Source: "..\config.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion isreadme
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
Source: "..\runtime\llama-releases\b11013-vulkan\*"; DestDir: "{app}\runtime\llama-releases\b11013-vulkan"; Flags: ignoreversion recursesubdirs
Source: "..\tools\hw-smi\*"; DestDir: "{app}\tools\hw-smi"; Flags: ignoreversion recursesubdirs
Source: "logo.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "nssm\win64\nssm.exe"; DestDir: "{app}\tools\nssm"; Flags: ignoreversion
Source: "..\Dockerfiles\*"; DestDir: "{app}\Dockerfiles"; Flags: ignoreversion recursesubdirs
Source: "detect-hardware.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "cleanup-stale-runtime.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "logo-big.bmp"; DestDir: "{tmp}"; Flags: dontcopy

[Directories]
Name: "{app}\logs\controller"; Permissions: users-modify
Name: "{app}\logs\runtime"; Permissions: users-modify
Name: "{app}\models"; Permissions: users-modify

[InstallDelete]
; Nettoyage des raccourcis cassés créés par les anciennes versions :
; - LIA-X Model Manager.lnk avait une cible vide ou pointait vers server.js
;   (double-clic sans effet) → remplacé par le raccourci internet .url créé
;   par la section [Icons] ci-dessous.
; - Documentation LIA-X.lnk pointait vers un .md sans association Windows
;   (« Windows ne peut pas ouvrir ce fichier »).
Type: files; Name: "{commonprograms}\LIA-X\LIA-X Model Manager.lnk"
Type: files; Name: "{commonprograms}\LIA-X\Documentation LIA-X.lnk"
Type: files; Name: "{commonprograms}\LIA-X\Ajouter interfaces LIA-X.lnk"
Type: files; Name: "{autodesktop}\LIA-X Model Manager.lnk"
Type: files; Name: "{userdesktop}\LIA-X Model Manager.lnk"

[Tasks]
Name: "desktopicon"; Description: "Créer un raccourci sur le Bureau"; GroupDescription: "Raccourcis supplémentaires:"; Flags: checkedonce

[Run]

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

  { Page maintenance si LIA-X déjà installé }
  InstallInfoPath := ExpandConstant('{autopf}\LIA-X') + '\.install-paths.json';
  if FileExists(InstallInfoPath) then
  begin
    MaintenancePage := CreateCustomPage(wpSelectDir, 'Maintenance', 'LIA-X est déjà installé. Choisissez une action.');
    SurfaceW := MaintenancePage.Surface.Width - ScaleX(8);

    optRepair := TNewRadioButton.Create(WizardForm);
    optRepair.Parent := MaintenancePage.Surface;
    optRepair.Caption := 'Réparer (conserve volumes Docker et modèles, réinstalle services et conteneurs)';
    optRepair.SetBounds(ScaleX(4), ScaleY(4), SurfaceW, ScaleY(20));
    optRepair.Checked := True;

    optRemove := TNewRadioButton.Create(WizardForm);
    optRemove.Parent := MaintenancePage.Surface;
    optRemove.Caption := 'Supprimer (services, conteneurs et raccourcis ; volumes et modèles conservés)';
    optRemove.SetBounds(ScaleX(4), ScaleY(40), SurfaceW, ScaleY(20));

    optNewInstall := TNewRadioButton.Create(WizardForm);
    optNewInstall.Parent := MaintenancePage.Surface;
    optNewInstall.Caption := 'Nouvelle installation (remplace l''existante)';
    optNewInstall.SetBounds(ScaleX(4), ScaleY(76), SurfaceW, ScaleY(20));
  end;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if FinishLogo <> nil then
    FinishLogo.Visible := (CurPageID = wpFinished);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
  InstallDir, ModelsDir, RuntimeDir, BinaryPath, ConfigPath, StatePath, NssmPath: String;
  Pwsh, JsonConfig, InstallInfo, HwLogStr: String;
  HwLog: AnsiString;
  ControllerInstallScript, GpuMetricsInstallScript: String;
  ControllerScript, GpuMetricsScript: String;
  ControllerLogDir, MetricsLogDir: String;
  StartMenuFolder, DesktopIcon: String;
  SmokeScript, StartMenuShortcut: String;
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
  ModelsDir := ExpandConstant('{userdocs}\LIA-X\Models');
  RuntimeDir := ExpandConstant('{app}\runtime');
  BinaryPath := RuntimeDir + '\llama-releases\b11013-vulkan\llama-server.exe';
  ConfigPath := RuntimeDir + '\host-runtime-config.json';
  StatePath := RuntimeDir + '\host-runtime-state.json';
  NssmPath := InstallDir + '\tools\nssm\nssm.exe';
  ControllerScript := InstallDir + '\services\controller\llama-host-controller.ps1';
  GpuMetricsScript := InstallDir + '\services\gpu-metrics\service.ps1';
  ControllerLogDir := InstallDir + '\logs\controller\lia-controller';
  MetricsLogDir := InstallDir + '\logs\lia-gpu-metrics';
  SmokeScript := InstallDir + '\tests\smoke.ps1';

  if MaintenancePage <> nil then
  begin
    if optRepair.Checked then
      MaintenanceMode := 'repair'
    else if optRemove.Checked then
      MaintenanceMode := 'remove'
    else
      MaintenanceMode := 'new';
  end
  else
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

  LogStep('Étape 1/6 : Docker');
  EnsureDocker;

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
  { Détection du matériel + choix du backend (conforme lia.ps1 : Get-BackendPlan) }
  Exec('cmd.exe', '/c "' + Pwsh + '" -NoProfile -ExecutionPolicy Bypass -File "' + InstallDir + '\detect-hardware.ps1" -RootDir "' + InstallDir + '" > "' + InstallDir + '\logs\hw-detect.log" 2>&1', InstallDir, SW_HIDE, ewWaitUntilTerminated, ResultCode);
  if FileExists(InstallDir + '\logs\hw-detect.log') then
  begin
    LoadStringFromFile(InstallDir + '\logs\hw-detect.log', HwLog);
    HwLogStr := HwLog;
    Log(HwLogStr);
  end;
  if ResultCode = 0 then
    Log('  runtime/host-runtime-config.json généré selon le matériel détecté.')
  else
  begin
    Log('  ATTENTION : détection matérielle échouée, configuration par défaut (Vulkan).');
    JsonConfig := '{' +
      '"controller_port": 13579,' +
      '"server_port": 12434,' +
      '"backend": "vulkan",' +
      '"backend_label": "Vulkan",' +
      '"binary_path": "' + JsonEscape(BinaryPath) + '",' +
      '"models_dir": "' + JsonEscape(ModelsDir) + '",' +
      '"proxy_model_id": "lia-local",' +
      '"default_context": 8192,' +
      '"default_gpu_layers": 999,' +
      '"sleep_idle_seconds": 60,' +
      '"server_port_start": 12434,' +
      '"server_port_end": 12444,' +
      '"max_instances": 6' +
      '}';
    SaveStringToFile(ConfigPath, JsonConfig, False);
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
    Exec(Pwsh, '-NoProfile -ExecutionPolicy Bypass -File "' + InstallDir + '\cleanup-stale-runtime.ps1" -InstallDir "' + InstallDir + '" -ModelsDir "' + ModelsDir + '"', InstallDir, SW_HIDE, ewWaitUntilTerminated, ResultCode);
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

  { Ouverture des onglets : model-loader + interfaces sélectionnées }
  ShellExec('open', 'http://localhost:3005', '', '', SW_SHOWNORMAL, ewNoWait, ResultCode);
  if chkAnythingLLM.Checked then
    ShellExec('open', 'http://localhost:3006', '', '', SW_SHOWNORMAL, ewNoWait, ResultCode);
  if chkOpenWebUI.Checked then
    ShellExec('open', 'http://localhost:3008', '', '', SW_SHOWNORMAL, ewNoWait, ResultCode);
  if chkLibreChat.Checked then
    ShellExec('open', 'http://localhost:3007', '', '', SW_SHOWNORMAL, ewNoWait, ResultCode);
end;

