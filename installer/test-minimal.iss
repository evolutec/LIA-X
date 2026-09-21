[Setup]
AppName=TestLIAX
AppVersion=0.1
DefaultDirName={userdesktop}\TestLIAX
OutputDir=installer\dist
OutputBaseFilename=TestLIAX-Setup
Compression=lzma
SolidCompression=yes

[Files]
Source: "README.md"; DestDir: "{app}"; Flags: ignoreversion

[Run]
Filename: "notepad.exe"; Parameters: "{app}\README.md"; Flags: postinstall

[Code]
procedure InitializeWizard();
begin
  MsgBox('Init OK', mbInformation, MB_OK);
end;
