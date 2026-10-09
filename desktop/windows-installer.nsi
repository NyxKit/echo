Unicode True
!include "MUI2.nsh"
!include "LogicLib.nsh"
Name "Echo"
OutFile "..\release\Echo-0.1.0-windows-x64-setup.exe"
InstallDir "$LOCALAPPDATA\Programs\Echo"
InstallDirRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Echo" "InstallLocation"
RequestExecutionLevel user
SetCompressor /SOLID lzma
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
!macro StopRunning
  ${If} ${FileExists} "$INSTDIR\runtime\node.exe"
    nsExec::ExecToStack '"$INSTDIR\runtime\node.exe" "$INSTDIR\server\cli.mjs" status'
    Pop $0
    Pop $1
    ${If} $0 == 0
      nsExec::ExecToStack '"$INSTDIR\runtime\node.exe" "$INSTDIR\server\cli.mjs" quit'
      Pop $0
      Pop $1
      ${If} $0 != 0
        MessageBox MB_OK|MB_ICONSTOP "Echo did not finish shutting down. Close Echo and retry."
        Abort
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend
Section "Echo"
  ${If} ${FileExists} "$INSTDIR\.echo-install"
    FileOpen $0 "$INSTDIR\.echo-install" r
    FileRead $0 $1
    FileClose $0
    StrCpy $1 $1 7
    ${If} $1 != "echo-v1"
      MessageBox MB_OK|MB_ICONSTOP "Choose an empty directory or an existing Echo installation."
      Abort
    ${EndIf}
  ${ElseIf} ${FileExists} "$INSTDIR\*.*"
    MessageBox MB_OK|MB_ICONSTOP "Choose an empty directory or an existing Echo installation."
    Abort
  ${EndIf}
  !insertmacro StopRunning
  RMDir /r "$INSTDIR\node_modules"
  RMDir /r "$INSTDIR\dist"
  RMDir /r "$INSTDIR\server"
  RMDir /r "$INSTDIR\shared"
  RMDir /r "$INSTDIR\runtime"
  RMDir /r "$INSTDIR\native"
  SetOutPath "$INSTDIR"
  File /r "..\build\package\*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateShortcut "$SMPROGRAMS\Echo.lnk" "$INSTDIR\native\echo-host.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Echo" "DisplayName" "Echo"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Echo" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Echo" "DisplayVersion" "0.1.0"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Echo" "InstallLocation" "$INSTDIR"
SectionEnd
Section "Uninstall"
  !insertmacro StopRunning
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Echo"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Echo"
  Delete "$SMPROGRAMS\Echo.lnk"
  RMDir /r "$INSTDIR\node_modules"
  RMDir /r "$INSTDIR\dist"
  RMDir /r "$INSTDIR\server"
  RMDir /r "$INSTDIR\shared"
  RMDir /r "$INSTDIR\runtime"
  RMDir /r "$INSTDIR\native"
  Delete "$INSTDIR\package.json"
  Delete "$INSTDIR\LICENSES.txt"
  Delete "$INSTDIR\.echo-install"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  ; The separate library and credential store are deliberately retained.
SectionEnd
