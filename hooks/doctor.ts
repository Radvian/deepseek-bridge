import { versionAtLeast } from './lib'

type Level = 'PASS' | 'WARN' | 'FAIL'
type Settings = { model: string; lean: boolean; scrub: boolean; search: boolean; hardMin: number; idleMin: number }

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g
const MIN_OPENCODE = '1.19'

async function run($: any, argv: string[], timeoutMs = 20_000, cwd?: string): Promise<{ ok: boolean; out: string }> {
  try {
    const r = await $.process.run(argv, { timeoutMs, ...(cwd ? { cwd } : {}) })
    return { ok: r.exitCode === 0, out: `${r.stdout ?? ''}${r.stderr ? `\n${r.stderr}` : ''}`.replace(ANSI, '').trim() }
  } catch (err) {
    return { ok: false, out: err instanceof Error ? err.message : String(err) }
  }
}

// A checklist an agent can act on line by line. Nothing here spends money unless `live` is true.
export async function runDoctor($: any, cfg: Settings, live: boolean, cwd: string, home: string): Promise<string> {
  const lines: { level: Level; name: string; detail: string; fix?: string }[] = []
  const add = (level: Level, name: string, detail: string, fix?: string) => lines.push({ level, name, detail, fix })

  const ver = await run($, ['opencode', '--version'])
  const version = ver.out.split('\n').pop()?.trim() ?? ''
  if (!ver.ok) add('FAIL', 'opencode installed', 'the `opencode` command was not found or did not run', 'Install opencode from https://opencode.ai, then restart Claude Code so its PATH includes it.')
  else if (!versionAtLeast(version, MIN_OPENCODE)) add('FAIL', 'opencode version', `${version} is older than ${MIN_OPENCODE}`, 'Run `opencode upgrade` in a terminal.')
  else add('PASS', 'opencode', version)

  if (ver.ok) {
    const auth = await run($, ['opencode', 'auth', 'list'])
    const viaEnv = (await run($, ['sh', '-c', '[ -n "$DEEPSEEK_API_KEY" ]'], 5000)).ok
    if (/●\s+DeepSeek/i.test(auth.out) || viaEnv) add('PASS', 'DeepSeek sign-in', viaEnv ? 'DEEPSEEK_API_KEY is set' : 'a DeepSeek credential is saved in opencode')
    else add('FAIL', 'DeepSeek sign-in', 'no DeepSeek credential found in opencode', 'The user runs `opencode auth login` in a terminal and chooses DeepSeek. Do not enter keys on their behalf.')

    const models = await run($, ['opencode', 'models', 'deepseek'])
    if (models.ok && models.out.split('\n').some(l => l.trim() === cfg.model)) add('PASS', 'model available', cfg.model)
    else add('WARN', 'model available', `${cfg.model} was not in opencode's DeepSeek model list`, 'Run `opencode models deepseek`, then set the `model` setting to one of them.')
  }

  try {
    const verdict = await $.tool.check({ tool: 'mcp__deepseek-bridge__implement', input: { task: 'doctor' } })
    if (verdict.decision === 'allow') add('PASS', 'permission to delegate', 'Claude Code allows the implement tool without asking')
    else add('WARN', 'permission to delegate', `Claude Code would ${verdict.decision ?? 'ask'} on every call`, 'For unattended runs the user adds "mcp__deepseek-bridge__implement" (and help, doctor) to permissions.allow in settings. Do not edit their settings yourself.')
  } catch {
    add('WARN', 'permission to delegate', 'could not ask Claude Code for the permission decision')
  }

  try {
    const st = await $.settings.read()
    if (st?.sandbox?.enabled) add('WARN', 'Bash sandbox', 'the sandbox is enabled, so acceptance_cmd will be refused', 'Run the check yourself after each call, or ask the user about the sandbox.')
  } catch {
    /* unreadable settings are not a finding */
  }

  const inGit = await run($, ['git', 'rev-parse', '--is-inside-work-tree'], 10_000, cwd)
  if (!inGit.ok) add('WARN', 'git repository', `${cwd} is not inside a git repository`, 'Delegate from a git repository so the diff can be reviewed and undone.')
  else {
    const branch = (await run($, ['git', 'branch', '--show-current'], 10_000, cwd)).out
    const dirty = (await run($, ['git', 'status', '--short'], 10_000, cwd)).out.split('\n').filter(Boolean).length
    add('PASS', 'git repository', `branch ${branch || '(detached)'}`)
    if (/^(main|master)$/.test(branch)) add('WARN', 'branch', `on ${branch}`, 'Prefer a branch or worktree dedicated to the delegated work.')
    if (dirty > 0) add('WARN', 'working tree', `${dirty} uncommitted change(s) will be mixed with the implementer's edits`, 'Commit or stash first so the diff shows only its work.')
  }

  const awake = await run($, ['which', 'caffeinate'], 5000)
  add(awake.ok ? 'PASS' : 'WARN', 'keep-awake', awake.ok ? 'caffeinate keeps a Mac awake during runs' : 'caffeinate not found; a laptop may sleep during a long run (fine on servers)')

  try {
    await $.fs.write(`${home}/.claude/deepseek-bridge/runs/.doctor`, 'ok')
    add('PASS', 'log directory', `${home}/.claude/deepseek-bridge/runs is writable`)
  } catch {
    add('FAIL', 'log directory', `cannot write under ${home}/.claude/deepseek-bridge/runs`, 'Check the permissions of ~/.claude.')
  }

  add('PASS', 'settings', `model ${cfg.model}; limit ${cfg.hardMin} min; stall ${cfg.idleMin} min; env scrub ${cfg.scrub ? 'on' : 'off'}; web search ${cfg.search ? 'on' : 'off'}; opencode MCP ${cfg.lean ? 'off' : 'on'}`)

  if (live) {
    const r = await run($, ['opencode', 'run', '--pure', '--auto', '--format', 'json', '-m', cfg.model, 'Reply with the single word OK. Use no tools.'], 120_000, cwd)
    const said = r.out.split('\n').some(l => {
      try {
        const j = JSON.parse(l)
        return j.type === 'text' && /\bOK\b/i.test(String(j.part?.text ?? ''))
      } catch {
        return false
      }
    })
    if (said) add('PASS', 'live request', `${cfg.model} answered`)
    else add('FAIL', 'live request', `${cfg.model} did not answer: ${r.out.split('\n').slice(-2).join(' ').slice(0, 200)}`, 'Check the DeepSeek key and balance, and `opencode upgrade`.')
  } else add('PASS', 'live request', 'skipped (call doctor with live: true to send one tiny real request, about $0.003)')

  const out = lines.map(l => `${l.level.padEnd(4)} ${l.name}: ${l.detail}${l.fix ? `\n     Fix: ${l.fix}` : ''}`)
  const fails = lines.filter(l => l.level === 'FAIL').length
  const warns = lines.filter(l => l.level === 'WARN').length
  out.push('', fails ? `NOT READY: fix the ${fails} FAIL line(s) above, then run doctor again.` : `READY${warns ? ` (${warns} warning(s) to consider)` : ''}. Next: read the guide with mcp__deepseek-bridge__help.`)
  return `deepseek-bridge doctor\n${out.join('\n')}`
}
