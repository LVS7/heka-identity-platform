import { describe, expect, it } from 'vitest'

import { AgentJournal } from '../journal'

describe('AgentJournal', () => {
  it('stamps an id and a time and lists newest first', () => {
    const journal = new AgentJournal()
    const first = journal.record({ type: 'channel.open', text: 'open' })
    const second = journal.record({ type: 'task.state', taskId: 't1', contextId: 'c1', text: 'submitted' })

    expect(first.id).toMatch(/[0-9a-f-]{36}/)
    expect(Date.parse(first.at)).not.toBeNaN()
    expect(journal.list().map((event) => event.id)).toEqual([second.id, first.id])
    expect(journal.list()[0]).toMatchObject({ type: 'task.state', taskId: 't1', contextId: 'c1' })
  })

  it('returns only what came after `since`, and everything when the id is unknown', () => {
    const journal = new AgentJournal()
    const a = journal.record({ type: 'task.state', text: 'a' })
    const b = journal.record({ type: 'task.state', text: 'b' })
    const c = journal.record({ type: 'task.state', text: 'c' })

    expect(journal.list({ since: a.id }).map((event) => event.text)).toEqual(['c', 'b'])
    expect(journal.list({ since: c.id })).toEqual([])
    expect(journal.list({ since: 'gone' }).map((event) => event.text)).toEqual(['c', 'b', 'a'])
    expect(journal.list({ limit: 2 }).map((event) => event.text)).toEqual(['c', 'b'])
    expect(journal.list({ since: a.id, limit: 1 }).map((event) => event.text)).toEqual(['c'])
    expect(b.text).toBe('b')
  })

  it('drops the oldest entries past its capacity', () => {
    const journal = new AgentJournal(3)
    for (const text of ['1', '2', '3', '4', '5']) journal.record({ type: 'task.state', text })

    expect(journal.size).toBe(3)
    expect(journal.list().map((event) => event.text)).toEqual(['5', '4', '3'])
  })
})
