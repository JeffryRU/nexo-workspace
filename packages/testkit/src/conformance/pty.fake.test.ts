import { FakePtyPort } from '../fakes.ts'
import { runPtyConformance } from './pty.ts'

runPtyConformance('FakePtyPort', () => ({
  port: new FakePtyPort({ script: (proc) => proc.emitData('listo\r\n') }),
  command: { cmd: 'fake', args: [], marker: 'listo' },
}))
