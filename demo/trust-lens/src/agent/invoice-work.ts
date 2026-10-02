/**
 * The agent's actual work.
 *
 * An LLM is optional on purpose. This demo is about the trust model, not about generation, and
 * requiring an API key to see a credential gate would be a poor trade. With OPENAI_API_KEY set
 * the agent narrates the reconciliation; without it, it produces the same report deterministically.
 */

export const SENSITIVE_STEP = 'Preparing the payment export'

const INVOICES = [
  { supplier: 'Nordwind Logistik GmbH', invoice: 'NW-2026-0412', amount: '18 420,00 EUR', status: 'matched' },
  { supplier: 'Baumann Verpackung AG', invoice: 'BV-9921', amount: '4 095,50 EUR', status: 'matched' },
  { supplier: 'Kessler Industrieteile', invoice: 'KI-2026-118', amount: '31 780,00 EUR', status: 'matched' },
  { supplier: 'Rhein Chemie Handel', invoice: 'RCH-5540', amount: '2 310,75 EUR', status: 'held — PO mismatch' },
]

function deterministicReport(): string {
  const matched = INVOICES.filter((i) => i.status === 'matched')
  const held = INVOICES.filter((i) => i.status !== 'matched')

  const lines = INVOICES.map(
    (i) => `  ${i.invoice.padEnd(14)} ${i.supplier.padEnd(26)} ${i.amount.padStart(13)}  ${i.status}`
  )

  return [
    'Payment export prepared.',
    '',
    ...lines,
    '',
    `${matched.length} invoices cleared for payment, ${held.length} held for review.`,
    'Export authorized by a verified Finance Data Officer presentation.',
  ].join('\n')
}

export const LLM_MODEL = 'gpt-4o-mini'

/** Whether the agent narrates; the page shows this, and `/api/state` reports it. */
export function llmEnabled(): boolean {
  const key = process.env.OPENAI_API_KEY
  return Boolean(key && !key.startsWith('your_'))
}

/**
 * OpenAI's SDK waits ten minutes (with retries) by default; the operator is watching a task that has
 * already passed authorization, so after this the deterministic report is used instead.
 */
const LLM_TIMEOUT_MS = 15_000

type Genkit = ReturnType<typeof import('genkit').genkit>
let ai: Promise<Genkit> | undefined

/** One Genkit instance per process, built on first use; a failed build is retried next time. */
function getAi(): Promise<Genkit> {
  ai ??= (async () => {
    const { genkit } = await import('genkit')
    const { openAI } = await import('@genkit-ai/compat-oai/openai')
    return genkit({ plugins: [openAI()], model: openAI.model(LLM_MODEL) })
  })().catch((error: unknown) => {
    ai = undefined
    throw error
  })
  return ai
}

async function llmReport(prompt: string): Promise<string> {
  // The bound covers loading Genkit too, and the race is awaited inside the try: a timeout that
  // fires after a failure elsewhere must not become an unhandled rejection that ends the process.
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${LLM_TIMEOUT_MS / 1000}s`)), LLM_TIMEOUT_MS)
  })
  const generate = getAi().then((ai) =>
    ai.generate({
      prompt: [
        'You are a supplier invoice reconciliation agent for Acme Corp.',
        'Summarise the prepared payment export in at most 8 short lines. Be factual and plain.',
        '',
        'Reconciled invoices:',
        ...INVOICES.map((i) => `- ${i.invoice} ${i.supplier} ${i.amount} (${i.status})`),
        '',
        `Operator request: ${prompt}`,
      ].join('\n'),
    })
  )

  try {
    const { text } = await Promise.race([generate, timeout])
    return text?.trim() || deterministicReport()
  } finally {
    clearTimeout(timer)
  }
}

/** `onFallback` is told why the LLM was not used at run time; a missing key is not a fallback, it is the default. */
export async function prepareInvoiceReport(prompt: string, onFallback?: (reason: string) => void): Promise<string> {
  if (!llmEnabled()) {
    return deterministicReport()
  }

  try {
    return await llmReport(prompt)
  } catch (error) {
    const reason = (error as Error).message
    console.log(`[agent] LLM unavailable (${reason}); using the deterministic report`)
    onFallback?.(reason)
    return deterministicReport()
  }
}
