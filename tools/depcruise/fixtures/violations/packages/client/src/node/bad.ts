// Viola: el subpath node de client no importa core (node:* y zod si estan permitidos).
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { coreThing } from '../../../core/src/thing.ts'

export const bad = [readFileSync, z, coreThing]
