import { runPtyConformance } from '@nexo/testkit/conformance'
import { PtyHostPort } from '../src/pty-host-port.ts'
import { LIVE_SCRIPT, NODE, nodeArgs } from './helpers.ts'

runPtyConformance('pty-host', () => {
  const port = new PtyHostPort()
  return {
    port,
    command: { cmd: NODE, args: nodeArgs(LIVE_SCRIPT), marker: 'listo' },
    missing: { cmd: 'nexo-no-existe-xyz', cwd: `${process.cwd()}/no/existe/xyz` },
    cleanup: () => port.dispose(),
  }
})
