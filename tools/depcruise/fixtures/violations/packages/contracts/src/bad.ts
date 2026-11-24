// Viola: contracts importa otro paquete del repo y una libreria que no es zod.
import * as fc from 'fast-check'
import { coreThing } from '../../core/src/thing.ts'

export const bad = [fc, coreThing]
