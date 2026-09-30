/**
 * The LLM behind the chat: OpenAI through Genkit's compat-oai plugin, as the reference demo
 * (demo/a2a-oid4vp) does. Optional — without a key the chat says so and the direct calls
 * remain; the trust model does not depend on a model.
 *
 * `Llm` is the one call the chat loop needs. It hides Genkit behind a small interface so the
 * loop is unit-testable with a scripted model, and so Genkit (ESM) is imported dynamically from
 * this CommonJS process only when a key is configured.
 */

export interface LlmConfig {
  apiKey: string
  model: string
  baseUrl?: string
}

export const LLM_NOT_CONFIGURED =
  'LLM not configured — set OPENAI_API_KEY (and optionally OPENAI_MODEL, OPENAI_BASE_URL)'

/** `undefined` without a usable key; the `.env.example` placeholder does not count. */
export function llmConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LlmConfig | undefined {
  const apiKey = env.OPENAI_API_KEY
  if (!apiKey || apiKey.startsWith('your_')) return undefined
  return { apiKey, model: env.OPENAI_MODEL || 'gpt-4o-mini', baseUrl: env.OPENAI_BASE_URL || undefined }
}

export interface LlmToolDefinition {
  name: string
  description: string
  inputJsonSchema: Record<string, unknown>
}

export interface LlmToolRequest {
  name: string
  ref?: string
  input?: unknown
}

export interface LlmMessage {
  role: 'user' | 'model' | 'tool'
  content: Array<Record<string, unknown>>
}

export interface LlmTurn {
  text: string
  /** The model's message as it must be appended to the history (tool requests included). */
  message: LlmMessage
  toolRequests: LlmToolRequest[]
}

export interface Llm {
  generate(input: { system: string; messages: LlmMessage[]; tools: LlmToolDefinition[] }): Promise<LlmTurn>
}

export async function createLlm(config: LlmConfig): Promise<Llm> {
  const { genkit } = await import('genkit')
  const { openAI } = await import('@genkit-ai/compat-oai/openai')

  // OPENAI_BASE_URL is honoured by the OpenAI SDK itself; the plugin takes only the key.
  const ai = genkit({ plugins: [openAI({ apiKey: config.apiKey })], model: openAI.model(config.model) })

  return {
    async generate({ system, messages, tools }) {
      const response = await ai.generate({
        system,
        messages: messages as never,
        // Dynamic tools without an implementation: with returnToolRequests the model's requests
        // come back to the loop, which is what routes them through the MCP client and its step-up.
        tools: tools.map((tool) =>
          ai.dynamicTool({
            name: tool.name,
            description: tool.description,
            inputJsonSchema: tool.inputJsonSchema as never,
          })
        ),
        returnToolRequests: true,
      })
      const message = response.message?.toJSON() as LlmMessage | undefined
      return {
        text: response.text,
        message: message ?? { role: 'model', content: [{ text: response.text }] },
        toolRequests: response.toolRequests.map((part) => part.toolRequest),
      }
    },
  }
}
