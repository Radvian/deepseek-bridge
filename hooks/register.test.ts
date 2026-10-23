import { test, expect } from 'claude-code/testing'
import { register } from './register'

test('implement rejects an empty task', async ($, on) => {
  register(on, {})
  const res = await $.tool.call({ tool: 'mcp__deepseek-bridge__implement', task: '  ' })
  expect(res.deny).toContain('required')
})

test('implement refuses non-deepseek providers', async ($, on) => {
  register(on, {})
  const res = await $.tool.call({ tool: 'mcp__deepseek-bridge__implement', task: 'x', model: 'openrouter/deepseek/deepseek-chat' })
  expect(res.deny).toContain('refused')
})
