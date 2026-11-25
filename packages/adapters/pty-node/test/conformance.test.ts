import { runPtyConformance } from '@nexo/testkit/conformance'
import { NodePtyPort } from '../src/node-pty-port.ts'
import { LIVE_SCRIPT, NODE, nodeArgs } from './helpers.ts'

runPtyConformance('pty-node', () => ({
  port: new NodePtyPort(),
  command: { cmd: NODE, args: nodeArgs(LIVE_SCRIPT), marker: 'listo' },
  missing: { cmd: 'nexo-no-existe-xyz', cwd: `${process.cwd()}/no/existe/xyz` },
}))
