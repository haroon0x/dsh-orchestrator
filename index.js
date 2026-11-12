/**
 * Fleet orchestration: one Agent's live view of every other Agent in this
 * process, plus the authority to steer and stop them.
 *
 * The Host half registers four tools and one prompt section. Every
 * registration is admitted only to Agents composed by the `orchestrator`
 * preset (`when`), so no other Agent's tool catalog or prompt changes.
 *
 * Visibility comes from the live Agent registry (`ctx.agents`), never from a
 * cached list: `fleet_roster` re-reads it on every call. Activity is derived
 * from each Session's own committed event log, so the report is the durable
 * truth rather than an inference.
 *
 * @module @haroon0x/dsh-orchestrator
 */
import { randomUUID } from 'node:crypto'

export const name = 'orchestrator'
export const inject = ['tools', 'agents', 'systemPrompt']

const ORCHESTRATOR_PRESET = 'orchestrator'
/** How many trailing events one activity scan reads. Enough to cross a tool batch. */
const SCAN_EVENTS = 240
/** Roster entries returned when the caller does not choose a limit. */
const DEFAULT_LIMIT = 20
/** Hard cap, so one call cannot dump an unbounded fleet. */
const MAX_LIMIT = 50
/** Characters kept from one assistant or user message in a summary line. */
const CLIP = 220
const SECTION_ORDER_FALLBACK = 650

/**
 * Register the fleet tools and the orchestrator role section.
 * @param ctx - Host context carrying tools, the live Agent registry, and the prompt registry.
 */
export function apply(ctx) {
  /** Resolve the live preset id, falling back to the creation-time header. */
  const presetOf = (agent) => {
    if (agent?.session === undefined) return undefined
    try {
      const live = ctx.get('agentPresets')?.presetForSession(agent.session)
      if (typeof live === 'string' && live.length > 0) return live
    } catch {
      // Fall through to the durable header.
    }
    const recorded = agent.session.header?.agentPreset
    return typeof recorded === 'string' && recorded.length > 0 ? recorded : undefined
  }
  const isOrchestrator = (agent) => presetOf(agent) === ORCHESTRATOR_PRESET

  /** Register one tool gated to orchestrator-composed Agents. */
  const tool = (definition) => ctx.effect(() => ctx.tools.register(definition, {
    when: (context) => isOrchestrator(context.agent),
  }))

  /** Every live Agent that can be addressed. */
  const fleet = () => ctx.agents.list().filter((agent) => agent?.session !== undefined)

  /** Best-effort projection read; one broken Session must not fail a roster. */
  const projectionsOf = (session) => {
    const service = ctx.get('sessionProjections')
    if (service === undefined) return {}
    try {
      return service.snapshot(session, ['title', 'todos', 'goal', 'inbox']).values ?? {}
    } catch {
      return {}
    }
  }

  /** Read the latest events plus the activity facts they imply. */
  const scan = (session) => {
    const end = typeof session.seq === 'number' ? session.seq : 0
    let tail = []
    try {
      tail = session.snapshotEvents(Math.max(0, end - SCAN_EVENTS))
    } catch {
      tail = []
    }
    const openCalls = new Map()
    const approvals = new Map()
    let lastAssistant = undefined
    let lastUser = undefined
    let lastHuman = undefined
    let lastEvent = undefined
    let lastTurnEnd = undefined
    for (const event of tail) {
      lastEvent = event
      switch (event.type) {
        case 'assistant/message':
          lastAssistant = event
          break
        case 'user/message':
          lastUser = event
          if (isHumanInstruction(event)) lastHuman = event
          break
        case 'tool/call':
          openCalls.set(event.data.callId, event)
          break
        case 'tool/result': {
          const callId = event.data.message?.toolCallId
          if (callId !== undefined) openCalls.delete(callId)
          break
        }
        case 'approval/asked':
          approvals.set(event.data.id, event)
          break
        case 'approval/decided':
          approvals.delete(event.data.id)
          break
        case 'turn/end':
          lastTurnEnd = event
          break
        default:
          break
      }
    }
    return {
      tail,
      lastEvent,
      lastAssistant,
      lastUser,
      lastHuman,
      lastTurnEnd,
      openCalls: [...openCalls.values()],
      pendingApproval: [...approvals.values()].at(-1),
    }
  }

  const boundaryOf = (session) => {
    try {
      return ctx.agents.turnBoundaryOf(session)
    } catch {
      return undefined
    }
  }

  const statusOf = (agent) => (agent.status === 'running' ? 'running' : 'idle')

  /** One line that says what the Agent is doing, not merely whether it is loaded. */
  const activityOf = (agent, state) => {
    if (state.pendingApproval !== undefined) {
      return {
        kind: 'waiting-approval',
        text: `waiting for approval: ${state.pendingApproval.data.toolName}`,
      }
    }
    if (state.openCalls.length > 0 && agent.status === 'running') {
      const names = [...new Set(state.openCalls.map((call) => call.data.name))]
      if (names.includes('ask_user_question')) return { kind: 'waiting-user', text: 'waiting for a user answer' }
      return { kind: 'running-tools', text: `running ${names.join(', ')}` }
    }
    if (agent.status === 'running') {
      if (state.lastEvent?.type === 'step/start') return { kind: 'thinking', text: 'waiting on the model' }
      if (state.lastEvent?.type === 'user/message') return { kind: 'thinking', text: 'starting a step' }
      if (state.lastEvent?.type === 'assistant/message') return { kind: 'thinking', text: 'finishing a step' }
      return { kind: 'working', text: 'working' }
    }
    return { kind: 'idle', text: 'idle' }
  }

  /** One tool call rendered as `name — most informative argument`. */
  const callPreview = (event) => {
    const args = event.data.arguments
    let parsed
    try {
      parsed = JSON.parse(args)
    } catch {
      parsed = undefined
    }
    const candidates = ['command', 'file_path', 'path', 'pattern', 'description', 'prompt', 'objective', 'url', 'agent_id']
    let detail
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const key of candidates) {
        const value = parsed[key]
        if (typeof value === 'string' && value.length > 0) {
          detail = value
          break
        }
      }
      if (detail === undefined) detail = args
    } else {
      detail = args
    }
    return { name: event.data.name, preview: clip(detail, 120) }
  }

  /** Build one roster row. */
  const describe = (agent, all, now, selfId, projections = projectionsOf(agent.session)) => {
    const session = agent.session
    const header = session.header
    const state = scan(session)
    const activity = activityOf(agent, state)
    const boundary = boundaryOf(session)
    const children = all.filter((candidate) => candidate.session.header?.parentSession === session.id)
    const route = (() => {
      try {
        return session.requestContext()
      } catch {
        return undefined
      }
    })()
    const inbox = projections.inbox ?? {}
    return {
      id: session.id,
      self: session.id === selfId,
      title: typeof projections.title === 'string' && projections.title.length > 0
        ? projections.title
        : clip(textOf(state.lastHuman?.data.content), 80) || null,
      status: statusOf(agent),
      activity: activity.text,
      activity_kind: activity.kind,
      preset: presetOf(agent) ?? header.agentPreset ?? null,
      provider: route?.provider ?? null,
      model: route?.model ?? null,
      cwd: header.cwd ?? null,
      parent: header.parentSession ?? null,
      depth: header.delegationDepth ?? 0,
      turn: boundary?.lastTurn ?? 0,
      step: lastStepOf(state),
      active_ms: state.lastEvent === undefined ? null : Math.max(0, now - state.lastEvent.time),
      last_assistant: clip(textOf(state.lastAssistant?.data.message.content), CLIP) || null,
      last_user: clip(textOf(state.lastHuman?.data.content), CLIP) || null,
      last_outcome: state.lastTurnEnd?.data.reason?.kind ?? null,
      open_tools: state.openCalls.map(callPreview),
      approval: state.pendingApproval === undefined
        ? null
        : {
            tool: state.pendingApproval.data.toolName,
            reason: state.pendingApproval.data.reason ?? null,
          },
      queued: (inbox['next-turn']?.length ?? 0) + (inbox['next-step']?.length ?? 0),
      children: children.map((child) => child.session.id),
      todos: Array.isArray(projections.todos)
        ? {
            total: projections.todos.length,
            done: projections.todos.filter((item) => item?.status === 'completed').length,
          }
        : null,
      goal: projections.goal === null || projections.goal === undefined
        ? null
        : typeof projections.goal?.goal?.objective === 'string'
          ? clip(projections.goal.goal.objective, 160)
          : null,
    }
  }

  const rely = (agentId) => {
    const id = String(agentId ?? '').trim()
    if (id.length === 0) throw new Error('agent_id is required. Call fleet_roster for current ids.')
    const target = ctx.agents.get(id)
    if (target === undefined || target.session === undefined) {
      throw new Error(`No live agent with id "${id}". Agents that are not loaded cannot be addressed; call fleet_roster for current ids.`)
    }
    return target
  }

  tool({
    name: 'fleet_roster',
    description: 'List every live Agent in this process with its status and current activity, running Agents first. This is the only source of Agent ids: call it before messaging or interrupting anything, and again after acting or after a long pause. A row marked self is you; never manage yourself.',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['all', 'running', 'idle'],
          description: 'Only Agents in this state; defaults to all.',
        },
        limit: {
          type: 'number',
          description: 'Maximum rows returned, 1-50; defaults to 20. More rows are reported as omitted.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {},
      render: (_args, value) => [{ type: 'text', text: renderRoster(value) }],
    },
    presentCall: () => ({ card: 'generic', kind: 'read', title: 'Fleet roster' }),
    execute(args, exec) {
      const now = Date.now()
      const selfId = exec.agent?.session?.id
      const wanted = args?.status ?? 'all'
      const limit = clampLimit(args?.limit)
      const all = fleet()
      const rows = all.map((agent) => describe(agent, all, now, selfId))
      const running = rows.filter((row) => row.status === 'running').length
      let selected = rows
      if (wanted === 'running' || wanted === 'idle') selected = rows.filter((row) => row.status === wanted)
      selected = [...selected].sort((left, right) => rank(left, right))
      return {
        total: all.length,
        running,
        idle: rows.length - running,
        shown: Math.min(selected.length, limit),
        omitted: Math.max(0, selected.length - limit),
        agents: selected.slice(0, limit),
      }
    },
  })

  tool({
    name: 'fleet_inspect',
    description: 'Read one live Agent in detail: its recent user and assistant messages, open tool calls, queued input, todo list, goal, and children. Use it when a roster line is not enough to decide whether to steer, wait, or interrupt; a roster line is not a result.',
    parameters: {
      type: 'object',
      properties: {
        agent_id: {
          type: 'string',
          required: true,
          description: 'Exact Agent id from fleet_roster.',
        },
        messages: {
          type: 'number',
          description: 'Recent messages to include, 0-30; defaults to 8. Each message is truncated.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {},
      render: (_args, value) => [{ type: 'text', text: renderInspect(value) }],
    },
    presentCall: () => ({ card: 'generic', kind: 'read', title: 'Inspect agent' }),
    execute(args, exec) {
      const target = rely(args?.agent_id)
      const selfId = exec.agent?.session?.id
      const now = Date.now()
      const projections = projectionsOf(target.session)
      const state = scan(target.session)
      const all = fleet()
      const row = describe(target, all, now, selfId, projections)
      const wanted = clampMessages(args?.messages)
      const messages = wanted === 0 ? [] : recentMessages(state.tail, wanted)
      const inbox = projections.inbox ?? {}
      return {
        ...row,
        is_parent: target.session.header?.parentSession === selfId,
        messages,
        inbox: {
          next_turn: (inbox['next-turn'] ?? []).map((message) => clip(textOf(message?.content), CLIP)),
          next_step: (inbox['next-step'] ?? []).map((message) => clip(textOf(message?.content), CLIP)),
        },
        approval_reason: state.pendingApproval?.data.reason ?? null,
        todos: Array.isArray(projections.todos)
          ? projections.todos.map((item) => ({
              status: item?.status ?? 'pending',
              content: clip(String(item?.content ?? ''), 140),
            }))
          : [],
        boundary: boundaryOf(target.session) ?? null,
      }
    },
  })

  tool({
    name: 'fleet_message',
    description: 'Send a message from you to another live Agent. A running Agent receives it at its next step; an idle Agent starts a new turn with it. Delivery is one-way: the call returns acceptance, not a reply, and only an Agent you started yourself reports its result back automatically.',
    parameters: {
      type: 'object',
      properties: {
        agent_id: {
          type: 'string',
          required: true,
          description: 'Exact Agent id from fleet_roster. Your own id is refused.',
        },
        message: {
          type: 'string',
          required: true,
          description: 'Self-contained instruction or question. The target shares your filesystem but not your conversation, so name paths, ids, and expected output explicitly.',
        },
        mode: {
          type: 'string',
          enum: ['auto', 'steer', 'followup'],
          description: 'auto (default) steers a running Agent at its next step and starts a turn for an idle one. steer forces delivery into the current or next turn; followup queues a separate turn after the current one.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {},
      render: (_args, value) => [{
        type: 'text',
        text: value.delivered
          ? `accepted for ${value.agent_id} via ${value.delivery} (target was ${value.target_status}); message ${value.message_id}`
          : `not delivered to ${value.agent_id}: ${value.reason}`,
      }],
    },
    presentCall: () => ({ card: 'generic', kind: 'update', title: 'Message agent' }),
    execute(args, exec) {
      const sender = exec.agent
      if (sender === undefined) throw new Error('fleet_message requires a calling agent')
      const target = rely(args?.agent_id)
      if (target.session.id === sender.session.id) {
        throw new Error('Refusing to message yourself. Use your own turn for your own work.')
      }
      const text = String(args?.message ?? '').trim()
      if (text.length === 0) throw new Error('message must not be empty')
      exec.signal?.throwIfAborted()
      const requested = args?.mode ?? 'auto'
      const running = target.status === 'running'
      const delivery = requested === 'auto' ? (running ? 'steer' : 'followup') : requested
      const message = {
        id: randomUUID(),
        role: 'user',
        content: [
          { type: 'text', text: `Agent ${sender.session.id} sent a message: ` },
          { type: 'text', text },
        ],
        source: { kind: 'agent-message', form: 'relay', senderSessionId: sender.session.id },
      }
      if (delivery === 'steer') target.steer(message)
      else target.followup(message)
      return {
        delivered: true,
        agent_id: target.session.id,
        message_id: message.id,
        delivery,
        target_status: running ? 'running' : 'idle',
      }
    },
  })

  tool({
    name: 'fleet_interrupt',
    description: 'Stop another live Agent\'s current turn. Queued messages are kept unless clear_queue is true, so the Agent stays available and messageable. The call returns when cancellation is requested, not when the target is quiet; confirm with fleet_roster.',
    parameters: {
      type: 'object',
      properties: {
        agent_id: {
          type: 'string',
          required: true,
          description: 'Exact Agent id from fleet_roster. Your own id is refused.',
        },
        clear_queue: {
          type: 'boolean',
          description: 'Also discard work queued for a later turn; defaults to false, which keeps the queue.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {},
      render: (_args, value) => [{
        type: 'text',
        text: `interrupt requested for ${value.agent_id} (was ${value.status_before}); ${value.queued_kept ? 'queued input kept' : 'queued input cleared'}. It may stay running until it observes the cancellation.`,
      }],
    },
    presentCall: () => ({ card: 'generic', kind: 'update', title: 'Interrupt agent' }),
    execute(args, exec) {
      const sender = exec.agent
      if (sender === undefined) throw new Error('fleet_interrupt requires a calling agent')
      const target = rely(args?.agent_id)
      if (target.session.id === sender.session.id) {
        throw new Error('Refusing to interrupt yourself. End your turn instead.')
      }
      const before = statusOf(target)
      const clear = args?.clear_queue === true
      target.cancel({ kind: 'user' }, { keepInbox: !clear })
      return {
        accepted: true,
        agent_id: target.session.id,
        status_before: before,
        queued_kept: !clear,
      }
    },
  })

  ctx.systemPrompt.section({
    name: 'orchestrator:role',
    order: orderNear(ctx, 'TEAM_POLICY'),
    text: (context) => (isOrchestrator(context.agent) ? ROLE : ''),
  })
}

const ROLE = `# Fleet orchestration

You are the fleet orchestrator: the other live Agents are your workers. Your job is to keep them pointed at the right work, unblock them, and report honestly — not to redo their work yourself.

Call \`fleet_roster\` on your first step of every turn, and again after any pause or action. It is the only authoritative source of Agent ids, status, and current activity; never guess an id or reuse a stale row. Call \`fleet_inspect\` when a roster line does not tell you enough to decide.

Act on what you see:
- Idle with unfinished work: \`fleet_message\` with the next concrete instruction.
- Running on superseded work: \`fleet_message\` now; it lands at the next step without stopping the current turn.
- Looping, stuck, or wrong: \`fleet_interrupt\`, then \`fleet_message\` the correction.
- Waiting for approval or a user answer: it is blocked on the human, not on itself. Say what it needs; interrupt it only when the work is abandoned.
- Finished: read the result with \`fleet_inspect\` before reporting it. A roster line is not a result.

Rules:
- Your own row is marked \`self\`. Never message or interrupt yourself.
- A message is one-way. The target does not answer you in your conversation; follow its progress through the roster. Only an Agent you started with \`subagent\` reports its result back automatically.
- Do not start an Agent for work you can finish in one step, and do not duplicate work that is already running.
- When reporting to the user, give one line per Agent that matters: what it is doing, what it needs, or what it finished. Do not dump the raw roster.`

function clip(text, max) {
  if (typeof text !== 'string') return ''
  const compact = text.replace(/\s+/g, ' ').trim()
  if (compact.length <= max) return compact
  return `${compact.slice(0, Math.max(0, max - 1))}…`
}

function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/** Whether a user-role event carries an instruction rather than injected context. */
function isHumanInstruction(event) {
  const kind = event.data?.source?.kind
  return kind === 'user' || kind === 'agent-message'
}

function lastStepOf(state) {
  for (let index = state.tail.length - 1; index >= 0; index--) {
    const event = state.tail[index]
    if (event.type === 'step/start' || event.type === 'step/end') return event.data.step
  }
  return 0
}

function recentMessages(tail, limit) {
  const messages = []
  for (let index = tail.length - 1; index >= 0 && messages.length < limit; index--) {
    const event = tail[index]
    if (event.type === 'user/message') {
      if (isHumanInstruction(event)) messages.push({ role: 'user', text: clip(textOf(event.data.content), 400) })
    } else if (event.type === 'assistant/message') {
      const text = clip(textOf(event.data.message?.content), 400)
      if (text.length > 0) messages.push({ role: 'assistant', text })
    }
  }
  return messages.reverse()
}

function clampLimit(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_LIMIT
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(value)))
}

function clampMessages(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 8
  return Math.min(30, Math.max(0, Math.trunc(value)))
}

function orderNear(ctx, name) {
  try {
    return ctx.systemPrompt.getSectionOrder(name) + 50
  } catch {
    return SECTION_ORDER_FALLBACK
  }
}

function rank(left, right) {
  if (left.status !== right.status) return left.status === 'running' ? -1 : 1
  return (left.active_ms ?? Number.MAX_SAFE_INTEGER) - (right.active_ms ?? Number.MAX_SAFE_INTEGER)
}

function formatAge(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return 'unknown'
  if (ms < 1000) return 'now'
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  return `${Math.floor(ms / 3_600_000)}h ago`
}

function renderRoster(value) {
  const lines = []
  lines.push(`Fleet: ${value.total} live ${value.total === 1 ? 'agent' : 'agents'} — ${value.running} running, ${value.idle} idle${value.shown < value.total ? `; showing ${value.shown}` : ''}.`)
  if (value.agents.length === 0) {
    lines.push('(no agents match)')
    return lines.join('\n')
  }
  for (const agent of value.agents) {
    const tag = agent.self ? ' (you)' : ''
    lines.push('')
    lines.push(`[${agent.status}] ${agent.id} "${agent.title ?? 'untitled'}"${tag}`)
    const route = [agent.preset ?? 'no preset', [agent.provider, agent.model].filter(Boolean).join('/') || 'no model'].join(' · ')
    lines.push(`  ${route} · turn ${agent.turn} · ${formatAge(agent.active_ms)}`)
    lines.push(`  ${agent.activity_kind === 'idle' ? 'idle' : 'doing'}: ${agent.activity}`)
    const doing = agent.open_tools.length > 0
      ? agent.open_tools.map((call) => `${call.name} ${call.preview}`).join('; ')
      : null
    if (doing !== null) lines.push(`  recent call: ${doing}`)
    if (agent.last_assistant) lines.push(`  said: ${agent.last_assistant}`)
    const extras = []
    if (agent.parent) extras.push(`parent ${agent.parent}`)
    if (agent.children.length > 0) extras.push(`children ${agent.children.length}`)
    if (agent.queued > 0) extras.push(`queued ${agent.queued}`)
    if (agent.todos !== null) extras.push(`todos ${agent.todos.done}/${agent.todos.total}`)
    if (extras.length > 0) lines.push(`  ${extras.join(' · ')}`)
  }
  if (value.omitted > 0) lines.push(`\n… ${value.omitted} more not shown; raise limit or filter by status.`)
  return lines.join('\n')
}

function renderInspect(value) {
  const lines = []
  lines.push(`${value.id} "${value.title ?? 'untitled'}" — ${value.status}${value.self ? ' (you)' : ''}`)
  lines.push(`preset ${value.preset ?? 'none'} · ${[value.provider, value.model].filter(Boolean).join('/') || 'no model'} · cwd ${value.cwd ?? 'unset'}`)
  lines.push(`turn ${value.turn} · step ${value.step} · active ${formatAge(value.active_ms)}${value.last_outcome === null ? '' : ` · last turn ended: ${value.last_outcome}`}`)
  lines.push(`activity: ${value.activity}`)
  if (value.approval !== null) {
    lines.push(`approval: waiting for ${value.approval.tool}${value.approval.reason ? ` — ${value.approval.reason}` : ''}`)
  }
  if (value.open_tools.length > 0) {
    lines.push('open tool calls:')
    for (const call of value.open_tools) lines.push(`- ${call.name} ${call.preview}`)
  }
  if (value.queued > 0) {
    lines.push(`queued input: ${value.queued} (next turn ${value.inbox.next_turn.length}, next step ${value.inbox.next_step.length})`)
    for (const text of value.inbox.next_turn.slice(0, 3)) lines.push(`- [queued] ${text}`)
  }
  if (value.todos.length > 0) {
    lines.push(`todos ${value.todos.filter((item) => item.status === 'completed').length}/${value.todos.length}:`)
    for (const item of value.todos.slice(0, 8)) lines.push(`- [${item.status}] ${item.content}`)
  }
  if (value.goal) lines.push(`goal: ${value.goal}`)
  if (value.parent) lines.push(`parent: ${value.parent}${value.is_parent ? ' (you)' : ''}`)
  if (value.children.length > 0) lines.push(`children: ${value.children.join(', ')}`)
  if (value.messages.length > 0) {
    lines.push('recent messages:')
    for (const message of value.messages) lines.push(`${message.role}: ${message.text}`)
  }
  return lines.join('\n')
}
