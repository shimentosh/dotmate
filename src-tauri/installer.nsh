; NSIS installer hooks.
;
; Windows resolves an executable's LOAD-TIME dependent DLLs from the exe's own
; folder. The on-device TTS engine (crates/tts) links sherpa-onnx / ONNX Runtime
; in `shared` mode, so the exe imports these DLLs at process start — if they are
; not NEXT TO the exe the installed app fails to launch.
;
; bundle.resources (tauri.windows.conf.json) puts the four DLLs into the installer
; payload. Depending on the Tauri version they may land directly in $INSTDIR (next
; to the exe — already correct) or under a resources\ subdir. This POSTINSTALL hook
; makes the layout deterministic: if they ended up in resources\, copy them up
; beside the exe. No-op when they are already in place.
;
; The paired POSTUNINSTALL hook removes the copies so an uninstall leaves nothing.

!macro NSIS_HOOK_POSTINSTALL
  ${If} ${FileExists} "$INSTDIR\resources\onnxruntime.dll"
    CopyFiles /SILENT "$INSTDIR\resources\*.dll" "$INSTDIR"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$INSTDIR\onnxruntime.dll"
  Delete "$INSTDIR\onnxruntime_providers_shared.dll"
  Delete "$INSTDIR\sherpa-onnx-c-api.dll"
  Delete "$INSTDIR\sherpa-onnx-cxx-api.dll"
!macroend
