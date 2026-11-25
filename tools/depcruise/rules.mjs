// Reglas de dependencias de docs/ARCHITECTURE.md (seccion "Regla de dependencias").
// `prefix` permite aplicar las mismas reglas a un arbol de fixtures (ver tools/test).

const TEST_FILE = '\\.test\\.tsx?$'

/**
 * @param {string} [prefix] prefijo de ruta (cadena vacia en el repo real)
 * @returns {object[]} reglas `forbidden` de dependency-cruiser
 */
export function buildRules(prefix = '') {
  const p = (path) => `^${prefix}${path}`
  const error = 'error'
  return [
    {
      name: 'no-circular',
      comment: 'Sin dependencias circulares.',
      severity: error,
      from: {},
      to: { circular: true },
    },
    {
      name: 'contracts-solo-zod',
      comment: 'contracts no importa nada del repo ni de Node; solo zod.',
      severity: error,
      from: { path: p('packages/contracts/src/'), pathNot: TEST_FILE },
      to: { pathNot: [p('packages/contracts/'), 'node_modules/zod/', '^zod$'] },
    },
    {
      name: 'core-solo-contracts',
      comment: 'core importa solo contracts: sin node:*, fs, process, DOM ni adaptadores.',
      severity: error,
      from: { path: p('packages/core/src/'), pathNot: TEST_FILE },
      to: { pathNot: [p('packages/core/'), p('packages/contracts/')] },
    },
    {
      name: 'client-solo-contracts',
      comment: 'client (SDK del protocolo) solo importa contracts.',
      severity: error,
      from: { path: p('packages/client/src/'), pathNot: TEST_FILE },
      to: { pathNot: [p('packages/client/'), p('packages/contracts/')] },
    },
    {
      name: 'adapters-aislados',
      comment: 'Un adaptador no importa a otro adaptador.',
      severity: error,
      from: { path: p('packages/adapters/([^/]+)/') },
      to: { path: p('packages/adapters/'), pathNot: p('packages/adapters/$1/') },
    },
    {
      name: 'adapters-sin-apps',
      comment: 'Los adaptadores no importan apps ni client.',
      severity: error,
      from: { path: p('packages/adapters/') },
      to: { path: [p('apps/'), p('packages/client/')] },
    },
    {
      name: 'testkit-sin-adapters-ni-apps',
      comment: 'testkit solo conoce core y contracts.',
      severity: error,
      from: { path: p('packages/testkit/') },
      to: { path: [p('apps/'), p('packages/adapters/'), p('packages/client/')] },
    },
    {
      name: 'paquetes-sin-apps',
      comment: 'Ningun paquete importa una app.',
      severity: error,
      from: { path: p('packages/') },
      to: { path: p('apps/') },
    },
    {
      name: 'apps-aisladas',
      comment: 'Ninguna app importa a otra app.',
      severity: error,
      from: { path: p('apps/([^/]+)/') },
      to: { path: p('apps/'), pathNot: p('apps/$1/') },
    },
    {
      name: 'produccion-sin-testkit',
      comment: 'El codigo de produccion no importa testkit.',
      severity: error,
      from: {
        path: [p('packages/'), p('apps/')],
        pathNot: [TEST_FILE, p('packages/testkit/')],
      },
      to: { path: p('packages/testkit/') },
    },
  ]
}

export const cruiseOptions = {
  tsPreCompilationDeps: true,
  doNotFollow: { path: 'node_modules' },
  exclude: { path: ['/fixtures/', '/coverage/', '/dist/'] },
}
