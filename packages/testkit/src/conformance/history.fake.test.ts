import { FakeHistory } from '../fake-history.ts'
import { runHistoryConformance } from './history.ts'

for (const canRead of [true, false]) {
  runHistoryConformance(`FakeHistory (${canRead ? 'leer y listar' : 'solo listar'})`, () => {
    const history = new FakeHistory('fake', { canRead })
    return {
      history,
      seed: async (s) =>
        history.add({ cwd: s.cwd, title: s.title, updatedAt: s.updatedAt, messages: s.messages }),
    }
  })
}
