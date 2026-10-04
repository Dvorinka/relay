; Relay desktop installer — NSIS 3.x, per-user install (no admin required).
;
;   makensis -DVERSION=1.2.3 -DVI_VERSION=1.2.3.0 \
;     -DEXE=build\bin\relay-desktop.exe -DCLI_EXE=dist\relay-cli-windows-amd64.exe \
;     -DOUTFILE=dist\Relay-Setup-1.2.3.exe apps\desktop\installer\relay.nsi
;
; CLI_EXE is optional: when defined, the components page offers "Relay CLI"
; (checked by default) which installs relay-cli.exe next to the app and adds
; the install dir to the user PATH.

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
!include "StrFunc.nsh"

${StrLoc}
${UnStrLoc}

!define MUI_ICON   "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Launch Relay"

!insertmacro MUI_PAGE_WELCOME
!ifdef CLI_EXE
  !insertmacro MUI_PAGE_COMPONENTS
!endif
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

; Refuse to fight a running instance during an upgrade. taskkill returns
; once the kill is issued, not once the process exits — give teardown a
; moment or Delete hits a still-locked executable.
Function .onInit
  nsExec::ExecToLog 'taskkill /F /IM ${APP_EXE} /T'
  Sleep 800
FunctionEnd

Function un.onInit
  nsExec::ExecToLog 'taskkill /F /IM ${APP_EXE} /T'
  Sleep 800
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

!ifdef CLI_EXE
; Checked by default: one setup covers the desktop app and the terminal
; client. Uncheck to skip; the app runs fine without it.
Section "Relay CLI (relay-cli.exe)" SecCLI
  SetOutPath "$INSTDIR"
  File /oname=relay-cli.exe "${CLI_EXE}"

  ; Put $INSTDIR on the user PATH (skip if already listed). Wrapping the
  ; current value as ";…;" makes the match boundary-exact, so a longer
  ; sibling like "…\Relay2" can't suppress it. REG_EXPAND_SZ keeps any
  ; %VARS% already in Path intact; the broadcast refreshes new consoles
  ; without a sign-out.
  ReadRegStr $0 HKCU "Environment" "Path"
  StrCpy $1 ";$0;"
  ${StrLoc} $2 $1 ";$INSTDIR;" ">"
  ${If} $2 == ""
    ${If} $0 != ""
      StrCpy $0 "$0;$INSTDIR"
    ${Else}
      StrCpy $0 "$INSTDIR"
    ${EndIf}
    WriteRegExpandStr HKCU "Environment" "Path" "$0"
    SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
    DetailPrint "Added $INSTDIR to the user PATH."
  ${EndIf}
SectionEnd
!endif

Section "Uninstall"
  Delete "$INSTDIR\${APP_EXE}"
  Delete "$INSTDIR\relay-cli.exe"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\Relay\Relay.lnk"
  RMDir "$SMPROGRAMS\Relay"
  Delete "$DESKTOP\Relay.lnk"
  DeleteRegKey HKCU "${UNINST_REG}"

  ; Drop $INSTDIR from the user PATH if present. The wrapped ";…;" form
  ; makes first/last/only entries all match the same ";dir;" pattern.
  ReadRegStr $0 HKCU "Environment" "Path"
  StrCpy $1 ";$0;"
  ${UnStrLoc} $2 $1 ";$INSTDIR;" ">"
  ${If} $2 != ""
    StrLen $3 "$INSTDIR"
    IntOp $4 $2 + $3
    IntOp $4 $4 + 1              ; skip ";$INSTDIR", keep the trailing ';'
    StrCpy $5 $1 $2              ; head, incl. synthetic leading ';'
    StrCpy $6 $1 "" $4           ; tail, starting at the ';' after the dir
    StrCpy $0 "$5$6"             ; ";…head…;…tail…;"
    StrCpy $0 $0 -1 1            ; unwrap the synthetic ';'s
    ${If} $0 == ""
      DeleteRegValue HKCU "Environment" "Path"
    ${Else}
      WriteRegExpandStr HKCU "Environment" "Path" "$0"
    ${EndIf}
    SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
  ${EndIf}
  ; Server config in %APPDATA%\relay is kept deliberately — survives reinstalls.
SectionEnd
