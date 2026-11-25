// Viola: un adaptador importa a otro adaptador y a una app.

import { two } from '../../../../apps/two/src/two.ts'
import { adapterB } from '../../b/src/b.ts'

export const adapterA = [adapterB, two]
