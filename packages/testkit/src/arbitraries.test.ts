import { LayoutSchema, parseRequestValue, parseServerMessageValue } from '@atalaya/contracts'
import * as fc from 'fast-check'
import { describe, it } from 'vitest'
import { arbEvent, arbLayout, arbRequest, arbServerMessage, arbWorkspace } from './arbitraries.ts'

describe('generadores', () => {
  it('arbLayout produce árboles válidos', () => {
    fc.assert(fc.property(arbLayout(), (l) => LayoutSchema.safeParse(l).success))
  })

  it('arbLayout respeta maxLeaves', () => {
    fc.assert(
      fc.property(arbLayout({ maxLeaves: 3 }), (l) => {
        const count = JSON.stringify(l).split('"leaf"').length - 1
        return count <= 3
      }),
    )
  })

  it('arbRequest, arbEvent, arbServerMessage y arbWorkspace producen valores válidos', () => {
    fc.assert(fc.property(arbRequest, (r) => parseRequestValue(r).ok))
    fc.assert(fc.property(arbEvent, (e) => parseServerMessageValue(e).ok))
    fc.assert(fc.property(arbServerMessage, (m) => parseServerMessageValue(m).ok))
    fc.assert(fc.property(arbWorkspace, (w) => typeof w.id === 'string'))
  })
})
