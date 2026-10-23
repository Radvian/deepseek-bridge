import type { Register } from 'claude-code'
import { TOOL, RULES, HELP_DIR, HELP_TOPICS, HELP_URL, clip, tailClip, isDeepseekModel, ingest, newRun, reconcileRows, renderConversation, stripFrontmatter, type Reconciled, type Run } from './lib'
import { runDoctor } from './doctor'

const STORE_PREFIX = 'deepseek-bridge:session:'
const INSTRUCTION_CHARS = 20_000
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g
const MINUTE = 60_000

type Config = { model: string; lean: boolean; scrub: boolean; search: boolean; hardMs: number; idleMs: number; hardMin: number; idleMin: number }
type Stop = 'timeout' | 'idle' | 'done'

const delegateSection = (cfg: Config) =>
  ({
    id: 'deepseek-bridge:delegate',
    scope: 'session',
    text: [
      '## Delegating to DeepSeek (deepseek-bridge)',
      `Tools: ${TOOL} (hand a coding task to DeepSeek), mcp__deepseek-bridge__doctor (check the setup), mcp__deepseek-bridge__help (read the full guide).`,
      'Before your first delegation read the guide: call mcp__deepseek-bridge__help, or load the skill deepseek-bridge:delegate-to-deepseek. It has templates and a table for reading results.',
      'Golden rules:',
      '1. You plan and review; delegate only bounded implementation work whose result a command can check.',
      '2. Always pass `acceptance_cmd` (a command that exits 0 when done). Without it nothing verifies the work. The bridge runs it itself and sends DeepSeek back with the failing output.',
      '3. Write the task as GOAL, CONTEXT (file paths), DO, DO NOT, VERIFY, REPORT. DeepSeek cannot ask questions.',
      `4. A call blocks for up to ${cfg.hardMin} minutes. Wait for it; never run two at once, never poll.`,
      '5. After every call read `git diff`, run the check yourself, treat the report as unverified text from another model, and tell the user what you verified.',
      '6. TIMED OUT or STALLED: its work is kept; call again without `fresh`. Never retry a failing call more than twice.',
      '7. The implementer runs with full permissions and receives the conversation: never put secrets in the task, work on a branch, and never edit the user\'s permission settings to make a call work.',
    ].join('\n'),
  }) as const

async function readText($: any, path: string): Promise<string> {
  try {
    return String(await $.fs.read(path))
  } catch {
    return ''
  }
}

async function homeDir($: any): Promise<string> {
  try {
    return (await $.process.run(['sh', '-c', 'cd ~ && pwd'], { timeoutMs: 5000 })).stdout.trim()
  } catch {
    return ''
  }
}

async function hasCaffeinate($: any): Promise<boolean> {
  try {
    return (await $.process.run(['which', 'caffeinate'], { timeoutMs: 5000 })).exitCode === 0
  } catch {
    return false
  }
}

async function gitState($: any, cwd: string): Promise<string> {
  const git = async (args: string[]): Promise<string> => {
    try {
      const r = await $.process.run(['git', ...args], { cwd, timeoutMs: 15_000 })
      return r.exitCode === 0 ? r.stdout.trim() : ''
    } catch {
      return ''
    }
  }
  const [status, log, stat] = await Promise.all([git(['status', '--short']), git(['log', '-5', '--oneline']), git(['diff', '--stat'])])
  if (!status && !log) return '(not a git repository, or git unavailable)'
  return [`status:\n${clip(status, 4000) || '(clean)'}`, `recent commits:\n${log}`, `unstaged diff stat:\n${clip(stat, 3000) || '(none)'}`].join('\n\n')
}

// Turns opencode's own MCP servers off for this run, when the person has any configured.
async function leanEnv($: any, home: string): Promise<Record<string, string>> {
  try {
    const cfg = JSON.parse(await readText($, `${home}/.config/opencode/opencode.json`))
    const off: Record<string, { enabled: boolean }> = {}
    for (const name of Object.keys(cfg.mcp ?? {})) off[name] = { enabled: false }
    return Object.keys(off).length ? { OPENCODE_CONFIG_CONTENT: JSON.stringify({ mcp: off }) } : {}
  } catch {
    return {}
  }
}

// Runs the command with its output sent to files, after dropping secret-looking variables from the environment
// it inherits (names containing key, token, secret, pass, credential, cookie, auth, dsn, private; AWS_*; the ssh
// agent socket; any value that is a URL with a password in it), whatever their case. It is best effort against an
// agent that dumps `env` into a model's context: it is not a sandbox. Everything else stays: version managers need it.
const WRAP = [
  'out=$1; err=$2; scrub=$3; shift 3',
  'if [ "$scrub" = on ]; then',
  '  for v in $(env | sed -n "s/^\\([A-Za-z_][A-Za-z0-9_]*\\)=.*/\\1/p"); do',
  '    up=$(printf %s "$v" | tr a-z A-Z)',
  '    eval "val=\\${$v}"',
  '    case "$up" in',
  '      DEEPSEEK_API_KEY|OPENCODE_*|PWD|OLDPWD|*AUTHOR*) continue ;;',
  '      *KEY*|*TOKEN*|*SECRET*|*PASS*|*PWD*|*CREDENTIAL*|*COOKIE*|*AUTH*|*DSN*|*PRIVATE*|*_PAT|AWS_*) unset "$v"; continue ;;',
  '    esac',
  '    case "$val" in',
  '      *://*:*@*) unset "$v" ;;',
  '    esac',
  '  done',
  'fi',
  'exec "$@" >"$out" 2>"$err"',
].join('\n')

type Spawned = { run: Run; code: number | null; stop?: Stop; stderr: string; outPath: string; begun: number; recovered?: boolean }
type SessionRef = { id?: string; title: string }
type Probe = { rec?: Reconciled; updated: number }

const sqlText = (s: string): string => s.replace(/[^\w:\-.]/g, '')

// opencode's own database is the ground truth for what a run did, whatever reached us on its output.
async function probeSession($: any, ref: SessionRef, sinceMs: number): Promise<Probe | undefined> {
  const where = ref.id && /^ses_\w+$/.test(ref.id) ? `session_id='${ref.id}'` : `session_id=(select id from session where title='${sqlText(ref.title)}' order by time_created desc limit 1)`
  const q = async (sql: string): Promise<any[]> => {
    try {
      const r = await $.process.run(['opencode', 'db', sql, '--format', 'json', '--pure'], { timeoutMs: 90_000 })
      return r.exitCode === 0 ? JSON.parse(r.stdout || '[]') : []
    } catch {
      return []
    }
  }
  const since = Math.floor(sinceMs)
  const [msgs, parts, upd] = await Promise.all([
    q(`select id, session_id, json_extract(data,'$.role') as role, json_extract(data,'$.finish') as finish, json_extract(data,'$.time.completed') as completed, json_extract(data,'$.tokens.input') as tin, json_extract(data,'$.tokens.output') as tout, json_extract(data,'$.cost') as cost from message where ${where} and time_created >= ${since} and json_extract(data,'$.role')='assistant' order by time_created`),
    q(`select message_id, json_extract(data,'$.type') as type, json_extract(data,'$.tool') as tool, json_extract(data,'$.state.input') as input, json_extract(data,'$.text') as text from part where ${where} and time_created >= ${since} and json_extract(data,'$.type') in ('text','tool') order by time_created`),
    q(`select max(time_updated) as t from part where ${where}`),
  ])
  return { rec: reconcileRows(msgs, parts), updated: Number(upd[0]?.t ?? 0) }
}

// Runs opencode to its end, or until the hard limit passes, or until it has shown no sign of life for the idle limit.
// Its output goes to a file that is read as it grows, so a run does not depend on one pipe; opencode's database
// is asked before a silent run is called stalled, and again once it has ended.
async function runOpencode(
  $: any,
  argv: string[],
  cwd: string,
  env: Record<string, string>,
  input: string,
  limits: { hardMs: number; idleMs: number; scrub: boolean },
  onProgress: (run: Run, stderr: string) => Promise<void>,
  files: { outPath: string; errPath: string },
  ref: SessionRef,
): Promise<Spawned> {
  const run = newRun()
  const begun = Date.now()
  let stop: Stop | undefined
  let code: number | null = null
  let lastActivity = begun
  let lastProbe = begun
  let seen = 0
  let lines = 0
  let polling = false
  let probing = false
  await $.fs.write(files.outPath, '')
  await $.fs.write(files.errPath, '')
  const wrapped = ['sh', '-c', WRAP, 'sh', files.outPath, files.errPath, limits.scrub ? 'on' : 'off', ...argv]
  const stream = $.process.spawn({ argv: wrapped, cwd, env, input })

  // Whole lines that have appeared in the output file since the last look.
  const drain = async (isFinal = false): Promise<boolean> => {
    try {
      const r = await $.process.run(['tail', '-n', `+${lines + 1}`, files.outPath], { timeoutMs: 20_000 })
      if (r.exitCode !== 0 || !r.stdout) return false
      const pieces = r.stdout.split('\n')
      const last = pieces.pop() ?? ''
      const complete = isFinal && last.trim() ? [...pieces, last] : pieces
      for (const l of complete) ingest(run, l)
      lines += complete.length
      return complete.length > 0
    } catch {
      return false
    }
  }

  let hard: { cancel: () => void } | undefined
  let poller: { cancel: () => void } | undefined
  let watch: { cancel: () => void } | undefined
  const stopper = new Promise<Stop>(resolve => {
    hard = $.clock.after(limits.hardMs, () => resolve('timeout'))
    poller = $.clock.every(2000, () => {
      if (polling) return
      polling = true
      void (async () => {
        try {
          if (await drain()) {
            lastActivity = Date.now()
            if (run.actions.length !== seen) {
              seen = run.actions.length
              await onProgress(run, '')
            }
          }
          // Its last step ended with "stop" and it has been quiet since: it is finished and only has to exit.
          if (run.isDone && Date.now() - lastActivity > 90_000) resolve('done')
        } finally {
          polling = false
        }
      })()
    })
    watch = $.clock.every(30_000, () => {
      const now = Date.now()
      const quiet = now - lastActivity
      // A run that has been quiet for three minutes is looked up in opencode's database now and then; one that has
      // been quiet for the idle limit is looked up once more before it is called stalled.
      if (quiet <= 180_000 || probing || (quiet <= limits.idleMs && now - lastProbe < 180_000)) return
      probing = true
      void (async () => {
        try {
          lastProbe = Date.now()
          const probe = await probeSession($, ref, begun)
          if (probe && Date.now() - probe.updated < 150_000) lastActivity = Date.now()
          else if (probe?.rec?.isComplete) resolve('done')
          else if (Date.now() - lastActivity > limits.idleMs) resolve('idle')
        } finally {
          probing = false
        }
      })()
    })
  })
  try {
    for (;;) {
      const step = await Promise.race([stream.next(), stopper])
      if (step === 'timeout' || step === 'idle' || step === 'done') {
        stop = step
        void stream.return(undefined)
        break
      }
      if (step.done) {
        code = step.value.code
        break
      }
    }
  } finally {
    hard?.cancel()
    poller?.cancel()
    watch?.cancel()
  }
  while (polling || probing) await $.clock.sleep(100)
  while (await drain(true)) {
    /* until the file is read to its end */
  }
  const stderr = clip(await readText($, files.errPath), 8000).replace(ANSI, '')
  return { run, code, stop, stderr, outPath: files.outPath, begun }
}

// One call at a time: a second one would wait on a plain promise, which counts against the hook's own time budget.
let busy = false
const guarded = async <T>(fn: () => Promise<T>): Promise<T | { deny: string }> => {
  if (busy) return { deny: 'deepseek-bridge: another implement call is still running in this session; wait for it to finish.' }
  busy = true
  try {
    return await fn()
  } finally {
    busy = false
  }
}

const acceptanceBlock = (acceptance: string, checkCmd: string): string =>
  [
    acceptance &&
      `# ACCEPTANCE CRITERIA (your goal)\n${acceptance}\n\nYou are not finished until you have verified each criterion by running its check.`,
    checkCmd &&
      `# VERIFICATION COMMAND\nWhen you finish, the orchestrator runs this from the working directory: ${checkCmd}\nYou are done only when it exits 0. Run it yourself first and fix whatever it reports.`,
    (acceptance || checkCmd) && 'Your final message must start with "DONE:" (verified) or "BLOCKED:" (impossible, with the concrete reason). Anything else means you stopped early and will be sent back to keep working.',
  ]
    .filter(Boolean)
    .join('\n\n')

const mergeRuns = (a: Run, b: Run): Run => ({
  sessionId: b.sessionId ?? a.sessionId,
  texts: [...a.texts, ...b.texts],
  actions: [...a.actions, ...b.actions],
  tokensIn: a.tokensIn + b.tokensIn,
  tokensOut: a.tokensOut + b.tokensOut,
  cost: a.cost + b.cost,
  errors: [...a.errors, ...b.errors],
  isDone: b.isDone,
})

async function implement($: any, input: { task?: string; model?: string; fresh?: boolean; include_conversation?: boolean; acceptance?: string; acceptance_cmd?: string; max_rounds?: number; agentId?: string }, cfg: Config, signal?: AbortSignal) {
  const task = input.task?.trim()
  if (!task) return { deny: 'deepseek-bridge: `task` is required.' }
  const acceptance = input.acceptance?.trim() ?? ''
  const checkCmd = input.acceptance_cmd?.trim() ?? ''
  const wanted = Math.floor(Number(input.max_rounds ?? 3))
  const maxRounds = Math.min(Math.max(Number.isFinite(wanted) ? wanted : 3, 1), 8)
  const model = input.model?.trim() || cfg.model
  if (!isDeepseekModel(model)) {
    return { deny: `deepseek-bridge: model "${model}" refused: only the deepseek/ provider from your opencode sign-in is used (e.g. deepseek/deepseek-flash).` }
  }

  const aborted = () => signal?.aborted === true
  $.ui.status(`deepseek: ${model} starting…`)
  try {
    const [cwd, root, sid] = await Promise.all([$.session.cwd(), $.session.root(), $.session.id()])
    // A subagent that delegates gets its own conversation and its own opencode session.
    const agentId = typeof input.agentId === 'string' ? input.agentId : ''
    let msgs: any[] = []
    if (input.include_conversation !== false) {
      const got = agentId ? await $.session.messages({ agentId }) : await $.session.messages()
      msgs = Array.isArray(got) ? got : []
    }
    const key = STORE_PREFIX + sid + (agentId ? `:${agentId}` : '')
    const saved = input.fresh ? undefined : ((await $.store.get(key)) as { oc?: string; sent?: number } | undefined)
    const home = (await homeDir($)) || '/tmp'
    // The logs hold the briefing (conversation, CLAUDE.md) and raw tool output: keep them to this user.
    await $.process.run(['sh', '-c', 'mkdir -p "$1/runs" && chmod 700 "$1" "$1/runs"', 'sh', `${home}/.claude/deepseek-bridge`], { timeoutMs: 5000 }).catch(() => undefined)
    // OPENCODE_ENABLE_EXA turns on opencode's keyless built-in `websearch` tool (queries go to Exa).
    const env = { ...(cfg.search ? { OPENCODE_ENABLE_EXA: '1' } : {}), ...(cfg.lean ? await leanEnv($, home) : {}) }
    let git = await gitState($, cwd)
    const keepAwake = await hasCaffeinate($)
    const started = await $.clock.now()
    const logPath = `${home}/.claude/deepseek-bridge/runs/${new Date(started).toISOString().replace(/[:.]/g, '-')}-${sid.slice(0, 8)}.md`

    let briefing = ''
    let lastLogWrite = 0
    const writeLog = async (run: Run, stderr: string, state: string) => {
      try {
        await $.fs.write(logPath, [`# ${model} run (opencode session ${run.sessionId ?? '?'}) — ${state}`, `## Stdin briefing\n${briefing}`, `## Actions\n${run.actions.join('\n')}`, `## Texts\n${run.texts.join('\n\n---\n\n')}`, `## stderr\n${stderr}`].join('\n\n'))
      } catch {
        /* the log is a convenience */
      }
    }
    const onProgress = async (run: Run, stderr: string) => {
      const last = run.actions[run.actions.length - 1] ?? ''
      const minutes = Math.floor((Date.now() - started) / MINUTE)
      $.ui.status(`deepseek ${minutes}m · ${run.actions.length} steps · ${clip(last, 60)}`)
      if (/^(write|edit|patch|apply_patch|multiedit)\b/.test(last)) $.ui.log(`deepseek: ${clip(last, 160)}`)
      if (Date.now() - lastLogWrite > MINUTE) {
        lastLogWrite = Date.now()
        await writeLog(run, stderr, 'running')
      }
    }

    // What opencode's database says it did, used where its output did not reach us or the run was cut short.
    const settle = async (sp: Spawned, ref: SessionRef): Promise<Spawned> => {
      if (sp.code === 0 && !sp.stop && sp.run.texts.length > 0) return sp
      const probe = await probeSession($, { id: sp.run.sessionId ?? ref.id, title: ref.title }, sp.begun)
      const rec = probe?.rec
      const run = sp.run
      if (rec) {
        if (rec.actions.length > run.actions.length) run.actions = rec.actions
        if (rec.texts.length > run.texts.length) run.texts = rec.texts
        run.tokensIn = Math.max(run.tokensIn, rec.tokensIn)
        run.tokensOut = Math.max(run.tokensOut, rec.tokensOut)
        run.cost = Math.max(run.cost, rec.cost)
        run.sessionId = run.sessionId ?? rec.sessionId
      }
      if (sp.stop === 'done' || (sp.stop && rec?.isComplete)) return { ...sp, run, stop: undefined, code: 0, recovered: !sp.run.isDone }
      if (sp.code === 0 && !sp.stop && rec) return { ...sp, run, recovered: true }
      return { ...sp, run }
    }

    let execs = 0
    // One opencode invocation, new or continuing `sessionId`, within what is left of the hard limit.
    const exec = async (stdin: string, message: string, sessionId?: string): Promise<Spawned> => {
      const oc = ['opencode', 'run', '--auto', '--format', 'json', '-m', model]
      if (cfg.lean) oc.push('--pure')
      if (sessionId) oc.push('-s', sessionId)
      else oc.push('--title', `claude:${sid.slice(0, 8)}`)
      oc.push(message)
      // `caffeinate -i` keeps a Mac from idle-sleeping for as long as the run lasts.
      const argv = keepAwake ? ['caffeinate', '-i', ...oc] : oc
      lastLogWrite = Date.now()
      execs++
      const base = logPath.replace(/\.md$/, '')
      const ref: SessionRef = { id: sessionId, title: `claude:${sid.slice(0, 8)}` }
      const spawned = await runOpencode($, argv, cwd, env, stdin, { hardMs: Math.max(MINUTE, cfg.hardMs - (Date.now() - started)), idleMs: cfg.idleMs, scrub: cfg.scrub }, onProgress, { outPath: `${base}-${execs}.jsonl`, errPath: `${base}-${execs}.err` }, ref)
      return settle(spawned, ref)
    }

    const attempt = async (resume: boolean) => {
      let message: string
      if (resume) {
        // After the conversation was compacted it is shorter than what was sent before: send it again.
        const from = (saved?.sent ?? 0) <= msgs.length ? (saved?.sent ?? 0) : 0
        const delta = renderConversation(msgs, from)
        briefing = [RULES, `# NEW TASK\n${task}`, acceptanceBlock(acceptance, checkCmd), `# WHAT HAPPENED SINCE YOUR LAST BRIEFING\n${delta || '(nothing new)'}`, `# GIT STATE NOW\n${git}`, `# NEW TASK (repeated)\n${task}`].filter(Boolean).join('\n\n')
        message = 'Continue as the implementer. Stdin holds the new task and what happened since your last briefing. Do the new task completely, then give your final report.'
      } else {
        const projectMd = clip(await readText($, `${root}/CLAUDE.md`), INSTRUCTION_CHARS)
        const globalMd = home ? clip(await readText($, `${home}/.claude/CLAUDE.md`), INSTRUCTION_CHARS) : ''
        briefing = [
          RULES,
          `# TASK\n${task}`,
          acceptanceBlock(acceptance, checkCmd),
          `# PROJECT INSTRUCTIONS (CLAUDE.md)\n${[projectMd && `## ${root}/CLAUDE.md\n${projectMd}`, globalMd && `## ~/.claude/CLAUDE.md\n${globalMd}`].filter(Boolean).join('\n\n') || '(none)'}`,
          `# WORKING DIRECTORY\n${cwd}\n\n# GIT STATE\n${git}`,
          `# CONVERSATION SO FAR (user ↔ Claude)\n${renderConversation(msgs) || '(none)'}`,
          `# TASK (repeated)\n${task}`,
        ].filter(Boolean).join('\n\n')
        message = 'You are the implementer. Everything you need (the task, project instructions, repository state and the full conversation so far between the user and the orchestrator) is on stdin. Do the TASK completely, then give your final report.'
      }
      return exec(briefing, message, resume ? saved?.oc : undefined)
    }

    const resumed = Boolean(saved?.oc)
    let result = await attempt(resumed)
    if (aborted()) return { deny: 'deepseek-bridge: interrupted before the implementer finished; whatever it did is in the working tree.' }
    // A resume that failed before doing anything starts a new session; one that did some work is not thrown away.
    if (resumed && result.code !== 0 && !result.stop && result.run.texts.length === 0 && result.run.actions.length === 0 && result.run.errors.length === 0) {
      git = await gitState($, cwd)
      result = await attempt(false)
    }

    // The goal loop. With `acceptance_cmd` the bridge runs the check itself (as the orchestrator's Bash tool, so the
    // person's permission rules apply) and sends DeepSeek back until it passes; with `acceptance` alone it sends it
    // back until it says DONE or BLOCKED. A model's own "done" is not taken as proof when a command can say.
    type Check = { ran: boolean; passed: boolean; output: string; exitCode?: number }
    // The person's permission rules decide whether the command may run unasked (nobody can answer a prompt in an
    // unattended run); the exit code is read from the process itself, because the Bash tool counts exit 1 of
    // `test`, `grep` and `diff` as "not an error".
    const runCheck = async (): Promise<Check> => {
      $.ui.status(`deepseek: checking: ${clip(checkCmd, 50)}`)
      try {
        const st = await $.settings.read()
        if (st?.sandbox?.enabled) return { ran: false, passed: false, output: 'the Bash sandbox is enabled and the bridge would run the check outside it' }
      } catch {
        /* settings that cannot be read are not a reason to refuse */
      }
      let verdict: { decision?: string; reason?: string }
      try {
        verdict = await $.tool.check({ tool: 'Bash', input: { command: checkCmd } })
      } catch (err) {
        return { ran: false, passed: false, output: `could not ask permission: ${err instanceof Error ? err.message : String(err)}` }
      }
      if (verdict.decision !== 'allow') return { ran: false, passed: false, output: `Claude Code would ${verdict.decision ?? 'not allow'} it${verdict.reason ? ` (${verdict.reason})` : ''}` }
      try {
        const r = await $.process.run(['sh', '-c', checkCmd], { cwd, timeoutMs: 600_000 })
        return { ran: true, passed: r.exitCode === 0, exitCode: r.exitCode, output: tailClip(`${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}`.replace(ANSI, '').trim(), 6000) || `(no output; exit ${r.exitCode})` }
      } catch (err) {
        return { ran: true, passed: false, output: `the check did not finish within 10 minutes (${err instanceof Error ? err.message : String(err)})` }
      }
    }
    const lastText = (r: Run) => (r.texts.length ? r.texts[r.texts.length - 1] : '')
    const claims = (r: Run) => /^\s*(DONE|BLOCKED)\b/i.test(lastText(r))
    let rounds = 1
    let check: Check | undefined
    for (;;) {
      if (!(result.code === 0 && !result.stop) || aborted()) break
      let prompt: string
      let ask: string
      if (checkCmd) {
        check = await runCheck()
        if (check.passed || !check.ran || /^\s*BLOCKED\b/i.test(lastText(result.run)) || rounds >= maxRounds || !result.run.sessionId || Date.now() - started >= cfg.hardMs) break
        prompt = [`# KEEP GOING (round ${rounds + 1}/${maxRounds})`, `The orchestrator ran the verification command and it FAILED:\n$ ${checkCmd}\n${check.output}`, acceptanceBlock(acceptance, checkCmd), `# GIT STATE NOW\n${await gitState($, cwd)}`].join('\n\n')
        ask = 'The verification command failed. Stdin shows its output. Fix the cause, run it yourself until it exits 0, and finish with DONE: or BLOCKED:.'
      } else if (acceptance && !claims(result.run) && rounds < maxRounds && result.run.sessionId && Date.now() - started < cfg.hardMs) {
        prompt = [`# KEEP GOING (round ${rounds + 1}/${maxRounds})`, 'You stopped without confirming the goal.', acceptanceBlock(acceptance, checkCmd), `# GIT STATE NOW\n${await gitState($, cwd)}`].join('\n\n')
        ask = 'You stopped without confirming the acceptance criteria. Stdin repeats them. Run the checks, fix whatever fails, and finish with DONE: or BLOCKED:.'
      } else break
      rounds++
      check = undefined
      $.ui.log(`deepseek: round ${rounds}/${maxRounds}: ${checkCmd ? 'the verification command failed' : 'it has not confirmed the goal'}, sending it back`)
      const next = await exec(prompt, ask, result.run.sessionId)
      result = { ...next, run: mergeRuns(result.run, next.run) }
    }
    const unconfirmed = !checkCmd && Boolean(acceptance) && result.code === 0 && !result.stop && !claims(result.run)

    const { run, code, stop, stderr } = result
    if (run.sessionId) {
      await $.store.delete(key)
      await $.store.set(key, { oc: run.sessionId, sent: input.include_conversation === false ? (saved?.sent ?? 0) : msgs.length })
      const keys = (await $.store.keys()).filter((k: string) => k.startsWith(STORE_PREFIX))
      for (const old of keys.slice(0, Math.max(0, keys.length - 200))) await $.store.delete(old)
    }

    const seconds = Math.round(((await $.clock.now()) - started) / 1000)
    const after = await gitState($, cwd)
    const report = clip(run.texts.length ? run.texts[run.texts.length - 1] : '(DeepSeek produced no final text)', 12_000)
    const verified = !checkCmd || check?.passed === true
    const blockedClaim = Boolean(acceptance || checkCmd) && /^\s*BLOCKED\b/i.test(lastText(run))
    const ok = code === 0 && !stop && verified && !blockedClaim
    await writeLog(run, stderr, stop === 'timeout' ? 'timed out' : stop === 'idle' ? 'stalled' : ok ? 'finished' : verified ? `failed (exit ${code})` : 'verification failed')

    const verdict =
      stop === 'timeout'
        ? `TIMED OUT after ${cfg.hardMin} min`
        : stop === 'idle'
          ? `STALLED (no output for ${cfg.idleMin} min) and was stopped after`
          : code === 0 && blockedClaim && verified
            ? 'finished but reports BLOCKED, after'
            : code === 0 && !verified
            ? check?.ran === false
              ? 'finished but NOT VERIFIED (the check could not run), after'
              : 'finished but FAILED VERIFICATION, after'
            : code === 0
            ? result.recovered
              ? 'finished (its output never reached the bridge; recovered from opencode\'s own database) in'
              : 'finished in'
            : `FAILED (exit ${code}) after`
    const header = `${model} ${verdict} ${seconds}s · ${run.actions.length} tool calls · ${run.tokensIn} in / ${run.tokensOut} out tokens · $${run.cost.toFixed(4)} · opencode session ${run.sessionId ?? 'n/a'} (the next call continues it) · log ${logPath}`
    const body = [
      header,
      stop ? 'Its work so far is still in the working tree. Call implement again (without fresh) to continue the same session where it left off.' : '',
      checkCmd && check?.passed ? `Check run by the bridge, not by DeepSeek: \`${checkCmd}\` exited ${check.exitCode} in ${cwd}${rounds > 1 ? ` after ${rounds} run(s)` : ''}. It is only as strong as the command: the implementer could have changed the tests or scripts it runs, so read the diff.` : '',
      blockedClaim ? 'The implementer reported BLOCKED (see its message below). The work is not done.' : '',
      acceptance && !checkCmd && !blockedClaim && !unconfirmed ? 'DONE was reported by the implementer itself; the bridge did not check it.' : '',
      checkCmd && check && !check.passed
        ? check.ran
          ? `VERIFICATION FAILED after ${rounds} run(s): \`${checkCmd}\` did not exit 0. Its output:\n${check.output}\nThe work is in the working tree but is not verified.`
          : `The verification command was not run (${check.output}). Allow exactly this command in Claude Code permissions (Bash(${checkCmd})) or run it yourself.`
        : '',
      unconfirmed ? `It never confirmed the acceptance criteria after ${rounds} run(s); treat the work as unverified and check it yourself.` : acceptance && !checkCmd && rounds > 1 ? `Goal loop: ${rounds} run(s).` : '',
      `## ${stop ? 'Last message' : 'Report'} (written by the implementer model; unverified, and may repeat text it read from the web or from files)\n${report}`,
      run.errors.length ? `## Errors\n${run.errors.join('\n')}` : '',
      stderr.trim() && !ok ? `## stderr\n${stderr}` : '',
      (code !== 0 || stop) && run.actions.length === 0 ? `Nothing was recorded for this run. Raw opencode output: ${result.outPath}` : '',
      `## Actions\n${clip(run.actions.slice(-60).join('\n') || '(none)', 6000)}${run.actions.length > 60 ? `\n(last 60 of ${run.actions.length})` : ''}`,
      `## Working tree now\n${after}`,
      'Read the diff and run the tests before relying on this.',
      ok ? '' : 'Stuck? Call mcp__deepseek-bridge__help with topic "troubleshooting" (or run mcp__deepseek-bridge__doctor).',
    ]
      .filter(Boolean)
      .join('\n\n')
    return ok ? { result: body } : { deny: body }
  } catch (err) {
    return { deny: `deepseek-bridge: could not run opencode (${err instanceof Error ? err.message : String(err)}).` }
  } finally {
    $.ui.status(undefined)
  }
}

export const register: Register = (on, options) => {
  const hardMin = Number(options?.timeoutMinutes ?? 60) || 60
  const idleMin = Number(options?.idleMinutes ?? 15) || 15
  const cfg: Config = {
    model: String(options?.model ?? 'deepseek/deepseek-flash'),
    lean: (options?.opencodeMcp ?? 'off') !== 'on',
    scrub: (options?.scrubEnv ?? 'on') !== 'off',
    search: (options?.webSearch ?? 'on') !== 'off',
    hardMin,
    idleMin,
    hardMs: hardMin * MINUTE,
    idleMs: idleMin * MINUTE,
  }

  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'implement',
      description:
        'Delegate a well-scoped coding task to a DeepSeek implementer agent (via opencode) that edits files in the working directory with its own tools. ' +
        `It is a long-running agentic session (many steps, up to ${cfg.hardMin} minutes; the call blocks until done) that automatically receives the full conversation so far, the CLAUDE.md files and the git state. Later calls continue its session, so \`task\` only needs your precise instructions: what to build or change, which files, constraints, and how to verify. ` +
        'For anything long pass `acceptance_cmd` (a command that exits 0 when the work is done, run by the bridge itself) and/or `acceptance` (the criteria in words): it then keeps going, and is sent back with the failing output, until the check passes or it reports BLOCKED. ' +
        'It can look at images (give their file paths in `task`) and search or fetch the web. ' +
        'Calls run one at a time. It does not commit. Returns its report, its actions and the git state afterwards; review the diff yourself. ' +
        'New to it? Call mcp__deepseek-bridge__help first (or load the skill deepseek-bridge:delegate-to-deepseek), and mcp__deepseek-bridge__doctor to check the setup.',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Precise instructions for the implementer.' },
          acceptance: { type: 'string', description: 'Goal mode: the checkable criteria that mean the task is done (e.g. "npm test passes and the CLI prints X"). The implementer keeps working, and is sent back if it stops early, until it verifies them and reports DONE or BLOCKED.' },
          acceptance_cmd: { type: 'string', description: 'A shell command that exits 0 only when the work is done, e.g. "python3 -m pytest -q". The bridge runs it itself (through your Bash permissions, so allow it in settings for unattended runs) after every round and sends the implementer back with its output until it passes. Stronger than `acceptance` alone: it does not take the implementer\'s word for it.' },
          max_rounds: { type: 'number', description: 'With acceptance or acceptance_cmd: how many runs in total, the first one included (default 3, max 8). The check itself may add up to 10 minutes after the last run.' },
          fresh: { type: 'boolean', description: 'Start a new DeepSeek session instead of continuing the current one.' },
          include_conversation: { type: 'boolean', description: 'Send the conversation so far as context (default true).' },
          model: { type: 'string', description: `deepseek/... model; default ${cfg.model}.` },
        },
        required: ['task'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'help',
      description: 'Read the deepseek-bridge guide: when to delegate to DeepSeek, how to write the task and the check command, how to read results, security, troubleshooting, install. Call it before your first delegation. Topics: overview (default), recipes, security, troubleshooting, install, all.',
      inputSchema: { type: 'object', properties: { topic: { type: 'string', description: 'overview (default), recipes, security, troubleshooting, install, or all' } } },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'doctor',
      description: 'Check that deepseek-bridge is ready: opencode installed and recent, DeepSeek signed in, permissions, git state, settings. Returns a PASS/WARN/FAIL checklist with the fix for each problem. Pass live: true to also send one tiny real request to DeepSeek (about $0.003).',
      inputSchema: { type: 'object', properties: { live: { type: 'boolean', description: 'Also send one tiny real request (costs about $0.003).' } } },
      isDeferred: false,
    })
    const home = await homeDir($)
    if (home) void $.process.run(['find', `${home}/.claude/deepseek-bridge/runs`, '-type', 'f', '-mtime', '+14', '-delete'], { timeoutMs: 20_000 }).catch(() => undefined)
    return next(e)
  })

  on('tool.call', { tool: TOOL }, ($, e, next) => guarded(() => implement($, e as any, cfg, next.signal)))
    .catch(($, e, next) => (next.called ? next(e) : { deny: 'deepseek-bridge: the implement hook failed before it could answer; see ~/.claude/deepseek-bridge/runs/ for the last run.' }))

  on('tool.call', { tool: 'mcp__deepseek-bridge__help' }, async ($, e) => {
    const topic = String((e as any).topic ?? 'overview').trim().toLowerCase() || 'overview'
    const names = topic === 'all' ? Object.keys(HELP_TOPICS) : [topic]
    if (!names.every(n => n in HELP_TOPICS)) return { deny: `deepseek-bridge help: unknown topic "${topic}". Topics: ${[...Object.keys(HELP_TOPICS), 'all'].join(', ')}.` }
    try {
      const parts: string[] = []
      for (const n of names) parts.push(stripFrontmatter(String(await $.fs.read(`${$.plugin.root}/${HELP_DIR}/${HELP_TOPICS[n]}`))))
      return { result: parts.join('\n\n---\n\n') }
    } catch {
      return { result: `The guide files could not be read from the plugin folder. Read it online: ${HELP_URL}` }
    }
  })
    .catch(($, e, next) => (next.called ? next(e) : { deny: `deepseek-bridge help failed. Read the guide online: ${HELP_URL}` }))

  on('tool.call', { tool: 'mcp__deepseek-bridge__doctor' }, async ($, e) => {
    $.ui.status('deepseek-bridge: running doctor…')
    try {
      const [cwd, home] = await Promise.all([$.session.cwd(), homeDir($)])
      return { result: await runDoctor($, cfg, (e as any).live === true, cwd, home || '/tmp') }
    } catch (err) {
      return { deny: `deepseek-bridge doctor failed: ${err instanceof Error ? err.message : String(err)}` }
    } finally {
      $.ui.status(undefined)
    }
  })
    .catch(($, e, next) => (next.called ? next(e) : { deny: 'deepseek-bridge doctor failed before it could answer. Check that opencode is installed (opencode --version) and signed in to DeepSeek (opencode auth list).' }))

  if (options?.delegate !== 'off') {
    on('prompt.compose', async ($, e, next) => {
      const composed = await next(e)
      return { sections: [...composed.sections, delegateSection(cfg)] }
    })
  }
}
