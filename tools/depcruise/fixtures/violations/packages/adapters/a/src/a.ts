// Viola: un adaptador importa a otro adaptador y a una app.
import { adapterB } from '../../b/src/b.ts'
import { two } from '../../../../apps/two/src/two.ts'

export const adapterA = [adapterB, two]
