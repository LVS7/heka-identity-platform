import { describe, expect, it } from 'vitest'

import { retryUntil } from '../retry'

describe('retryUntil', () => {
  it('returns the first success', async () => {
    let calls = 0
    const value = await retryUntil(
      async () => {
        if (++calls < 3) throw new Error('flaky')
        return calls
      },
      Date.now() + 1000,
      1
    )
    expect(value).toBe(3)
  })

  it('rethrows the last error once the deadline has passed', async () => {
    await expect(
      retryUntil(
        async () => {
          throw new Error('down')
        },
        Date.now() + 20,
        5
      )
    ).rejects.toThrow('down')
  })
})
