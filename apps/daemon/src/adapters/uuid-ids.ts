import { randomUUID } from 'node:crypto'
import { AgentSessionId, BlockId, PaneId, TabId, TerminalId, WorkspaceId } from '@nexo/contracts'
import type { IdPort } from '@nexo/core'

/** Ids con `crypto.randomUUID`; el prefijo solo ayuda a leer logs y depurar. */
export class UuidIds implements IdPort {
  workspace(): WorkspaceId {
    return WorkspaceId.parse(`ws-${randomUUID()}`)
  }
  tab(): TabId {
    return TabId.parse(`tab-${randomUUID()}`)
  }
  pane(): PaneId {
    return PaneId.parse(`pane-${randomUUID()}`)
  }
  terminal(): TerminalId {
    return TerminalId.parse(`term-${randomUUID()}`)
  }
  agentSession(): AgentSessionId {
    return AgentSessionId.parse(`agent-${randomUUID()}`)
  }
  block(): BlockId {
    return BlockId.parse(`blk-${randomUUID()}`)
  }
}
