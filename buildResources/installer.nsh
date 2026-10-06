; Native Client setup.
;
; One window without the wizard chrome: the launcher's login artwork on the left,
; plain controls on the right. Three screens: install, progress, finish.
; Update mode (`--updated`) skips straight to progress and reopens the launcher.
; Silent updates (`/S`) show nothing.

!macro customHeader
  ManifestDPIAware true
!macroend

; Only ever per-user (no UAC prompt), unless an older per-machine install exists.
!macro customInstallMode
  ${if} $hasPerMachineInstallation == "1"
  ${andIf} $hasPerUserInstallation == "0"
    StrCpy $isForceMachineInstall "1"
  ${else}
    StrCpy $isForceCurrentInstall "1"
  ${endIf}
!macroend

!macro customInit
  InitPluginsDir
  File "/oname=$PLUGINSDIR\nc-art-100.bmp" "${BUILD_RESOURCES_DIR}\installer\art-100.bmp"
  File "/oname=$PLUGINSDIR\nc-art-150.bmp" "${BUILD_RESOURCES_DIR}\installer\art-150.bmp"
  File "/oname=$PLUGINSDIR\nc-art-200.bmp" "${BUILD_RESOURCES_DIR}\installer\art-200.bmp"
  StrCpy $ncDesktop "1"
  StrCpy $ncOpen "1"
!macroend

!macro customInstall
  ${ifNot} ${isUpdated}
    ${if} $ncDesktop == "0"
      Delete "$newDesktopLink"
    ${endIf}
  ${endIf}
  SetAutoClose true
  ; "Restart now" runs the installer with --updated --force-run (not silent). The stock script only reopens
  ; the app after a *silent* forced run and our update mode skips the finish page, so reopen it here.
  ${if} ${isUpdated}
  ${andIf} ${isForceRun}
  ${andIfNot} ${Silent}
    HideWindow
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "--updated"
  ${endIf}
!macroend

!macro customPageAfterChangeDir
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW ncInstShow
  !define MUI_INSTFILESPAGE_PROGRESSBAR smooth
!macroend

!macro customFinishPage
  Page custom ncFinishShow
!macroend

; ---------------------------------------------------------------------------
; Helpers (expanded inside the installer-only functions below)
; ---------------------------------------------------------------------------
!macro ncPx OUT V
  IntOp ${OUT} ${V} * $ncDpi
  IntOp ${OUT} ${OUT} / 96
!macroend

; Round a control's corners (96-dpi px).
!macro ncRound HWND W H R
  Push $R0
  Push $R7
  Push $R8
  Push $R9
  !insertmacro ncPx $R7 ${W}
  !insertmacro ncPx $R8 ${H}
  !insertmacro ncPx $R9 ${R}
  IntOp $R7 $R7 + 1
  IntOp $R8 $R8 + 1
  System::Call 'gdi32::CreateRoundRectRgn(i 0, i 0, i R7, i R8, i R9, i R9) p .R0'
  System::Call 'user32::SetWindowRgn(p ${HWND}, p R0, i 1)'
  Pop $R9
  Pop $R8
  Pop $R7
  Pop $R0
!macroend

; A label. Leaves the control in $ncTmp.
!macro ncText X Y W H TEXT FONT FG BG
  !insertmacro ncPx $R1 ${X}
  !insertmacro ncPx $R2 ${Y}
  !insertmacro ncPx $R3 ${W}
  !insertmacro ncPx $R4 ${H}
  ${NSD_CreateLabel} $R1 $R2 $R3 $R4 "${TEXT}"
  Pop $ncTmp
  SendMessage $ncTmp ${WM_SETFONT} ${FONT} 1
  SetCtlColors $ncTmp ${FG} ${BG}
!macroend

; A flat filled rectangle (also used as 1 px borders).
!macro ncRect X Y W H COLOR
  !insertmacro ncText ${X} ${Y} ${W} ${H} "" $ncFontSmall ${COLOR} ${COLOR}
  ; no SS_NOTIFY: clicks fall through to the control on top
  System::Call 'user32::GetWindowLongW(p $ncTmp, i -16) i .R5'
  IntOp $R5 $R5 & 0xFFFFFEFF
  System::Call 'user32::SetWindowLongW(p $ncTmp, i -16, i R5)'
!macroend

; Button: 1 px border + fill + centred text, 4 px corners. Click -> CALLBACK.
!macro ncButton X Y W H TEXT FG BG BORDER CALLBACK
  !define /math _ncbx ${X} + 1
  !define /math _ncby ${Y} + 1
  !define /math _ncbw ${W} - 2
  !define /math _ncbh ${H} - 2
  !insertmacro ncRect ${X} ${Y} ${W} ${H} ${BORDER}
  !insertmacro ncRound $ncTmp ${W} ${H} 8
  !insertmacro ncText ${_ncbx} ${_ncby} ${_ncbw} ${_ncbh} "${TEXT}" $ncFontButton ${FG} ${BG}
  ${NSD_AddStyle} $ncTmp 0x201 ; SS_CENTER | SS_CENTERIMAGE
  !insertmacro ncRound $ncTmp ${_ncbw} ${_ncbh} 7
  ${NSD_OnClick} $ncTmp ${CALLBACK}
  !undef _ncbx
  !undef _ncby
  !undef _ncbw
  !undef _ncbh
!macroend

!macro ncArt
  !insertmacro ncPx $R3 ${NC_ART}
  !insertmacro ncPx $R4 ${NC_H}
  ${NSD_CreateBitmap} 0 0 $R3 $R4 ""
  Pop $ncTmp
  SendMessage $ncTmp 0x172 0 $ncArt ; STM_SETIMAGE
!macroend

!macro ncStatic TEXT STYLE X Y W H
  StrCpy $R1 "${TEXT}"
  StrCpy $R2 ${STYLE}
  StrCpy $R3 ${X}
  StrCpy $R4 ${Y}
  StrCpy $R5 ${W}
  StrCpy $R6 ${H}
  Call ncMakeStatic
!macroend

!macro ncCheck X Y TEXT OUTVAR CALLBACK
  !define /math _nccx ${X} + 1
  !define /math _nccy ${Y} + 1
  !define /math _nctx ${X} + 24
  !define /math _ncty ${Y} - 2
  !insertmacro ncRect ${X} ${Y} 16 16 0x3A3A42
  !insertmacro ncRound $ncTmp 16 16 5
  !insertmacro ncText ${_nccx} ${_nccy} 14 14 "" $ncFontGlyph ${NC_FG} ${NC_FIELD}
  ${NSD_AddStyle} $ncTmp 0x201
  !insertmacro ncRound $ncTmp 14 14 4
  StrCpy ${OUTVAR} $ncTmp
  ${NSD_OnClick} $ncTmp ${CALLBACK}
  !insertmacro ncText ${_nctx} ${_ncty} 300 20 "${TEXT}" $ncFontBody ${NC_FG} ${NC_BG}
  ${NSD_OnClick} $ncTmp ${CALLBACK}
  !undef _nccx
  !undef _nccy
  !undef _nctx
  !undef _ncty
!macroend

; ---------------------------------------------------------------------------
; Inserted where the first page is declared, so it only exists in the installer.
; ---------------------------------------------------------------------------
!macro customWelcomePage
  !define MUI_CUSTOMFUNCTION_GUIINIT ncGuiInit

  !define NC_BG 0x0B0B0D
  !define NC_FG 0xF2F2F3
  !define NC_DIM 0x9A9AA2
  !define NC_LINE 0x232328
  !define NC_FIELD 0x131316
  !define NC_CHIP 0x1E1E23
  ; 96-dpi layout: 720 x 420 client, 300 px artwork, content column 332..688
  !define NC_W 720
  !define NC_H 420
  !define NC_ART 300
  !define NC_X 332
  !define NC_CW 356

  Var ncDpi
  Var ncArt
  Var ncTmp
  Var ncDesktop
  Var ncDesktopBox
  Var ncOpen
  Var ncOpenBox
  Var ncPathLabel
  Var ncFontTitle
  Var ncFontBody
  Var ncFontSmall
  Var ncFontButton
  Var ncFontGlyph

  Function ncHideButtons
    ${ForEach} $0 1 3 + 1
      GetDlgItem $1 $HWNDPARENT $0
      ShowWindow $1 ${SW_HIDE}
    ${Next}
  FunctionEnd

  Function ncGuiInit
    System::Call 'user32::GetDC(p 0) p .r1'
    System::Call 'gdi32::GetDeviceCaps(p r1, i 88) i .r0'
    System::Call 'user32::ReleaseDC(p 0, p r1)'
    ${if} $0 < 96
      StrCpy $0 96
    ${endIf}
    StrCpy $ncDpi $0
    ${if} $ncDpi >= 168
      StrCpy $1 "200"
    ${elseif} $ncDpi >= 132
      StrCpy $1 "150"
    ${else}
      StrCpy $1 "100"
    ${endIf}
    System::Call 'user32::LoadImageW(p 0, w "$PLUGINSDIR\nc-art-$1.bmp", i 0, i 0, i 0, i 0x10) p .r0'
    StrCpy $ncArt $0

    CreateFont $ncFontTitle "Segoe UI Semibold" 16 600
    CreateFont $ncFontBody "Segoe UI" 9 400
    CreateFont $ncFontSmall "Segoe UI" 9 400
    CreateFont $ncFontButton "Segoe UI" 9 600
    CreateFont $ncFontGlyph "Segoe UI Symbol" 8 700

    ${ForEach} $0 1028 1039 + 1
      GetDlgItem $1 $HWNDPARENT $0
      ShowWindow $1 ${SW_HIDE}
    ${Next}
    GetDlgItem $1 $HWNDPARENT 1256
    ShowWindow $1 ${SW_HIDE}
    Call ncHideButtons

    ; client area 720x420 (scaled), centred
    System::Call '*(i, i, i, i) p .r5'
    System::Call 'user32::GetWindowRect(p $HWNDPARENT, p r5)'
    System::Call '*$5(i .r1, i .r2, i .r3, i .r4)'
    IntOp $6 $3 - $1
    IntOp $7 $4 - $2
    System::Call 'user32::GetClientRect(p $HWNDPARENT, p r5)'
    System::Call '*$5(i, i, i .r3, i .r4)'
    System::Free $5
    IntOp $6 $6 - $3
    IntOp $7 $7 - $4
    !insertmacro ncPx $3 ${NC_W}
    !insertmacro ncPx $4 ${NC_H}
    IntOp $8 $3 + $6
    IntOp $9 $4 + $7
    System::Call 'user32::GetSystemMetrics(i 0) i .r1'
    System::Call 'user32::GetSystemMetrics(i 1) i .r2'
    IntOp $1 $1 - $8
    IntOp $1 $1 / 2
    IntOp $2 $2 - $9
    IntOp $2 $2 / 2
    System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i r1, i r2, i r8, i r9, i 0x14)'
    GetDlgItem $1 $HWNDPARENT 1018
    System::Call 'user32::SetWindowPos(p r1, p 0, i 0, i 0, i r3, i r4, i 0x14)'

    ; dark title bar matching the page (Windows 10 1809+ / 11)
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 20, *i 1, i 4)'
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 19, *i 1, i 4)'
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 35, *i 0x000D0B0B, i 4)'
    SendMessage $HWNDPARENT ${WM_SETTEXT} 0 "STR:${PRODUCT_NAME} Setup"
  FunctionEnd

  ; checkbox: border square + inner square, checked = filled with a tick
  Function ncPaintCheck ; $0 = inner box, $1 = state
    ${if} $1 == "1"
      ${NSD_SetText} $0 "✓"
      SetCtlColors $0 0x000000 ${NC_FG}
    ${else}
      ${NSD_SetText} $0 ""
      SetCtlColors $0 ${NC_FG} ${NC_FIELD}
    ${endIf}
    System::Call 'user32::InvalidateRect(p r0, p 0, i 1)'
  FunctionEnd


  Function ncPageBase
    Pop $0
    SetCtlColors $0 ${NC_FG} ${NC_BG}
    Call ncHideButtons
    !insertmacro ncArt
    !insertmacro ncRect ${NC_ART} 0 1 ${NC_H} ${NC_LINE}
    !insertmacro ncRect ${NC_ART} 356 420 1 ${NC_LINE}
  FunctionEnd

  ; --- install -----------------------------------------------------------------
  Function ncWelcomeShow
    ${if} ${isUpdated}
      Abort
    ${endIf}
    nsDialogs::Create 1018
    Pop $0
    ${if} $0 == error
      Abort
    ${endIf}
    Push $0
    Call ncPageBase

    StrCpy $2 "0"
    ${if} $hasPerUserInstallation == "1"
    ${orIf} $hasPerMachineInstallation == "1"
      StrCpy $2 "1"
    ${endIf}

    ${if} $2 == "1"
      !insertmacro ncText ${NC_X} 40 ${NC_CW} 32 "Update Native Client" $ncFontTitle ${NC_FG} ${NC_BG}
      !insertmacro ncText ${NC_X} 76 ${NC_CW} 40 "Version ${VERSION}. Your instances, accounts and settings stay as they are." $ncFontBody ${NC_DIM} ${NC_BG}
    ${else}
      !insertmacro ncText ${NC_X} 40 ${NC_CW} 32 "Install Native Client" $ncFontTitle ${NC_FG} ${NC_BG}
      !insertmacro ncText ${NC_X} 76 ${NC_CW} 40 "Version ${VERSION}. Installs for your Windows user, no admin rights needed." $ncFontBody ${NC_DIM} ${NC_BG}
    ${endIf}

    !insertmacro ncText ${NC_X} 138 ${NC_CW} 18 "Install folder" $ncFontSmall ${NC_DIM} ${NC_BG}
    !insertmacro ncRect ${NC_X} 160 ${NC_CW} 34 ${NC_LINE}
    !insertmacro ncRound $ncTmp ${NC_CW} 34 8
    !insertmacro ncRect 333 161 354 32 ${NC_FIELD}
    !insertmacro ncRound $ncTmp 354 32 7
    ${if} $2 == "1"
      !insertmacro ncText 344 168 332 18 "$INSTDIR" $ncFontSmall ${NC_FG} ${NC_FIELD}
    ${else}
      !insertmacro ncText 344 168 252 18 "$INSTDIR" $ncFontSmall ${NC_FG} ${NC_FIELD}
    ${endIf}
    ${NSD_AddStyle} $ncTmp 0x8000 ; SS_PATHELLIPSIS
    StrCpy $ncPathLabel $ncTmp
    ${if} $2 == "0"
      !insertmacro ncText 608 165 74 24 "Browse" $ncFontButton ${NC_FG} ${NC_CHIP}
      ${NSD_AddStyle} $ncTmp 0x201
      !insertmacro ncRound $ncTmp 74 24 6
      ${NSD_OnClick} $ncTmp ncChangeDir

      !insertmacro ncCheck ${NC_X} 216 "Create a desktop shortcut" $ncDesktopBox ncToggleDesktop
      StrCpy $0 $ncDesktopBox
      StrCpy $1 $ncDesktop
      Call ncPaintCheck
    ${endIf}

    !insertmacro ncButton 504 374 88 32 "Cancel" ${NC_FG} ${NC_BG} 0x3A3A42 ncCancel
    ${if} $2 == "1"
      !insertmacro ncButton 600 374 88 32 "Update" 0x000000 ${NC_FG} ${NC_FG} ncNext
    ${else}
      !insertmacro ncButton 600 374 88 32 "Install" 0x000000 ${NC_FG} ${NC_FG} ncNext
    ${endIf}
    nsDialogs::Show
  FunctionEnd

  Function ncWelcomeLeave
  FunctionEnd

  Function ncNext
    Pop $0
    SendMessage $HWNDPARENT ${WM_COMMAND} 1 0
  FunctionEnd

  Function ncCancel
    Pop $0
    SendMessage $HWNDPARENT ${WM_COMMAND} 2 0
  FunctionEnd

  Function ncToggleDesktop
    Pop $0
    ${if} $ncDesktop == "1"
      StrCpy $ncDesktop "0"
    ${else}
      StrCpy $ncDesktop "1"
    ${endIf}
    StrCpy $0 $ncDesktopBox
    StrCpy $1 $ncDesktop
    Call ncPaintCheck
  FunctionEnd

  Function ncChangeDir
    Pop $0
    nsDialogs::SelectFolderDialog "Choose where to install ${PRODUCT_NAME}" "$INSTDIR"
    Pop $0
    ${if} $0 == error
    ${orIf} $0 == ""
      Return
    ${endIf}
    ${GetFileName} $0 $1
    ${if} $1 == "${APP_FILENAME}"
      StrCpy $INSTDIR $0
    ${else}
      StrCpy $INSTDIR "$0\${APP_FILENAME}"
    ${endIf}
    ${NSD_SetText} $ncPathLabel $INSTDIR
  FunctionEnd

  ; --- progress (install and update mode) ----------------------------------------
  ; CreateWindowEx a STATIC on the stock page ($9). $R1 text, $R2 style, $R3..$R6 x y w h.
  Function ncMakeStatic
    !insertmacro ncPx $R3 $R3
    !insertmacro ncPx $R4 $R4
    !insertmacro ncPx $R5 $R5
    !insertmacro ncPx $R6 $R6
    IntOp $R2 $R2 | 0x50000000 ; WS_CHILD | WS_VISIBLE
    System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w R1, i R2, i R3, i R4, i R5, i R6, p r9, p 0, p 0, p 0) p .r0'
  FunctionEnd

  Function ncInstShow
    Call ncHideButtons
    FindWindow $9 "#32770" "" $HWNDPARENT
    !insertmacro ncPx $R3 ${NC_W}
    !insertmacro ncPx $R4 ${NC_H}
    System::Call 'user32::SetWindowPos(p r9, p 0, i 0, i 0, i R3, i R4, i 0x14)'

    !insertmacro ncStatic "" 0xE 0 0 ${NC_ART} ${NC_H}
    SendMessage $0 0x172 0 $ncArt
    !insertmacro ncStatic "" 0 ${NC_ART} 0 1 ${NC_H}
    SetCtlColors $0 ${NC_LINE} ${NC_LINE}
    !insertmacro ncStatic "" 0x04000000 301 0 419 ${NC_H}
    SetCtlColors $0 ${NC_FG} ${NC_BG}
    System::Call 'user32::SetWindowPos(p r0, p 1, i 0, i 0, i 0, i 0, i 0x13)' ; to the back

    ${if} ${isUpdated}
      StrCpy $2 "Updating Native Client"
      StrCpy $3 "Version ${VERSION}. Native Client reopens when it's done."
    ${else}
      StrCpy $2 "Installing Native Client"
      StrCpy $3 "Version ${VERSION}"
    ${endIf}
    !insertmacro ncStatic $2 0 ${NC_X} 40 ${NC_CW} 32
    SendMessage $0 ${WM_SETFONT} $ncFontTitle 1
    SetCtlColors $0 ${NC_FG} ${NC_BG}
    !insertmacro ncStatic $3 0 ${NC_X} 76 ${NC_CW} 20
    SendMessage $0 ${WM_SETFONT} $ncFontBody 1
    SetCtlColors $0 ${NC_DIM} ${NC_BG}

    ; flat 4 px bar
    GetDlgItem $1 $9 1004
    System::Call 'uxtheme::SetWindowTheme(p r1, w " ", w " ")'
    System::Call 'user32::GetWindowLongW(p r1, i -16) i .r2'
    IntOp $2 $2 & 0xFF7FFFFF
    System::Call 'user32::SetWindowLongW(p r1, i -16, i r2)'
    System::Call 'user32::SetWindowLongW(p r1, i -20, i 0)'
    SendMessage $1 0x409 0 0x00F3F2F2 ; PBM_SETBARCOLOR (BGR)
    SendMessage $1 0x2001 0 0x00282323 ; PBM_SETBKCOLOR (BGR)
    !insertmacro ncPx $R1 ${NC_X}
    !insertmacro ncPx $R2 124
    !insertmacro ncPx $R3 ${NC_CW}
    !insertmacro ncPx $R4 4
    System::Call 'user32::SetWindowPos(p r1, p 0, i R1, i R2, i R3, i R4, i 0x24)'
    !insertmacro ncRound $1 ${NC_CW} 4 4

    ; current step, small and quiet
    GetDlgItem $1 $9 1006
    SendMessage $1 ${WM_SETFONT} $ncFontSmall 1
    SetCtlColors $1 ${NC_DIM} ${NC_BG}
    !insertmacro ncPx $R1 ${NC_X}
    !insertmacro ncPx $R2 138
    !insertmacro ncPx $R3 ${NC_CW}
    !insertmacro ncPx $R4 18
    System::Call 'user32::SetWindowPos(p r1, p 0, i R1, i R2, i R3, i R4, i 0x14)'

    GetDlgItem $1 $9 1016
    ShowWindow $1 ${SW_HIDE}
    GetDlgItem $1 $9 1027
    ShowWindow $1 ${SW_HIDE}
  FunctionEnd

  ; --- finish ----------------------------------------------------------------------
  Function ncFinishShow
    ${if} ${isUpdated}
      Abort
    ${endIf}
    nsDialogs::Create 1018
    Pop $0
    ${if} $0 == error
      Abort
    ${endIf}
    Push $0
    Call ncPageBase

    !insertmacro ncText ${NC_X} 40 ${NC_CW} 32 "Native Client is installed" $ncFontTitle ${NC_FG} ${NC_BG}
    !insertmacro ncText ${NC_X} 76 ${NC_CW} 40 "Version ${VERSION}. You can also open it from the Start menu." $ncFontBody ${NC_DIM} ${NC_BG}
    !insertmacro ncCheck ${NC_X} 138 "Open Native Client now" $ncOpenBox ncToggleOpen
    StrCpy $0 $ncOpenBox
    StrCpy $1 $ncOpen
    Call ncPaintCheck

    !insertmacro ncButton 600 374 88 32 "Finish" 0x000000 ${NC_FG} ${NC_FG} ncFinish
    nsDialogs::Show
  FunctionEnd

  Function ncToggleOpen
    Pop $0
    ${if} $ncOpen == "1"
      StrCpy $ncOpen "0"
    ${else}
      StrCpy $ncOpen "1"
    ${endIf}
    StrCpy $0 $ncOpenBox
    StrCpy $1 $ncOpen
    Call ncPaintCheck
  FunctionEnd

  Function ncFinish
    Pop $0
    ${if} $ncOpen == "1"
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" ""
    ${endIf}
    SendMessage $HWNDPARENT ${WM_COMMAND} 1 0
  FunctionEnd

  Page custom ncWelcomeShow ncWelcomeLeave
!macroend
