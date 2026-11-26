/**
 * Estimación de tokens, determinista y barata (sin tokenizador real). Es una **aproximación**: cuenta
 * 1/4 de token por carácter ASCII (inglés y código: ~4 caracteres por token), 1/2 por carácter hasta
 * U+07FF (español con tildes, cirílico, griego), 1 por carácter del resto del plano básico (CJK) y 2 por
 * carácter astral (emoji). Suele errar menos de un 30 % frente a los tokenizadores de los modelos y se
 * inclina a sobrestimar el texto no latino. Sirve para decidir *cuándo* observar o reflexionar, nunca para
 * facturar: el costo real lo informa el resumidor en `SummarizerUsage`.
 */
export function estimateTokens(text: string): number {
  let quarters = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x80) quarters += 1
    else if (c < 0x800) quarters += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        quarters += 8
        i++
      } else quarters += 4
    } else quarters += 4
  }
  return Math.ceil(quarters / 4)
}
