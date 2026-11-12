import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../index.js'

const NOW = Date.now()

function event(type, data, time = NOW - 5_000) {
  return { type, time, data }
}

function makeSession({ id, preset, parent, events, cwd = '/work' }) {
  const header = {
    version: 1,
    id,
    createdAt: NOW - 60_000,
    cwd,
    isSeeded: false,
    agentPreset: preset,
    ...(parent === undefined ? {} : { parentSession: parent, delegationDepth: 1 }),
  }
  return {
    id,
    header,
    seq: events.length,
    snapshotEvents(from = 0) {
      return events.slice(from)
    },
    requestContext() {
      return { provider: 'opencode-go', model: 'deepseek-v4.1-flash' }
    },
  }
}

function makeAgent({ id, preset = 'orchestrator', status = 'idle', parent, events = [] }) {
  const received = []
  const session = makeSession({ id, preset, parent, events })
  const agent = {
    id,
    session,
    status,
    received,
    cancelled: undefined,
    steer(message) {
      received.push({ via: 'steer', message })
    },
    followup(message) {
      received.push({ via: 'followup', message })
    },
    cancel(cause, options) {
      agent.cancelled = { cause, options }
    },
  }
  return agent
}

function makeContext({ agents, projections, presets }) {
  const tools = new Map()
  const sections = []
  const ctx = {
    tools,
    sections,
    agents: {
      list: () => agents,
      get: (id) => agents.find((agent) => agent.id === id),
      turnBoundaryOf: () => ({ lastTurn: 2, lastStepStartSeq: null, openTurnStartSeq: null, lastStepBoundary: null }),
    },
    get(name) {
      if (name === 'sessionProjections') return projections
      if (name === 'agentPresets') return presets
      return undefined
    },
    effect(fn) {
      return fn()
    },
    toolsRegistry: tools,
    systemPrompt: {
      getSectionOrder() {
        return 600
      },
      section(definition) {
        sections.push(definition)
      },
    },
  }
  ctx.tools = {
    register(definition, options) {
      definition.when = options?.when
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    },
  }
  return ctx
}

function projectionsFor(values) {
  return {
    snapshot() {
      return { values }
    },
  }
}

const exec = (agent) => ({ agent, signal: new AbortController().signal })

function busyEvents() {
  return [
    event('turn/start', { turn: 2 }),
    event('step/start', { turn: 2, step: 1 }),
    event('assistant/message', {
      turn: 2,
      step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: 'Running the auth tests now.' }] },
      stream: [],
    }),
    event('tool/call', { turn: 2, step: 1, callId: 'call-1', name: 'bash', arguments: '{"command":"pnpm test tests/auth.test.ts"}' }),
  ]
}

test('registers four fleet tools and one orchestrator section', () => {
  const ctx = makeContext({ agents: [], projections: projectionsFor({}) })
  apply(ctx)
  assert.deepEqual([...ctx.toolsRegistry.keys()].sort(), ['fleet_inspect', 'fleet_interrupt', 'fleet_message', 'fleet_roster'])
  assert.equal(ctx.sections.length, 1)
  assert.equal(ctx.sections[0].name, 'orchestrator:role')
})

test('gates every tool to the orchestrator preset', () => {
  const ctx = makeContext({ agents: [], projections: projectionsFor({}) })
  apply(ctx)
  const orchestrator = makeAgent({ id: 'session-orch' })
  const worker = makeAgent({ id: 'session-work', preset: 'standard' })
  for (const definition of ctx.toolsRegistry.values()) {
    assert.equal(definition.when({ agent: orchestrator }), true, `${definition.name} should admit the orchestrator`)
    assert.equal(definition.when({ agent: worker }), false, `${definition.name} should reject a standard agent`)
  }
  assert.match(ctx.sections[0].text({ agent: orchestrator }), /fleet_roster/)
  assert.equal(ctx.sections[0].text({ agent: worker }), '')
})

test('roster reports status, activity, self, and running first', () => {
  const orchestrator = makeAgent({ id: 'session-orch' })
  const worker = makeAgent({ id: 'session-work', preset: 'standard', status: 'running', events: busyEvents() })
  const idle = makeAgent({ id: 'session-idle', preset: 'standard' })
  const ctx = makeContext({
    agents: [idle, worker, orchestrator],
    projections: projectionsFor({
      title: 'Auth tests',
      todos: [{ content: 'fix fixture', status: 'completed' }, { content: 'rerun', status: 'pending' }],
      goal: null,
      inbox: { 'next-turn': [], 'next-step': [] },
    }),
  })
  apply(ctx)
  const value = ctx.toolsRegistry.get('fleet_roster').execute({}, exec(orchestrator))
  assert.equal(value.total, 3)
  assert.equal(value.running, 1)
  assert.equal(value.agents[0].id, 'session-work')
  assert.equal(value.agents[0].status, 'running')
  assert.equal(value.agents[0].activity, 'running bash')
  assert.equal(value.agents[0].last_assistant, 'Running the auth tests now.')
  assert.equal(value.agents[0].open_tools[0].preview, 'pnpm test tests/auth.test.ts')
  assert.equal(value.agents[0].todos.done, 1)
  const self = value.agents.find((agent) => agent.id === 'session-orch')
  assert.equal(self.self, true)
  assert.equal(self.status, 'idle')
})

test('reads the live preset registry when the header has no preset', () => {
  const ctx = makeContext({
    agents: [],
    projections: projectionsFor({}),
    presets: { presetForSession: () => 'orchestrator' },
  })
  apply(ctx)
  const agent = makeAgent({ id: 'session-live', preset: null })
  assert.equal(agent.session.header.agentPreset, null)
  assert.equal(ctx.toolsRegistry.get('fleet_roster').when({ agent }), true)
})

test('renderers produce the model-facing summaries', () => {
  const orchestrator = makeAgent({ id: 'session-orch' })
  const worker = makeAgent({ id: 'session-work', preset: 'standard', status: 'running', events: busyEvents() })
  const ctx = makeContext({ agents: [orchestrator, worker], projections: projectionsFor({ title: 'Auth tests' }) })
  apply(ctx)
  const roster = ctx.toolsRegistry.get('fleet_roster')
  const text = roster.output.render({}, roster.execute({}, exec(orchestrator))).map((block) => block.text).join('\n')
  assert.match(text, /2 live agents/)
  assert.match(text, /\[running\] session-work "Auth tests"/)
  assert.match(text, /recent call: bash pnpm test/)
  assert.match(text, /session-orch "Auth tests" \(you\)/)

  const inspect = ctx.toolsRegistry.get('fleet_inspect')
  const detail = inspect.output.render({}, inspect.execute({ agent_id: 'session-work' }, exec(orchestrator))).map((block) => block.text).join('\n')
  assert.match(detail, /activity: running bash/)
  assert.match(detail, /recent messages:/)
})

test('roster filters by status and reports omitted rows', () => {
  const orchestrator = makeAgent({ id: 'session-orch' })
  const workers = Array.from({ length: 3 }, (_, index) => makeAgent({ id: `session-${index}`, preset: 'standard', status: 'running', events: busyEvents() }))
  const ctx = makeContext({ agents: [orchestrator, ...workers], projections: projectionsFor({}) })
  apply(ctx)
  const value = ctx.toolsRegistry.get('fleet_roster').execute({ status: 'running', limit: 2 }, exec(orchestrator))
  assert.equal(value.agents.length, 2)
  assert.equal(value.omitted, 1)
})

test('approval and user-question states are reported as waiting', () => {
  const orchestrator = makeAgent({ id: 'session-orch' })
  const approval = makeAgent({
    id: 'session-approval',
    preset: 'standard',
    status: 'running',
    events: [
      event('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"rm -rf build"}' }),
      event('approval/asked', { id: 'a1', toolName: 'bash', callId: 'c1', reason: 'destructive' }),
    ],
  })
  const question = makeAgent({
    id: 'session-question',
    preset: 'standard',
    status: 'running',
    events: [event('tool/call', { turn: 1, step: 1, callId: 'c2', name: 'ask_user_question', arguments: '{}' })],
  })
  const ctx = makeContext({ agents: [orchestrator, approval, question], projections: projectionsFor({}) })
  apply(ctx)
  const value = ctx.toolsRegistry.get('fleet_roster').execute({}, exec(orchestrator))
  assert.equal(value.agents.find((agent) => agent.id === 'session-approval').activity, 'waiting for approval: bash')
  assert.equal(value.agents.find((agent) => agent.id === 'session-question').activity, 'waiting for a user answer')
})

test('inspect returns recent messages, inbox, todos, and children', () => {
  const orchestrator = makeAgent({ id: 'session-orch' })
  const child = makeAgent({
    id: 'session-child',
    preset: 'standard',
    status: 'running',
    parent: 'session-orch',
    events: [
      event('user/message', { id: 'm1', role: 'user', content: [{ type: 'text', text: 'Fix the fixture' }], source: { kind: 'user' } }),
      ...busyEvents(),
    ],
  })
  const ctx = makeContext({
    agents: [orchestrator, child],
    projections: projectionsFor({
      title: 'Fix fixture',
      todos: [{ content: 'fix fixture', status: 'in_progress' }],
      goal: { goal: { objective: 'Green auth tests' } },
      inbox: { 'next-turn': [], 'next-step': [] },
    }),
  })
  apply(ctx)
  const value = ctx.toolsRegistry.get('fleet_inspect').execute({ agent_id: 'session-child', messages: 5 }, exec(orchestrator))
  assert.equal(value.id, 'session-child')
  assert.equal(value.is_parent, true)
  assert.equal(value.children.length, 0)
  assert.equal(value.todos[0].content, 'fix fixture')
  assert.equal(value.goal, 'Green auth tests')
  assert.equal(value.messages.at(-1).role, 'assistant')
  assert.match(value.messages.at(-1).text, /auth tests/)
})

test('injected runtime context is not reported as a human instruction', () => {
  const orchestrator = makeAgent({ id: 'session-orch' })
  const worker = makeAgent({
    id: 'session-work',
    preset: 'standard',
    status: 'idle',
    events: [
      event('user/message', { id: 'h1', role: 'user', content: [{ type: 'text', text: 'Fix the auth fixture' }], source: { kind: 'user' } }),
      event('user/message', { id: 'ctx1', role: 'user', content: [{ type: 'text', text: 'Time sampled while preparing turn 1' }], source: { kind: 'runtime-context' } }),
      event('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'Working on it.' }] }, stream: [] }),
      event('user/message', { id: 'm1', role: 'user', content: [{ type: 'text', text: 'Also check retries' }], source: { kind: 'agent-message', form: 'relay', senderSessionId: 'session-other' } }),
    ],
  })
  const ctx = makeContext({ agents: [orchestrator, worker], projections: projectionsFor({}) })
  apply(ctx)
  const roster = ctx.toolsRegistry.get('fleet_roster').execute({}, exec(orchestrator))
  assert.equal(roster.agents.find((agent) => agent.id === 'session-work').last_user, 'Also check retries')

  const detail = ctx.toolsRegistry.get('fleet_inspect').execute({ agent_id: 'session-work', messages: 10 }, exec(orchestrator))
  const texts = detail.messages.map((message) => message.text)
  assert.deepEqual(texts, ['Fix the auth fixture', 'Working on it.', 'Also check retries'])
})

test('message steers a running agent and follows up an idle one', () => {
  const orchestrator = makeAgent({ id: 'session-orch' })
  const running = makeAgent({ id: 'session-running', preset: 'standard', status: 'running' })
  const idle = makeAgent({ id: 'session-idle', preset: 'standard', status: 'idle' })
  const ctx = makeContext({ agents: [orchestrator, running, idle], projections: projectionsFor({}) })
  apply(ctx)
  const tool = ctx.toolsRegistry.get('fleet_message')

  const steered = tool.execute({ agent_id: 'session-running', message: 'stop and re-check the fixture' }, exec(orchestrator))
  assert.equal(steered.delivery, 'steer')
  assert.equal(running.received[0].via, 'steer')
  assert.equal(running.received[0].message.content[1].text, 'stop and re-check the fixture')
  assert.equal(running.received[0].message.source.senderSessionId, 'session-orch')

  const followed = tool.execute({ agent_id: 'session-idle', message: 'next task', mode: 'followup' }, exec(orchestrator))
  assert.equal(followed.delivery, 'followup')
  assert.equal(idle.received[0].via, 'followup')
})

test('message and interrupt refuse the caller itself', () => {
  const orchestrator = makeAgent({ id: 'session-orch' })
  const ctx = makeContext({ agents: [orchestrator], projections: projectionsFor({}) })
  apply(ctx)
  assert.throws(() => ctx.toolsRegistry.get('fleet_message').execute({ agent_id: 'session-orch', message: 'hi' }, exec(orchestrator)), /yourself/)
  assert.throws(() => ctx.toolsRegistry.get('fleet_interrupt').execute({ agent_id: 'session-orch' }, exec(orchestrator)), /yourself/)
})

test('message and interrupt refuse unknown agents and name the recovery tool', () => {
  const orchestrator = makeAgent({ id: 'session-orch' })
  const ctx = makeContext({ agents: [orchestrator], projections: projectionsFor({}) })
  apply(ctx)
  assert.throws(() => ctx.toolsRegistry.get('fleet_message').execute({ agent_id: 'nope', message: 'hi' }, exec(orchestrator)), /fleet_roster/)
  assert.throws(() => ctx.toolsRegistry.get('fleet_interrupt').execute({ agent_id: 'nope' }, exec(orchestrator)), /fleet_roster/)
})

test('interrupt keeps queued input unless clear_queue is set', () => {
  const orchestrator = makeAgent({ id: 'session-orch' })
  const worker = makeAgent({ id: 'session-work', preset: 'standard', status: 'running' })
  const ctx = makeContext({ agents: [orchestrator, worker], projections: projectionsFor({}) })
  apply(ctx)
  const tool = ctx.toolsRegistry.get('fleet_interrupt')

  tool.execute({ agent_id: 'session-work' }, exec(orchestrator))
  assert.deepEqual(worker.cancelled.cause, { kind: 'user' })
  assert.equal(worker.cancelled.options.keepInbox, true)

  tool.execute({ agent_id: 'session-work', clear_queue: true }, exec(orchestrator))
  assert.equal(worker.cancelled.options.keepInbox, false)
})

test('roster survives a corrupt projection read', () => {
  const orchestrator = makeAgent({ id: 'session-orch' })
  const ctx = makeContext({
    agents: [orchestrator],
    projections: {
      snapshot() {
        throw new Error('corrupt projection')
      },
    },
  })
  apply(ctx)
  const value = ctx.toolsRegistry.get('fleet_roster').execute({}, exec(orchestrator))
  assert.equal(value.total, 1)
  assert.equal(value.agents[0].title, null)
})
