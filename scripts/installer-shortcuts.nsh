!macro jinkraUninstallWizard
  ${IfNot} ${Silent}
    IfFileExists "$INSTDIR\resources\xj-agent-uninstall-ui.exe" 0 jinkra_uninstall_native
    IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 jinkra_uninstall_native
    InitPluginsDir
    SetOutPath "$PLUGINSDIR"
    ClearErrors
    CopyFiles /SILENT "$INSTDIR\resources\xj-agent-uninstall-ui.exe" "$PLUGINSDIR"
    IfErrors jinkra_uninstall_native
    ExecWait '"$PLUGINSDIR\xj-agent-uninstall-ui.exe" --uninstall "$INSTDIR"' $R8
    IfErrors jinkra_uninstall_native
    SetErrorLevel $R8
    Quit
  jinkra_uninstall_native:
    SetOutPath "$INSTDIR"
  ${EndIf}
!macroend

!macro customInstall
  ; Only the desktop shortcut is called 小金工作台; everything else keeps the 小金同学 name.
  ${If} ${FileExists} "$DESKTOP\小金同学.lnk"
    Delete "$DESKTOP\小金工作台.lnk"
    Rename "$DESKTOP\小金同学.lnk" "$DESKTOP\小金工作台.lnk"
  ${EndIf}
  ${GetParameters} $R8
  ClearErrors
  ${GetOptions} $R8 "/JINKRA_QUICK_LAUNCH" $R9
  ${IfNot} ${Errors}
    ${IfNot} ${FileExists} "$QUICKLAUNCH\小金同学.lnk"
      CreateDirectory "$QUICKLAUNCH"
      ClearErrors
      CreateShortCut "$QUICKLAUNCH\小金同学.lnk" "$appExe" "" "$appExe" 0
      ${IfNot} ${Errors}
        WinShell::SetLnkAUMI "$QUICKLAUNCH\小金同学.lnk" "${APP_ID}"
        WriteRegStr HKCU "Software\Jinkra\Agent" "QuickLaunchTarget" "$appExe"
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

!macro customUnInstall
  ${IfNot} ${isKeepShortcuts}
    WinShell::UninstShortcut "$DESKTOP\小金工作台.lnk"
    Delete "$DESKTOP\小金工作台.lnk"
    ReadRegStr $R8 HKCU "Software\Jinkra\Agent" "QuickLaunchTarget"
    ${If} $R8 == "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      WinShell::UninstShortcut "$QUICKLAUNCH\小金同学.lnk"
      Delete "$QUICKLAUNCH\小金同学.lnk"
      DeleteRegValue HKCU "Software\Jinkra\Agent" "QuickLaunchTarget"
    ${EndIf}
    DeleteRegValue HKCU "Software\Jinkra\Agent" "InstallLocation"
    DeleteRegKey /ifempty HKCU "Software\Jinkra\Agent"
  ${EndIf}
!macroend
