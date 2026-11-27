; Ganchos del instalador NSIS (F6.2). El daemon corre desacoplado de la app y usa el Node del paquete: si sigue vivo, Windows
; no deja borrar ni reemplazar node.exe. Se detiene con la CLI empaquetada antes de instalar, actualizar o desinstalar.
; Solo se detiene el proceso; el directorio de estado (%LOCALAPPDATA%\Nexo) NO se toca nunca.

!macro NexoStopDaemon
  ${If} ${FileExists} "$INSTDIR\nexo\node\node.exe"
    nsExec::Exec '"$INSTDIR\nexo\node\node.exe" "$INSTDIR\nexo\cli\nexo.mjs" daemon stop'
    Pop $0
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro NexoStopDaemon
!macroend

!macro NSIS_HOOK_POSTINSTALL
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro NexoStopDaemon
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
!macroend
