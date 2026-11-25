// Viola: el nucleo de client no puede usar node:* (solo el subpath node).
import { readFileSync } from 'node:fs'

export const usesNode = readFileSync
