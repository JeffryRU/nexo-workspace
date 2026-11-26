import { LIMITS, type PermissionOption } from '@nexo/contracts'
import {
  CommandApprovalParams,
  FileChangeApprovalParams,
  PermissionsApprovalParams,
} from './protocol.ts'
import { line, truncateUtf8 } from './text.ts'

/**
 * Cómo se muestra y se responde una solicitud de aprobación del servidor. Cada opción del permiso lleva
 * la respuesta exacta que Codex espera (`result` de la solicitud JSON-RPC).
 */
export type ApprovalPlan = {
  tool: string
  title: string
  detail?: string
  options: PermissionOption[]
  /** `result` que se devuelve a Codex para cada `id` de opción. */
  responses: Record<string, unknown>
  /** `result` que se devuelve si el turno se interrumpe o la sesión se cierra. */
  cancel: unknown
}

const ALLOW: PermissionOption = { id: 'allow', label: 'Permitir', kind: 'allow-once' }
const ALLOW_SESSION: PermissionOption = {
  id: 'allow-session',
  label: 'Permitir en esta sesión',
  kind: 'allow-always',
}
const REJECT: PermissionOption = { id: 'reject', label: 'Rechazar', kind: 'reject-once' }

function detailOf(lines: (string | undefined)[]): string | undefined {
  const text = lines.filter((l): l is string => l !== undefined && l !== '').join('\n')
  return text === '' ? undefined : truncateUtf8(text, LIMITS.maxBlockInputBytes).text
}

/** Métodos de solicitud del servidor que se traducen a un permiso. Otros no se soportan. */
export const APPROVAL_METHODS = [
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
] as const

/** Plan de una solicitud de aprobación; `undefined` si el método no es una aprobación o los parámetros no valen. */
export function planApproval(method: string, params: unknown): ApprovalPlan | undefined {
  switch (method) {
    case 'item/commandExecution/requestApproval': {
      const p = CommandApprovalParams.safeParse(params)
      if (!p.success) return undefined
      const stdin = p.data.kind === 'writeStdin'
      const command = p.data.command ?? undefined
      const title = stdin
        ? 'Enviar entrada a un proceso en ejecución'
        : command === undefined || command === ''
          ? 'Ejecutar un comando'
          : `Ejecutar: ${line(command, 200)}`
      return {
        tool: stdin ? 'shell-stdin' : 'shell',
        title: line(title, LIMITS.maxTitleLength, 'Ejecutar un comando'),
        ...optionalDetail(
          detailOf([
            command ?? undefined,
            p.data.cwd ? `Carpeta: ${p.data.cwd}` : undefined,
            p.data.reason ? `Motivo: ${p.data.reason}` : undefined,
          ]),
        ),
        options: [ALLOW, ALLOW_SESSION, REJECT],
        responses: {
          allow: { decision: 'accept' },
          'allow-session': { decision: 'acceptForSession' },
          reject: { decision: 'decline' },
        },
        cancel: { decision: 'cancel' },
      }
    }
    case 'item/fileChange/requestApproval': {
      const p = FileChangeApprovalParams.safeParse(params)
      if (!p.success) return undefined
      return {
        tool: 'apply_patch',
        title: 'Aplicar cambios en archivos',
        ...optionalDetail(
          detailOf([
            p.data.reason ? `Motivo: ${p.data.reason}` : undefined,
            p.data.grantRoot ? `Escritura en: ${p.data.grantRoot}` : undefined,
          ]),
        ),
        options: [ALLOW, ALLOW_SESSION, REJECT],
        responses: {
          allow: { decision: 'accept' },
          'allow-session': { decision: 'acceptForSession' },
          reject: { decision: 'decline' },
        },
        cancel: { decision: 'cancel' },
      }
    }
    case 'item/permissions/requestApproval': {
      const p = PermissionsApprovalParams.safeParse(params)
      if (!p.success) return undefined
      const { network, fileSystem } = p.data.permissions
      const asked = {
        ...(network === null || network === undefined ? {} : { network }),
        ...(fileSystem === null || fileSystem === undefined ? {} : { fileSystem }),
      }
      return {
        tool: 'permissions',
        title: 'Permisos adicionales',
        ...optionalDetail(
          detailOf([p.data.reason ? `Motivo: ${p.data.reason}` : undefined, JSON.stringify(asked)]),
        ),
        options: [ALLOW, ALLOW_SESSION, REJECT],
        responses: {
          allow: { permissions: asked, scope: 'turn' },
          'allow-session': { permissions: asked, scope: 'session' },
          reject: { permissions: {}, scope: 'turn' },
        },
        cancel: { permissions: {}, scope: 'turn' },
      }
    }
    default:
      return undefined
  }
}

const optionalDetail = (detail: string | undefined) => (detail === undefined ? {} : { detail })
