import { test, expect } from 'claude-code/testing'
import { renderConversation, ingest, newRun, isDeepseekModel, reconcileRows, tailClip, HELP_TOPICS, stripFrontmatter, versionAtLeast, TOOL } from './lib'

test('conversation strips reminders and clips tool results', async () => {
  const out = renderConversation([
    { role: 'user', text: 'fix the bug <system-reminder>userEmail: x@y.z</system-reminder>' },
    { role: 'assistant', text: 'looking', toolUses: [{ tool: 'Read', input: { file_path: '/a.ts' }, text: 'x'.repeat(5000) }] },
    { role: 'assistant', text: '', toolUses: [{ tool: TOOL, input: { task: 'do it' } }] },
  ])
  expect(out).toContain('fix the bug')
  expect(out).not.toContain('x@y.z')
  expect(out).toContain('[Read] /a.ts')
  expect(out).toContain('+3500 chars')
  expect(out).not.toContain('do it')
})

test('long history keeps head and tail', async () => {
  const msgs = Array.from({ length: 400 }, (_, i) => ({ role: 'user' as const, text: `m${i} ${'y'.repeat(1000)}` }))
  const out = renderConversation(msgs)
  expect(out).toContain('middle history omitted')
  expect(out).toContain('m0 ')
  expect(out).toContain('m399 ')
})

test('resume renders only the delta', async () => {
  const out = renderConversation([{ role: 'user', text: 'old' }, { role: 'user', text: 'new' }], 1)
  expect(out).toContain('new')
  expect(out).not.toContain('old')
})

test('opencode json events are folded into a run', async () => {
  const run = newRun()
  for (const l of [
    '{"type":"step_start","sessionID":"ses_1","part":{}}',
    '{"type":"tool_use","sessionID":"ses_1","part":{"tool":"write","state":{"status":"completed","input":{"filePath":"/p/a.txt"}}}}',
    '{"type":"text","sessionID":"ses_1","part":{"text":"done"}}',
    '{"type":"step_finish","sessionID":"ses_1","part":{"tokens":{"input":10,"output":2},"cost":0.5}}',
    'not json',
  ]) ingest(run, l)
  expect(run.sessionId).toBe('ses_1')
  expect(run.actions).toEqual(['write /p/a.txt'])
  expect(run.texts).toEqual(['done'])
  expect([run.tokensIn, run.tokensOut, run.cost]).toEqual([10, 2, 0.5])
})

test('only the deepseek provider is accepted', async () => {
  expect(isDeepseekModel('deepseek/deepseek-flash')).toBe(true)
  expect(isDeepseekModel('openrouter/deepseek/deepseek-chat')).toBe(false)
  expect(isDeepseekModel('deepseek/x; rm -rf')).toBe(false)
})

test('a run is rebuilt from opencode database rows', async () => {
  const msgs = [
    { id: 'm0', time_created: 1, data: JSON.stringify({ role: 'user' }) },
    { id: 'm1', session_id: 'ses_x', time_created: 2, data: JSON.stringify({ role: 'assistant', tokens: { input: 10, output: 2 }, cost: 0.25, finish: 'tool-calls', time: { completed: 3 } }) },
    { id: 'm2', time_created: 4, data: JSON.stringify({ role: 'assistant', tokens: { input: 5, output: 1 }, cost: 0.5, finish: 'stop', time: { completed: 6 } }) },
  ]
  const parts = [
    { message_id: 'm1', type: 'tool', tool: 'write', input: JSON.stringify({ filePath: '/p/a.css' }), text: null },
    { message_id: 'm2', type: 'text', tool: null, input: null, text: 'Step done.' },
    { message_id: 'm0', type: 'text', tool: null, input: null, text: 'a user prompt that must be ignored' },
  ]
  const r = reconcileRows(msgs, parts)!
  expect(r.sessionId).toBe('ses_x')
  expect(r.actions).toEqual(['write /p/a.css'])
  expect(r.texts).toEqual(['Step done.'])
  expect([r.tokensIn, r.tokensOut, r.cost, r.isComplete]).toEqual([15, 3, 0.75, true])
  expect(reconcileRows([{ id: 'm0', data: JSON.stringify({ role: 'user' }) }], [])).toBeUndefined()
})

test('a later step or tool call cancels an earlier stop', async () => {
  const run = newRun()
  ingest(run, '{"type":"step_finish","sessionID":"s","part":{"reason":"stop","tokens":{},"cost":0}}')
  expect(run.isDone).toBe(true)
  ingest(run, '{"type":"step_start","sessionID":"s","part":{}}')
  expect(run.isDone).toBe(false)
  ingest(run, '{"type":"step_finish","sessionID":"s","part":{"reason":"stop","tokens":{},"cost":0}}')
  ingest(run, '{"type":"tool_use","sessionID":"s","part":{"tool":"bash","state":{"input":{"command":"ls"}}}}')
  expect(run.isDone).toBe(false)
})

test('tailClip keeps the end', async () => {
  expect(tailClip('abcdef', 3)).toContain('def')
  expect(tailClip('abcdef', 3)).not.toContain('abc')
  expect(tailClip('abc', 3)).toBe('abc')
})

test('help topics point at the guide files, and versions compare numerically', async () => {
  expect(Object.keys(HELP_TOPICS)).toEqual(['overview', 'recipes', 'security', 'troubleshooting', 'install'])
  expect(HELP_TOPICS.overview).toBe('SKILL.md')
  expect(stripFrontmatter('---\nname: x\ndescription: y\n---\n# Title\nbody')).toBe('# Title\nbody')
  expect(stripFrontmatter('# no frontmatter')).toBe('# no frontmatter')
  expect(versionAtLeast('1.19.4', '1.19')).toBe(true)
  expect(versionAtLeast('1.9.0', '1.19')).toBe(false)
  expect(versionAtLeast('v2.0', '1.19.9')).toBe(true)
  expect(versionAtLeast('1.19', '1.19.1')).toBe(false)
})
