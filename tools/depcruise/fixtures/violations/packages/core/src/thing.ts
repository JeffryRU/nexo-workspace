// Viola: core importa node:*, un modulo de Node sin prefijo y un adaptador.
import { readFileSync } from 'node:fs'
import { join } from 'path'
import { adapterA } from '../../adapters/a/src/a.ts'

export const coreThing = [readFileSync, join, adapterA]
