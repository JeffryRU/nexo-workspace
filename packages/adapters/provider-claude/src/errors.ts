import type { ProviderError } from '@nexo/contracts'
import { line } from './text.ts'

/**
 * Nexo no implementa ningún inicio de sesión ni lee credenciales de claude.ai: el SDK usa lo que haya en el
 * entorno del daemon. Este es el mensaje que ve el usuario cuando no hay credenciales válidas.
 */
export const AUTH_MESSAGE =
  'Claude no tiene credenciales válidas. Nexo no inicia sesión por ti: define ANTHROPIC_API_KEY ' +
  '(una clave de la API) o CLAUDE_CODE_OAUTH_TOKEN (tu propio token, que generas con ' +
  '`claude setup-token`) en el entorno del daemon y reinicia el daemon.'

export function authError(): ProviderError {
  return { code: 'AUTH_REQUIRED', message: AUTH_MESSAGE, fatal: true, retryable: false }
}

const AUTH_TEXT =
  /invalid api key|invalid x-api-key|not logged in|please run \/login|oauth token (?:has )?(?:expired|been revoked|revoked)|authentication[_ ](?:failed|error)|could not resolve authentication/i

/** El texto de un resultado o un error del SDK describe un fallo de credenciales. */
export function looksLikeAuthFailure(text: string): boolean {
  return AUTH_TEXT.test(text)
}

/** Traduce el código de error de un mensaje de asistente (`SDKAssistantMessageError`) a un error normalizado. */
export function describeApiError(code: string): ProviderError {
  switch (code) {
    case 'authentication_failed':
    case 'oauth_org_not_allowed':
    case 'cloud_credential_error':
      return authError()
    case 'billing_error':
      return {
        code: 'BILLING',
        message:
          'Claude rechazó la petición por facturación o saldo. Revisa tu plan o tu clave de API.',
        fatal: false,
        retryable: false,
      }
    case 'account_on_hold':
    case 'verification_required':
      return {
        code: 'ACCOUNT',
        message:
          'La cuenta de Claude está en espera o necesita verificación. Revisa tu cuenta de Anthropic.',
        fatal: false,
        retryable: false,
      }
    case 'rate_limit':
      return {
        code: 'RATE_LIMIT',
        message: 'Claude alcanzó un límite de uso. Espera un momento y vuelve a intentarlo.',
        fatal: false,
        retryable: true,
      }
    case 'overloaded':
      return {
        code: 'OVERLOADED',
        message: 'Claude está saturado en este momento. Vuelve a intentarlo en unos segundos.',
        fatal: false,
        retryable: true,
      }
    case 'server_error':
      return {
        code: 'SERVER_ERROR',
        message: 'El servicio de Claude devolvió un error interno. Vuelve a intentarlo.',
        fatal: false,
        retryable: true,
      }
    case 'invalid_request':
      return {
        code: 'INVALID_REQUEST',
        message: 'Claude rechazó la petición por inválida.',
        fatal: false,
        retryable: false,
      }
    case 'model_not_found':
      return {
        code: 'MODEL_NOT_FOUND',
        message: 'El modelo elegido no existe o tu cuenta no tiene acceso a él.',
        fatal: false,
        retryable: false,
      }
    case 'max_output_tokens':
      return {
        code: 'MAX_OUTPUT_TOKENS',
        message: 'La respuesta de Claude llegó al límite de tokens de salida.',
        fatal: false,
        retryable: false,
      }
    default:
      return {
        code: 'CLAUDE_ERROR',
        message: `Claude devolvió un error (${line(code, 64, 'desconocido')}).`,
        fatal: false,
        retryable: false,
      }
  }
}
