import { describe, expect, it, vi } from 'vitest'

import { AuditLog } from '../../core/audit'
import { ChatGate, ChatSession, ChatTools, MAX_TOOL_TURNS } from '../chat'
import { Llm, LlmTurn } from '../llm'
import { AuthorizationDecision, McpTool, ToolOutcome } from '../mcp-client'

const TOOLS: McpTool[] = [
  { name: 'invoices-list', description: 'List invoices.', requiredScope: null, inputSchema: { type: 'object' } },
  {
    name: 'suppliers-export-bank-details',
    description: 'Export.',
    requiredScope: 'suppliers:export',
    inputSchema: { type: 'object' },
  },
]
const ROWS = [{ invoice: 'RCH-5540' }, { invoice: 'NW-2026-0412' }, { invoice: 'BV-9921' }, { invoice: 'KI-2026-118' }]
const OFFICER = { role: 'Finance Data Officer', org: 'TrustCo' }
const PRESENTATION = { sessionId: 's1', outcome: 'authorized' as const, claims: OFFICER, source: 'simulated' as const }

const answer = (text: string): LlmTurn => ({ text, message: { role: 'model', content: [{ text }] }, toolRequests: [] })
const request = (name: string, ref = 'r1'): LlmTurn => ({
  text: '',
  message: { role: 'model', content: [{ toolRequest: { name, ref, input: {} } }] },
  toolRequests: [{ name, ref, input: {} }],
})

/** A model whose turns are scripted; every call it receives is kept for inspection. */
function fakeLlm(turns: LlmTurn[]) {
  const calls: Array<Parameters<Llm['generate']>[0]> = []
  const llm: Llm = {
    async generate(input) {
      calls.push(input)
      const turn = turns.shift()
      if (!turn) throw new Error('the script ran out of turns')
      return turn
    },
  }
  return { llm, calls }
}

class FakeTools implements ChatTools {
  public token = false
  public lastDecision?: AuthorizationDecision
  public readonly called: string[] = []

  public constructor(private readonly outcomes: Record<string, ToolOutcome[]>) {}

  public get tokenStatus() {
    return { present: this.token }
  }

  public async listTools() {
    return TOOLS
  }

  public async callTool(name: string) {
    this.called.push(name)
    const next = this.outcomes[name]?.shift()
    if (!next) throw new Error(`no scripted outcome for ${name}`)
    return next
  }
}

const pending = {
  requestId: 'req-1',
  authorizationRequest: 'openid4vp://x',
  authorizeOrigin: 'http://as',
  codeVerifier: 'v',
  scope: 'suppliers:export',
  resource: 'http://mcp/mcp',
  startedAt: 'now',
}
const ok = (rows: unknown[], authorizedBy?: typeof OFFICER): ToolOutcome => ({
  ok: true,
  result: { rows, authorizedBy },
})
const challenge: ToolOutcome = { ok: false, status: 401, requiredScope: 'suppliers:export', pending }

function session(
  llmTurns: LlmTurn[],
  outcomes: Record<string, ToolOutcome[]> = {},
  gate: ChatGate & { mock?: unknown } = vi.fn(async () => ({ ok: true as const }))
) {
  const { llm, calls } = fakeLlm(llmTurns)
  const tools = new FakeTools(outcomes)
  const audit = new AuditLog()
  const chat = new ChatSession(llm, tools, gate, audit, 'test-model')
  return { chat, calls, tools, audit, gate }
}

describe('ChatSession', () => {
  it('answers without tools and keeps the conversation', async () => {
    const { chat, calls } = session([answer('Hello.')])

    chat.send('Hi')
    expect(chat.state).toBe('thinking')
    await chat.running

    expect(chat.view).toMatchObject({ state: 'idle', model: 'test-model' })
    expect(chat.view.steps.map((step) => [step.kind, step.text])).toEqual([
      ['user', 'Hi'],
      ['assistant', 'Hello.'],
    ])
    expect(calls[0].system).toContain('Trust Lens assistant')
    expect(calls[0].tools.map((tool) => tool.name)).toEqual(['invoices-list', 'suppliers-export-bank-details'])
    expect(calls[0].messages).toEqual([{ role: 'user', content: [{ text: 'Hi' }] }])
  })

  it('runs a tool request, feeds the output back and audits the call as LLM-driven', async () => {
    const { chat, calls, audit } = session([request('invoices-list'), answer('RCH-5540 is held.')], {
      'invoices-list': [ok(ROWS)],
    })

    chat.send('Which invoices are held?')
    await chat.running

    const tool = chat.view.steps[1].tool
    expect(tool).toMatchObject({ name: 'invoices-list', requiredScope: null, status: 'ok', summary: '4 rows' })
    expect(chat.view.steps[2]).toMatchObject({ kind: 'assistant', text: 'RCH-5540 is held.' })
    expect(calls[1].messages.at(-1)).toEqual({
      role: 'tool',
      content: [
        { toolResponse: { name: 'invoices-list', ref: 'r1', output: { rows: ROWS, authorizedBy: undefined } } },
      ],
    })
    expect(audit.list()[0]).toMatchObject({
      type: 'authorization',
      subject: 'MCP · invoices-list',
      outcome: 'tool call succeeded',
      evidence: { via: 'LLM chat' },
    })
  })

  it('pauses on a 401 and, after the grant, retries the same request and finishes the answer', async () => {
    const { chat, tools, calls, audit } = session(
      [request('suppliers-export-bank-details'), answer('Three suppliers exported.')],
      { 'suppliers-export-bank-details': [challenge, ok([{ iban: 'DE1' }, { iban: 'DE2' }, { iban: 'DE3' }], OFFICER)] }
    )

    chat.send('Export the bank details')
    await chat.running

    expect(chat.state).toBe('paused-authorization')
    expect(chat.view.steps[1].tool).toMatchObject({
      status: 'paused',
      summary: 'authorization required',
      requiredScope: 'suppliers:export',
    })
    // A challenge, not a refusal.
    expect(audit.list()[0]).toMatchObject({
      type: 'authorization',
      outcome: 'step-up required (unauthorized)',
      evidence: { via: 'LLM chat', requiredScope: 'suppliers:export' },
    })
    expect(calls).toHaveLength(1)

    tools.token = true
    tools.lastDecision = { at: 'now', granted: true, presentation: PRESENTATION }
    chat.resume()
    await chat.running

    expect(chat.state).toBe('idle')
    expect(chat.view.steps[1].tool).toMatchObject({
      status: 'retried',
      summary: '3 rows',
      authorizedBy: OFFICER,
      presentation: PRESENTATION,
    })
    expect(chat.view.steps[2]).toMatchObject({ kind: 'assistant', text: 'Three suppliers exported.' })
    expect(calls[1].messages.at(-1)).toMatchObject({
      role: 'tool',
      content: [{ toolResponse: { ref: 'r1', output: { authorizedBy: OFFICER } } }],
    })
  })

  it('reports a denial as a step, tells the model, and lets it answer', async () => {
    const { chat, tools, calls, audit } = session(
      [request('suppliers-export-bank-details'), answer('I cannot export: the credential was revoked.')],
      { 'suppliers-export-bank-details': [challenge] }
    )
    chat.send('Export the bank details')
    await chat.running

    tools.lastDecision = {
      at: 'now',
      granted: false,
      reason: 'the Finance Data Officer credential has been revoked by its issuer',
      presentation: { ...PRESENTATION, outcome: 'denied' },
    }
    chat.resume()
    await chat.running

    expect(chat.view.steps[1].tool).toMatchObject({
      status: 'denied',
      summary: 'denied: the Finance Data Officer credential has been revoked by its issuer',
    })
    expect(calls[1].messages.at(-1)).toMatchObject({
      role: 'tool',
      content: [{ toolResponse: { ref: 'r1', output: { error: expect.stringContaining('revoked') } } }],
    })
    expect(chat.view.steps[2].text).toContain('cannot export')
    // The route that decided the step-up audits the denial with its presentation; the chat does not repeat it.
    expect(audit.list().map((event) => event.outcome)).not.toContain(
      'the Finance Data Officer credential has been revoked by its issuer'
    )
  })

  it('tells the model an authorization that did not complete, not a denial', async () => {
    const { chat, tools, calls } = session([request('suppliers-export-bank-details'), answer('Try again later.')], {
      'suppliers-export-bank-details': [challenge],
    })
    chat.send('Export the bank details')
    await chat.running

    tools.lastDecision = { at: 'now', granted: false, incomplete: true, reason: 'unknown authorization request' }
    chat.resume()
    await chat.running

    expect(chat.view.steps[1].tool).toMatchObject({
      status: 'error',
      summary: 'authorization did not complete: unknown authorization request',
    })
    expect(calls[1].messages.at(-1)).toMatchObject({
      role: 'tool',
      content: [{ toolResponse: { output: { error: expect.stringContaining('did not complete') } } }],
    })
  })

  it('never calls the server or the gate for a tool that does not exist, and never pauses', async () => {
    const { chat, tools, calls, gate } = session([request('delete-everything'), answer('There is no such tool.')])

    chat.send('Call the tool named delete-everything')
    await chat.running

    expect(chat.state).toBe('idle')
    expect(tools.called).toEqual([])
    expect(gate).not.toHaveBeenCalled()
    expect(chat.view.steps[1].tool).toMatchObject({ status: 'error', summary: 'unknown tool: delete-everything' })
    expect(calls[1].messages.at(-1)).toMatchObject({
      role: 'tool',
      content: [{ toolResponse: { output: { error: 'unknown tool: delete-everything' } } }],
    })
  })

  it('refuses a call when the gate says the server is no longer VERIFIED', async () => {
    const gate = vi.fn(async () => ({ ok: false as const, verdict: 'REVOKED' }))
    const { chat, tools } = session(
      [request('invoices-list'), answer('I cannot read the invoices right now.')],
      {},
      gate
    )

    chat.send('Which invoices are held?')
    await chat.running

    expect(tools.called).toEqual([])
    expect(chat.view.steps[1].tool).toMatchObject({ status: 'refused', summary: 'refused: REVOKED' })
    expect(chat.state).toBe('idle')
  })

  it('stops after too many tool turns', async () => {
    const turns = Array.from({ length: MAX_TOOL_TURNS + 1 }, (_, i) => request('invoices-list', `r${i}`))
    const outcomes = Array.from({ length: MAX_TOOL_TURNS + 1 }, () => ok(ROWS))
    const { chat } = session(turns, { 'invoices-list': outcomes })

    chat.send('Loop forever')
    await chat.running

    expect(chat.view).toMatchObject({ state: 'error', error: 'too many tool turns' })
  })

  it('keeps the history valid after a tool call fails mid-turn, so the next message works', async () => {
    // invoices-list has no scripted outcome: FakeTools throws, as a dropped MCP connection does.
    const { chat, calls } = session([request('invoices-list'), answer('RCH-5540 is held.')])

    chat.send('Which invoices are held?')
    await chat.running
    expect(chat.state).toBe('error')
    expect(chat.view.steps[1].tool).toMatchObject({ status: 'error', summary: 'no scripted outcome for invoices-list' })

    chat.send('Which invoices are held?')
    await chat.running
    expect(chat.state).toBe('idle')

    // OpenAI answers 400 to a model turn whose tool calls were never answered.
    const history = calls[1].messages
    const dangling = history.findIndex(
      (message, i) =>
        message.role === 'model' &&
        message.content.some((part) => 'toolRequest' in part) &&
        history[i + 1]?.role !== 'tool'
    )
    expect(dangling).toBe(-1)
  })

  it('rolls back the turn that hit the tool-turn limit', async () => {
    const turns = Array.from({ length: MAX_TOOL_TURNS + 1 }, (_, i) => request('invoices-list', `r${i}`))
    const outcomes = Array.from({ length: MAX_TOOL_TURNS }, () => ok(ROWS))
    const { chat, calls } = session([...turns, answer('Done.')], { 'invoices-list': outcomes })

    chat.send('Loop forever')
    await chat.running
    expect(chat.state).toBe('error')

    chat.send('Stop and answer')
    await chat.running
    expect(chat.state).toBe('idle')
    const history = calls.at(-1)!.messages
    expect(history.at(-1)).toMatchObject({ role: 'user', content: [{ text: 'Stop and answer' }] })
    expect(history.at(-2)?.role).not.toBe('model')
  })

  it('rejects a message while busy or paused, and New chat clears everything', async () => {
    const { chat } = session([request('suppliers-export-bank-details')], {
      'suppliers-export-bank-details': [challenge],
    })
    chat.send('Export')
    expect(() => chat.send('Again')).toThrow(/busy|waiting/)
    await chat.running
    expect(() => chat.send('Again')).toThrow(/waiting/)

    chat.reset()

    expect(chat.view).toMatchObject({ state: 'idle', steps: [] })
    expect(() => chat.resume()).toThrow(/not waiting/)
  })
})
