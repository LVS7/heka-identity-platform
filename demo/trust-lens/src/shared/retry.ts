/**
 * Call `fn` until it succeeds or `deadline` (epoch ms) passes. For reads whose failure is transient
 * and whose caller already has a deadline — the agent's read of a session Heka just verified.
 */
export async function retryUntil<T>(fn: () => Promise<T>, deadline: number, delayMs = 2000): Promise<T> {
  for (;;) {
    try {
      return await fn()
    } catch (error) {
      if (Date.now() + delayMs > deadline) throw error
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
}
