import { cleanup } from '@solidjs/testing-library'
import { afterEach } from 'vitest'

// Sin `globals`, testing-library no se limpia solo: desmontar tras cada prueba evita fugas entre ellas.
afterEach(() => cleanup())
