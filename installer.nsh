; Custom NSIS macros for Vyral Tracker installer
; nsExec::ExecToLog is used (not ExecToStack) — ExecToStack pushes values onto the
; NSIS stack that must be explicitly popped, and forgetting to pop them corrupts the
; stack, causing customInit to silently fail and trigger the "cannot be closed" dialog
; even when the app is not running.

!macro customInit
  DetailPrint "Closing any running instances of vTrack..."
  ; Kill under every name the app has ever shipped as (current + legacy)
  nsExec::ExecToLog 'taskkill /F /IM "vTrack.exe" /T'
  nsExec::ExecToLog 'taskkill /F /IM "Vyral Tracker.exe" /T'
  nsExec::ExecToLog 'taskkill /F /IM "vOps Tracker.exe" /T'
  nsExec::ExecToLog 'taskkill /F /IM "vops-tracker.exe" /T'
  ; Wait for the process to fully exit before the installer continues.
  ; The app guarantees exit within 1.5 s (force-exit timeout in main.cjs).
  ; 2 s here gives comfortable headroom.
  Sleep 2000
  DetailPrint "Done. Proceeding with installation."
!macroend

!macro customUnInstall
  DetailPrint "Closing vTrack before uninstall..."
  nsExec::ExecToLog 'taskkill /F /IM "vTrack.exe" /T'
  nsExec::ExecToLog 'taskkill /F /IM "Vyral Tracker.exe" /T'
  nsExec::ExecToLog 'taskkill /F /IM "vOps Tracker.exe" /T'
  nsExec::ExecToLog 'taskkill /F /IM "vops-tracker.exe" /T'
  Sleep 1500
!macroend
