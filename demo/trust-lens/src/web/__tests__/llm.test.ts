import { describe, expect, it } from 'vitest'

import { llmConfigFromEnv } from '../llm'

describe('llmConfigFromEnv', () => {
  it('is undefined without a key or with the example placeholder', () => {
    expect(llmConfigFromEnv({})).toBeUndefined()
    expect(llmConfigFromEnv({ OPENAI_API_KEY: 'your_api_key_here' })).toBeUndefined()
  })

  it('defaults the model and passes the base URL through', () => {
    expect(llmConfigFromEnv({ OPENAI_API_KEY: 'sk-x' })).toEqual({
      apiKey: 'sk-x',
      model: 'gpt-4o-mini',
      baseUrl: undefined,
    })
    expect(
      llmConfigFromEnv({ OPENAI_API_KEY: 'sk-x', OPENAI_MODEL: 'gpt-4o', OPENAI_BASE_URL: 'http://llm.test/v1' })
    ).toEqual({
      apiKey: 'sk-x',
      model: 'gpt-4o',
      baseUrl: 'http://llm.test/v1',
    })
  })
})
