/** Textos de la interfaz en español; punto único para traducir después. */
export const es = {
  appName: 'Nexo Workspace',
  status: {
    connecting: 'Conectando con el daemon…',
    reconnecting: 'Conexión perdida. Reconectando…',
    offline: 'Sin conexión con el daemon',
    retry: 'Reintentar',
    noInfo: {
      title: 'No hay daemon al que conectarse',
      missingToken:
        'Falta el token en la dirección. Abre la página con ?port=<puerto>&t=<token> o arranca todo con «pnpm dev:web».',
      invalidPort: 'El puerto de la dirección no es válido.',
      invalidToken: 'El token de la dirección no tiene un formato válido.',
      tauri: 'La aplicación de escritorio no pudo entregar los datos del daemon.',
    },
    unreachable:
      'No se pudo abrir la conexión. Comprueba que el daemon esté en marcha y que el puerto y el token sean correctos.',
    closed: 'La conexión se cerró y no se pudo restablecer.',
    restarted:
      'El daemon se reinició y generó un token nuevo. Abre la nueva dirección que imprime «pnpm dev:web» (con ?port=…&t=…).',
  },
  sidebar: {
    label: 'Espacios de trabajo',
    newWorkspace: 'Nuevo espacio',
    workspaceDefaultName: 'Espacio',
    closeWorkspace: 'Cerrar espacio',
    renameHint: 'Doble clic para renombrar',
    empty: 'Aún no hay espacios.',
    createFirst: 'Crear el primero',
  },
  tabs: {
    label: 'Pestañas',
    newTab: 'Nueva pestaña',
    closeTab: 'Cerrar pestaña',
    defaultName: 'Pestaña',
    untitled: 'Sin título',
    emptyWorkspace: 'Este espacio no tiene pestañas.',
  },
  pane: {
    splitRight: 'Dividir a la derecha',
    splitDown: 'Dividir hacia abajo',
    close: 'Cerrar panel',
    swap: 'Intercambiar de sitio',
    swapPending: 'Elige el otro panel para intercambiar',
    swapCancel: 'Cancelar intercambio',
    resizeSeparator: 'Redimensionar paneles',
    terminalLabel: 'Terminal',
    exited: 'El proceso terminó',
    exitedWithCode: 'El proceso terminó con código {code}',
    exitedWithSignal: 'El proceso terminó por la señal {signal}',
    pressEnter: 'Pulsa Intro para reiniciarlo.',
    loading: 'Iniciando terminal…',
  },
  attention: {
    idle: 'En reposo',
    working: 'Trabajando',
    'needs-input': 'Necesita tu respuesta',
    done: 'Terminado',
    error: 'Con error',
  },
  search: {
    label: 'Buscar en la terminal',
    placeholder: 'Buscar…',
    next: 'Siguiente',
    previous: 'Anterior',
    close: 'Cerrar búsqueda',
  },
  help: {
    title: 'Atajos de teclado',
    close: 'Cerrar',
    hint: 'Los atajos de la shell (Ctrl+C, Ctrl+D, Ctrl+R…) siempre llegan a la terminal.',
  },
  shortcuts: {
    'tab.new': 'Nueva pestaña',
    'pane.close': 'Cerrar panel',
    'pane.split-right': 'Dividir a la derecha',
    'pane.split-down': 'Dividir hacia abajo',
    'pane.focus-left': 'Panel de la izquierda',
    'pane.focus-right': 'Panel de la derecha',
    'pane.focus-up': 'Panel de arriba',
    'pane.focus-down': 'Panel de abajo',
    'tab.next': 'Pestaña siguiente',
    'tab.prev': 'Pestaña anterior',
    'tab.goto': 'Ir a la pestaña 1-9',
    'terminal.search': 'Buscar en la terminal',
    'help.toggle': 'Mostrar esta ayuda',
  },
  errors: {
    generic: 'No se pudo completar la acción: {message}',
    dismiss: 'Descartar',
  },
} as const

export type Dictionary = typeof es

/** Sustituye `{nombre}` por los valores dados; el resultado es texto, nunca HTML. */
export function format(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  )
}
