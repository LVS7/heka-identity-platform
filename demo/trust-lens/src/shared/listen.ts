import type { Server } from 'node:http'

/**
 * Listen, or exit. Express 5 hands a listen error (EADDRINUSE, say) to the callback instead of
 * throwing, so a callback that ignores its argument prints the "listening" line while the browser
 * keeps talking to whatever already holds the port — an old process with old code and old state.
 */
export function listenOrExit(
  app: { listen(port: number, callback: (error?: Error) => void): Server },
  port: number,
  label: string,
  onReady: () => void
): Server {
  return app.listen(port, (error) => {
    if (error) {
      console.error(`[${label}] FATAL cannot listen on port ${port}: ${error.message}`)
      process.exit(1)
    }
    onReady()
  })
}
