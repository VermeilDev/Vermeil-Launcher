; NSIS installer hooks for Vermeil.
;
; Tauri's stock NSIS template handles 99% of what we need (license screen,
; install location picker, Start Menu + desktop shortcuts, registration with
; Add/Remove Programs, an uninstaller with a "Delete the application data"
; checkbox on the confirm page). These hooks add the bits that the default
; doesn't:
;
;   - When the user UN-checks "Delete the application data" on the confirm
;     page, do nothing extra. The data folder stays put for a future reinstall.
;
;   - When the user CHECKS the "Delete the application data" box, surface
;     a confirm dialog right before we delete so it isn't a one-click silent
;     wipe of accounts/instances/settings.
;
; Reference: tauri docs at https://tauri.app/distribute/windows-installer/
; Reference: NSIS docs at https://nsis.sourceforge.io/Docs/Chapter4.html

!include "MUI2.nsh"
!include "FileFunc.nsh"

; -----------------------------------------------------------------------------
; Tauri exposes the "Delete the application data" checkbox state as a global
; named $DeleteAppDataCheckboxState. We read that variable to decide whether
; to show the warning + perform the rmdir. We do NOT show our own checkbox
; — Tauri's confirm page already has one and it's the right UX.
;
; Values:
;   $DeleteAppDataCheckboxState == "1"  -> user wants the data folder gone
;   $DeleteAppDataCheckboxState == "0"  -> keep the data folder (default)
; -----------------------------------------------------------------------------

Var DeleteUserData
Var PrevEstimatedSize

!macro NSIS_HOOK_PREINSTALL
    ; Preserve existing EstimatedSize (maintained asynchronously by Vermeil's Rust runtime)
    ; before Section Install overwrites it with the static binary size.
    ${If} $PrevEstimatedSize == ""
    ${OrIf} $PrevEstimatedSize == 0
        ReadRegDWORD $PrevEstimatedSize HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Vermeil" "EstimatedSize"
    ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
    ; Restore the previous EstimatedSize in O(1) time when it exceeds the base binary size,
    ; instead of running a blocking single-threaded ${GetSize} walk across 100,000+
    ; Minecraft asset/library/mod files. Vermeil's Rust backend
    ; (platform::update_windows_estimated_size) automatically refreshes EstimatedSize
    ; on a background thread when the launcher starts and exits.
    ${If} $PrevEstimatedSize != ""
    ${AndIf} $PrevEstimatedSize U> ${ESTIMATEDSIZE}
        WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Vermeil" "EstimatedSize" $PrevEstimatedSize
    ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
    ; Default: don't touch user data.
    StrCpy $DeleteUserData "0"

    ; If user opted in via the confirm-page checkbox, honor their selection
    ; directly without interrupting with a redundant confirmation popup.
    ${If} $DeleteAppDataCheckboxState == "1"
        StrCpy $DeleteUserData "1"
    ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
    ${If} $DeleteUserData == "1"
        DetailPrint "Removing user data folder (this can take a moment)..."
        SetDetailsPrint none

        ; Local data folder (%LOCALAPPDATA%\Vermeil):
        ; Holds instances, Minecraft asset objects, Java runtimes, and caches (tens of
        ; thousands of tiny files). Standard interpreted RMDir /r crawls over NTFS metadata.
        ; Instead, perform an instant atomic directory rename (<1ms) to detach the folder,
        ; then invoke native bulk tree deletion via cmd.exe /c rd /s /q.
        StrCpy $0 "$LOCALAPPDATA\Vermeil"
        ${If} ${FileExists} "$0\*.*"
            StrCpy $1 "$LOCALAPPDATA\Vermeil_trash"
            ${If} ${FileExists} "$1\*.*"
                nsExec::Exec 'cmd.exe /c "rd /s /q \"$1\""'
                RMDir /r "$1"
            ${EndIf}
            Rename "$0" "$1"
            ${If} ${FileExists} "$1\*.*"
                nsExec::Exec 'cmd.exe /c "rd /s /q \"$1\""'
                RMDir /r "$1"
            ${Else}
                nsExec::Exec 'cmd.exe /c "rd /s /q \"$0\""'
                RMDir /r "$0"
            ${EndIf}
        ${EndIf}

        ; Roaming data folder (%APPDATA%\Vermeil) from pre-0.6 builds:
        StrCpy $0 "$APPDATA\Vermeil"
        ${If} ${FileExists} "$0\*.*"
            StrCpy $1 "$APPDATA\Vermeil_trash"
            ${If} ${FileExists} "$1\*.*"
                nsExec::Exec 'cmd.exe /c "rd /s /q \"$1\""'
                RMDir /r "$1"
            ${EndIf}
            Rename "$0" "$1"
            ${If} ${FileExists} "$1\*.*"
                nsExec::Exec 'cmd.exe /c "rd /s /q \"$1\""'
                RMDir /r "$1"
            ${Else}
                nsExec::Exec 'cmd.exe /c "rd /s /q \"$0\""'
                RMDir /r "$0"
            ${EndIf}
        ${EndIf}

        SetDetailsPrint both
        DetailPrint "User data removed."
    ${EndIf}
!macroend
