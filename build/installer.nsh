!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "nsDialogs.nsh"

!macro customWelcomePage
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customPageAfterChangeDir
  Page custom Plan008DirectoryGuardPage Plan008DirectoryGuardPageLeave
!macroend

!macro customInit
  IfSilent plan008_silent_install plan008_interactive_install
plan008_silent_install:
  SetErrorLevel 1
  Quit
plan008_interactive_install:
!macroend

!macro customCheckAppRunning
  !ifdef BUILD_UNINSTALLER
    Call un.Plan008CheckAppRunning
  !else
    Call Plan008CheckAppRunning
  !endif
!macroend

!macro Plan008ProcessCheck _FUNCTION
Function ${_FUNCTION}
plan008_process_retry:
  nsExec::ExecToStack `"$SYSDIR\tasklist.exe" /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH`
  Pop $R0
  Pop $R1
  StrCmp $R0 "0" plan008_process_query_ok
  IfSilent plan008_process_query_silent_failure plan008_process_query_failure
plan008_process_query_silent_failure:
  SetErrorLevel 1
  Quit
plan008_process_query_failure:
  MessageBox MB_OK|MB_ICONSTOP "Не удалось проверить, запущено ли GigaChat Agents. Установка или удаление остановлены."
  SetErrorLevel 1
  Quit
plan008_process_query_ok:
  StrCpy $R2 $R1 1
  StrCmp $R2 '"' plan008_process_running plan008_process_clear
plan008_process_running:
  IfSilent plan008_process_silent_running plan008_process_prompt
plan008_process_silent_running:
  SetErrorLevel 1
  Quit
plan008_process_prompt:
  MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "GigaChat Agents ещё работает. Завершите его через пункт «Выход» в меню значка в трее, затем нажмите «Повторить». Установщик не закрывает приложение принудительно." IDRETRY plan008_process_retry
  SetErrorLevel 1
  Quit
plan008_process_clear:
FunctionEnd
!macroend

!macro Plan008RegistrationCheck _FUNCTION
Function ${_FUNCTION}
  StrCpy $Plan008Status "invalid"
  ${GetFileName} "$INSTDIR" $R0
  ${If} $R0 != "${APP_FILENAME}"
    Return
  ${EndIf}

  ${If} $installMode == "CurrentUser"
    ReadRegStr $R1 HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation"
    ReadRegStr $R2 HKCU "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
    StrCpy $R3 '"$INSTDIR\${UNINSTALL_FILENAME}" /currentuser'
    ${If} $R1 == "$INSTDIR"
    ${AndIf} $R2 == $R3
      ReadRegStr $R4 HKLM "${INSTALL_REGISTRY_KEY}" "InstallLocation"
      ReadRegStr $R5 HKLM "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
      ${If} $R4 == ""
      ${AndIf} $R5 == ""
        StrCpy $Plan008Status "owned"
      ${EndIf}
    ${EndIf}
  ${ElseIf} $installMode == "all"
    ReadRegStr $R1 HKLM "${INSTALL_REGISTRY_KEY}" "InstallLocation"
    ReadRegStr $R2 HKLM "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
    StrCpy $R3 '"$INSTDIR\${UNINSTALL_FILENAME}" /allusers'
    ${If} $R1 == "$INSTDIR"
    ${AndIf} $R2 == $R3
      ReadRegStr $R4 HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation"
      ReadRegStr $R5 HKCU "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
      ${If} $R4 == ""
      ${AndIf} $R5 == ""
        StrCpy $Plan008Status "owned"
      ${EndIf}
    ${EndIf}
  ${EndIf}
FunctionEnd
!macroend

!macro customHeader
Var Plan008Status

!ifdef BUILD_UNINSTALLER
  !insertmacro Plan008ProcessCheck un.Plan008CheckAppRunning
  !insertmacro Plan008RegistrationCheck un.Plan008CheckOwnRegistration
!else
  !insertmacro Plan008ProcessCheck Plan008CheckAppRunning
  !insertmacro Plan008RegistrationCheck Plan008CheckOwnRegistration

Function Plan008ValidateInstallDirectory
  StrCpy $Plan008Status "invalid"
  ${GetFileName} "$INSTDIR" $R0
  ${If} $R0 != "${APP_FILENAME}"
    Return
  ${EndIf}

  IfFileExists "$INSTDIR" plan008_directory_exists plan008_directory_new
plan008_directory_new:
  Call Plan008CheckOwnRegistration
  StrCmp $Plan008Status "owned" plan008_directory_new_safe
  Call Plan008CheckNoRegistration
  StrCmp $Plan008Status "none" plan008_directory_new_safe plan008_directory_invalid
plan008_directory_new_safe:
  StrCpy $Plan008Status "safe"
  Return

plan008_directory_exists:
  ClearErrors
  FindFirst $R1 $R2 "$INSTDIR\*"
  IfErrors plan008_directory_unreadable
plan008_directory_scan:
  StrCmp $R2 "." plan008_directory_scan_next
  StrCmp $R2 ".." plan008_directory_scan_next
  FindClose $R1
  Call Plan008CheckOwnRegistration
  StrCmp $Plan008Status "owned" 0 plan008_directory_invalid
  IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 plan008_directory_invalid
  IfFileExists "$INSTDIR\${UNINSTALL_FILENAME}" 0 plan008_directory_invalid
  StrCpy $Plan008Status "safe"
  Return

plan008_directory_scan_next:
  ClearErrors
  FindNext $R1 $R2
  IfErrors plan008_directory_empty
  Goto plan008_directory_scan

plan008_directory_empty:
  FindClose $R1
  Call Plan008CheckOwnRegistration
  StrCmp $Plan008Status "owned" plan008_directory_empty_safe
  Call Plan008CheckNoRegistration
  StrCmp $Plan008Status "none" plan008_directory_empty_safe plan008_directory_invalid
plan008_directory_empty_safe:
  StrCpy $Plan008Status "safe"
  Return

plan008_directory_unreadable:
  StrCpy $Plan008Status "invalid"
  Return

plan008_directory_invalid:
  StrCpy $Plan008Status "invalid"
FunctionEnd

Function Plan008DirectoryGuardPage
  Call Plan008CheckAppRunning
  Call Plan008NormalizeInstallDirectory
  Call Plan008ValidateInstallDirectory
  StrCmp $Plan008Status "safe" plan008_directory_guard_skip
  nsDialogs::Create 1018
  Pop $R0
  StrCmp $R0 "error" plan008_directory_guard_error
  ${NSD_CreateLabel} 0 0 100% 58u "Для безопасности выберите пустую папку с именем «${APP_FILENAME}». Существующую папку можно использовать только при подтверждённой установке GigaChat Agents в эту же папку. Нажмите «Назад», чтобы изменить путь."
  Pop $R0
  nsDialogs::Show
  Return
plan008_directory_guard_skip:
  Abort
plan008_directory_guard_error:
  MessageBox MB_OK|MB_ICONSTOP "Не удалось проверить папку установки. Установка остановлена."
  SetErrorLevel 1
  Quit
FunctionEnd

Function Plan008DirectoryGuardPageLeave
  Call Plan008CheckAppRunning
  Call Plan008NormalizeInstallDirectory
  Call Plan008ValidateInstallDirectory
  StrCmp $Plan008Status "safe" plan008_directory_guard_leave_ok
  MessageBox MB_OK|MB_ICONSTOP "Выбранную папку нельзя безопасно использовать. Нажмите «Назад» и выберите пустую папку с именем «${APP_FILENAME}»."
  Abort
plan008_directory_guard_leave_ok:
FunctionEnd

Function Plan008NormalizeInstallDirectory
  ${GetFileName} "$INSTDIR" $R3
  ${If} $R3 != "${APP_FILENAME}"
    StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
  ${EndIf}
FunctionEnd

Function Plan008CheckNoRegistration
  StrCpy $Plan008Status "registered"
  ReadRegStr $R1 HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  ReadRegStr $R2 HKCU "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
  ReadRegStr $R3 HKLM "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  ReadRegStr $R4 HKLM "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
  ${If} $R1 == ""
  ${AndIf} $R2 == ""
  ${AndIf} $R3 == ""
  ${AndIf} $R4 == ""
    StrCpy $Plan008Status "none"
  ${EndIf}
FunctionEnd
!endif
!macroend

!macro customUnInstall
  Call un.Plan008CheckOwnRegistration
  StrCmp $Plan008Status "owned" 0 plan008_uninstall_unsafe
  Goto plan008_uninstall_safe
plan008_uninstall_unsafe:
  IfSilent plan008_uninstall_silent_failure plan008_uninstall_failure
plan008_uninstall_silent_failure:
  SetErrorLevel 1
  Quit
plan008_uninstall_failure:
  MessageBox MB_OK|MB_ICONSTOP "Не удалось подтвердить, что эта папка принадлежит собственной установке GigaChat Agents. Файлы не удалены."
  SetErrorLevel 1
  Quit
plan008_uninstall_safe:
!macroend
