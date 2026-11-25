import { FakePtyPort } from '../fakes.ts'
import { runPtyConformance } from './pty.ts'

runPtyConformance('FakePtyPort', () => ({
  port: new FakePtyPort({
    script: (proc) => proc.emitData('listo\r\n'),
    missingCmds: ['no-existe'],
    missingCwds: ['/no/existe'],
  }),
  command: { cmd: 'fake', args: [], marker: 'listo' },
  missing: { cmd: 'no-existe', cwd: '/no/existe' },
}))
