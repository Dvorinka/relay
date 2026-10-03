; Relay desktop installer — NSIS 3.x, per-user install (no admin required).
;
;   makensis -DVERSION=1.2.3 -DVI_VERSION=1.2.3.0 \
;     -DEXE=build\bin\relay-desktop.exe -DOUTFILE=dist\Relay-Setup-1.2.3.exe \
;     apps\desktop\installer\relay.nsi

!ifndef VERSION
  !define VERSION "0.0.0"
!endif
!ifndef VI_VERSION
  !define VI_VERSION "0.0.0.0"
!endif
!ifndef EXE
  !define EXE "..\build\bin\relay-desktop.exe"
!endif
!ifndef OUTFILE
  !define OUTFILE "Relay-Setup-${VERSION}.exe"
!endif
!ifndef ICON
  !define ICON "..\build\windows\icon.ico"
!endif

; Optional Authenticode signing of the generated uninstaller + installer.
; Pass -DSIGNCMD="path\to\sign-windows.sh" (any in-place signer taking %1).
!ifdef SIGNCMD
  !finalize '${SIGNCMD} "%1"'
  !uninstfinalize '${SIGNCMD} "%1"'
!endif

!define APP_NAME   "Relay"
!define APP_EXE    "relay-desktop.exe"
!define UNINST_REG "Software\Microsoft\Windows\CurrentVersion\Uninstall\Relay"
; Evergreen WebView2 runtime client ID — fixed, documented by Microsoft.
!define WV2_CLIENT "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
!define WV2_URL    "https://go.microsoft.com/fwlink/p/?LinkId=2124703"
!define WV2_PAGE   "https://developer.microsoft.com/microsoft-edge/webview2/"

Name "${APP_NAME}"
OutFile "${OUTFILE}"
Icon "${ICON}"
UninstallIcon "${ICON}"
Unicode true
RequestExecutionLevel user          ; per-user install — no UAC prompt
InstallDir "$LOCALAPPDATA\Programs\Relay"
InstallDirRegKey HKCU "${UNINST_REG}" "InstallLocation"
ManifestDPIAware true
SetCompressor /SOLID lzma
ShowInstDetails show                 ; WebView2 download progress is worth seeing
BrandingText "Relay — open-source agent hub"

VIProductVersion "${VI_VERSION}"
VIAddVersionKey "ProductName"     "${APP_NAME}"
VIAddVersionKey "CompanyName"     "Relay"
VIAddVersionKey "FileDescription" "Relay desktop installer"
VIAddVersionKey "FileVersion"     "${VERSION}"
VIAddVersionKey "LegalCopyright"  "Apache-2.0"

!include "MUI2.nsh"
!include "LogicLib.nsh"

!define MUI_ICON   "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Launch Relay"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

; Refuse to fight a running instance during an upgrade.
Function .onInit
  nsExec::ExecToLog 'taskkill /F /IM ${APP_EXE} /T'
FunctionEnd

Function un.onInit
  nsExec::ExecToLog 'taskkill /F /IM ${APP_EXE} /T'
FunctionEnd

; The shell is a WebView2 host — no runtime, no window. Evergreen runtime
; ships with Win11 and patched Win10, but bootstrap it when absent.
Function EnsureWebView2
  ReadRegStr $0 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\${WV2_CLIENT}" "pv"
  ${If} $0 == ""
    ReadRegStr $0 HKLM "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WV2_CLIENT}" "pv"
  ${EndIf}
  ${If} $0 == ""
    ReadRegStr $0 HKCU "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WV2_CLIENT}" "pv"
  ${EndIf}
  ${If} $0 <> ""
    DetailPrint "WebView2 Runtime $0 already present."
    Return
  ${EndIf}

  MessageBox MB_YESNO|MB_ICONQUESTION "${APP_NAME} needs the Microsoft Edge WebView2 Runtime, which is not installed.$\r$\n$\r$\nDownload and install it now? (recommended)" IDYES wv2_download
    DetailPrint "WebView2 skipped — ${APP_NAME} will not render until it is installed."
    Return

  wv2_download:
  DetailPrint "Downloading WebView2 bootstrapper..."
  nsExec::ExecToLog '"$SYSDIR\certutil.exe" -urlcache -split -f "${WV2_URL}" "$TEMP\MicrosoftEdgeWebview2Setup.exe"'
  Pop $0
  ${IfNot} ${FileExists} "$TEMP\MicrosoftEdgeWebview2Setup.exe"
    DetailPrint "WebView2 download failed (certutil exit $0)."
    MessageBox MB_OK|MB_ICONEXCLAMATION "Could not download the WebView2 Runtime.$\r$\nInstall it manually from ${WV2_PAGE} — ${APP_NAME} will not render without it."
    Return
  ${EndIf}

  DetailPrint "Installing WebView2 Runtime..."
  ExecWait '"$TEMP\MicrosoftEdgeWebview2Setup.exe" /silent /install' $0
  Delete "$TEMP\MicrosoftEdgeWebview2Setup.exe"
  ${If} $0 <> 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "WebView2 setup exited with $0.$\r$\nInstall it manually from ${WV2_PAGE} — ${APP_NAME} will not render without it."
  ${EndIf}
FunctionEnd

Section "Install"
  SetOutPath "$INSTDIR"

  Call EnsureWebView2

  File /oname=${APP_EXE} "${EXE}"
  WriteUninstaller "$INSTDIR\uninstall.exe"

  CreateDirectory "$SMPROGRAMS\Relay"
  CreateShortcut "$SMPROGRAMS\Relay\Relay.lnk" "$INSTDIR\${APP_EXE}"
  CreateShortcut "$DESKTOP\Relay.lnk" "$INSTDIR\${APP_EXE}"

  WriteRegStr   HKCU "${UNINST_REG}" "DisplayName"     "${APP_NAME}"
  WriteRegStr   HKCU "${UNINST_REG}" "DisplayVersion"  "${VERSION}"
  WriteRegStr   HKCU "${UNINST_REG}" "Publisher"       "Relay"
  WriteRegStr   HKCU "${UNINST_REG}" "DisplayIcon"     "$INSTDIR\${APP_EXE}"
  WriteRegStr   HKCU "${UNINST_REG}" "InstallLocation" "$INSTDIR"
  WriteRegStr   HKCU "${UNINST_REG}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegDWORD HKCU "${UNINST_REG}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_REG}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  Delete "$INSTDIR\${APP_EXE}"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\Relay\Relay.lnk"
  RMDir "$SMPROGRAMS\Relay"
  Delete "$DESKTOP\Relay.lnk"
  DeleteRegKey HKCU "${UNINST_REG}"
  ; Server config in %APPDATA%\relay is kept deliberately — survives reinstalls.
SectionEnd
