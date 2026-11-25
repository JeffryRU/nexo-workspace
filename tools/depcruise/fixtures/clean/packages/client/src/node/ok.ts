import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { Ok } from '../../../contracts/src/ok.ts'
import { core } from '../core.ts'

export const ok = [readFileSync, z, Ok, core]
