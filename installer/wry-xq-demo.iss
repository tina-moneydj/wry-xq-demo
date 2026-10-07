; wry-xq-demo Windows installer (Inno Setup 6+/7+)
; Traditional Chinese wizard. Stage payload into installer\staging\
; (see installer\README.md / scripts\package-windows.sh).

#define MyAppName "XQ 風格測試"
#define MyAppNameEn "wry-xq-demo"
#define MyAppVersion "0.1.0"
#define MyAppPublisher "tina-moneydj"
#define MyAppExeName "wry-xq-demo.exe"
#define MyAppURL "https://github.com/tina-moneydj/wry-xq-demo"

[Setup]
AppId={{A8F3C2E1-7B94-4D6A-9E21-5C0F8B1D4A77}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
DefaultDirName={localappdata}\{#MyAppNameEn}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=Z:\workspace\wry-xq-demo\dist
OutputBaseFilename=wry-xq-demo-setup-{#MyAppVersion}
Compression=lzma2
SolidCompression=yes
LZMANumFastBytes=273
WizardStyle=modern
UninstallDisplayIcon={app}\{#MyAppExeName}
VersionInfoVersion={#MyAppVersion}
VersionInfoProductName={#MyAppName}
VersionInfoCompany={#MyAppPublisher}
InfoBeforeFile=Z:\workspace\wry-xq-demo\installer\info-before.txt

[Languages]
Name: "chinesetraditional"; MessagesFile: "compiler:Languages\ChineseTraditional.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "Z:\workspace\wry-xq-demo\installer\staging\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#MyAppName}}"; Flags: postinstall nowait skipifsilent unchecked
