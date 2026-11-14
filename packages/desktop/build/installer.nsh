; Old clients invoke updates with --updated but without /S. Make that path
; silent too, while retaining the normal wizard for a manually opened installer.
!macro customInit
  ${If} ${isUpdated}
    SetSilent silent
  ${EndIf}
!macroend

; ShellExecute (including Explorer's address bar) resolves App Paths immediately.
; Keep this registration in the same user/machine scope as the installation;
; no PATH change or Explorer restart is necessary.
!define PAI_APP_PATHS_ROOT "Software\Microsoft\Windows\CurrentVersion\App Paths"
!define PAI_APP_PATH_KEY "${PAI_APP_PATHS_ROOT}\pai.exe"
; Marker meaning "this App Paths entry was written by us". Matches the retired
; AUMI scheme too so upgrades keep managing an entry created by <=0.4.1.
!define PAI_MANAGED_VALUE "app.pidesktop.desktop"
!define PAI_MANAGED_VALUE_LEGACY "dev.pidesktop.app"

; A missing InstallLocation in the uninstall key makes later silent updates
; (--updated /S, no /D) fall back to the default %LOCALAPPDATA%\Programs dir and
; strand a second copy beside the original custom directory. Write the real
; directory every install so upgrades always rediscover it.
!macro customInstall
  WriteRegStr SHCTX "${UNINSTALL_REGISTRY_KEY}" "InstallLocation" "$INSTDIR"
  !if "${PRODUCT_NAME}" == "Pi Desktop"
    Push $0
    Push $1
    Push $2
    ; ReadRegStr alone cannot distinguish a missing key from an existing key
    ; without a default value. Preserve either kind of foreign registration.
    ; EnumRegKey does NOT set the error flag when the index runs past the
    ; last subkey - it returns an empty name instead. Terminate on the empty
    ; name (a real subkey can never be named ""), keep the Errors check as a
    ; fallback, and cap iterations so a pathological hive can never hang the
    ; installer forever while it holds the single-instance mutex.
    StrCpy $0 0
    StrCpy $2 ""
    ${Do}
      ClearErrors
      EnumRegKey $1 SHCTX "${PAI_APP_PATHS_ROOT}" $0
      ${If} ${Errors}
      ${OrIf} $1 == ""
        ${ExitDo}
      ${EndIf}
      ${If} $1 == "pai.exe"
        StrCpy $2 "exists"
        ${ExitDo}
      ${EndIf}
      IntOp $0 $0 + 1
      ${If} $0 >= 1000
        ${ExitDo}
      ${EndIf}
    ${Loop}
    ReadRegStr $1 SHCTX "${PAI_APP_PATH_KEY}" "PiDesktopManaged"
    ${If} $2 != "exists"
    ${OrIf} $1 == "${PAI_MANAGED_VALUE_LEGACY}"
      WriteRegStr SHCTX "${PAI_APP_PATH_KEY}" "" "$INSTDIR\bin\pai.exe"
      WriteRegStr SHCTX "${PAI_APP_PATH_KEY}" "PiDesktopManaged" "${PAI_MANAGED_VALUE}"
    ${EndIf}
    Pop $2
    Pop $1
    Pop $0
  !endif
!macroend

!macro customUnInstall
  !if "${PRODUCT_NAME}" == "Pi Desktop"
    Push $0
    Push $1
    ReadRegStr $0 SHCTX "${PAI_APP_PATH_KEY}" "PiDesktopManaged"
    ReadRegStr $1 SHCTX "${PAI_APP_PATH_KEY}" ""
    ; Another install may have taken ownership since this copy was installed.
    ${If} $0 == "${PAI_MANAGED_VALUE}"
    ${OrIf} $0 == "${PAI_MANAGED_VALUE_LEGACY}"
    ${AndIf} $1 == "$INSTDIR\bin\pai.exe"
      DeleteRegKey SHCTX "${PAI_APP_PATH_KEY}"
    ${EndIf}
    Pop $1
    Pop $0
  !endif
!macroend

; Directory-page writability gate. A per-user ("install for me") run needs no
; elevation, so pointing it at a system folder like C:\Program Files produces a
; ghost install: HKCU registry keys succeed without admin while every file
; write is denied — the wizard only surfaces this as raw "error opening file
; for writing" dialogs mid-install. Probe the chosen directory up front instead;
; an unwritable directory disables Next (the .onVerifyInstDir contract), which
; steers the user back to the install-mode page ("install for all users", which
; elevates and defaults to Program Files) or to a user-writable path.
Function .onVerifyInstDir
  ; Plain NSIS instructions only: this top-level function body compiles at the
  ; point where electron-builder includes this file, before LogicLib (${If}) is
  ; available — macro-based conditionals here break the makensis build.
  ClearErrors
  FileOpen $0 "$INSTDIR\~pi-desktop-write-test.tmp" w
  IfErrors 0 +2
  Abort
  FileClose $0
  Delete "$INSTDIR\~pi-desktop-write-test.tmp"
FunctionEnd
