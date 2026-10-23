# deepseek-bridge

Use DeepSeek as the implementer inside Claude Code, while Claude (Opus, Sonnet, whatever you run) stays the orchestrator on your own subscription.

It adds one tool, `mcp__deepseek-bridge__implement`. Claude plans and reviews; when it has a well-scoped piece of implementation work it hands it to a DeepSeek agent that runs through the [opencode](https://opencode.ai) CLI (`opencode run -m deepseek/deepseek-flash`) and edits your working directory with its own tools. It is not a model entry in `/model`: Claude Code has one provider per session, so a tool is how a second model joins.

## What it gives you

- **Full context.** The first call briefs DeepSeek with the task, your global and project `CLAUDE.md`, the git state and the conversation so far. Later calls in the same Claude session continue the same opencode session and send only what happened since.
- **Long, agentic runs.** Tested with 4 to 24 minute calls; the default limit is 60 minutes, configurable. Progress shows in the status line and in a log that updates as it goes. `caffeinate` keeps a Mac awake for the length of a run.
- **A goal loop that does not take the model's word for it.** Pass `acceptance_cmd` (a command that exits 0 when the work is done, such as `python3 -m pytest -q`). The bridge runs it itself after each run and sends DeepSeek back with the failing output until it passes. With only `acceptance` (criteria in words) it sends the model back until it says `DONE:` or `BLOCKED:`, and the result says that this was self-reported.
- **Output that survives a lost pipe.** opencode's output goes to a file the bridge reads as it grows. If nothing arrives, or the run ends with nothing received, the report, actions and cost are rebuilt from opencode's own database, so a finished run is never reported as stalled. A silent run is looked up in the database before it is killed.
- **Resumable.** A run that hit the time limit, stalled or was recovered keeps its session; the next call continues it.

## Requirements

- Claude Code with plugin (mod) support. Tested on 2.1.299.
- [opencode](https://opencode.ai) 1.19 or later, signed in to DeepSeek: `opencode auth login`. Tested on 1.19.4; the bridge reads opencode's JSON events and its sqlite schema (`opencode db`), which are not a public API.
- macOS or Linux (it uses `sh`, `tail`, `sed`, `find`; `caffeinate` is used when present).

## Install

```
/plugin install deepseek-bridge --marketplace Radvian/deepseek-bridge
```

or from a shell: `claude plugin install deepseek-bridge --marketplace Radvian/deepseek-bridge`.

For unattended runs, allow the tool in your Claude Code settings (`permissions.allow`): `mcp__deepseek-bridge__implement`. Without it Claude Code asks before every call.

## Using it

Claude decides when to delegate (a short section added to the system prompt tells it how; switch that off with the `delegate` setting). You can also ask: "implement this with the implement tool, acceptance_cmd `npm test`".

| Parameter | |
| --- | --- |
| `task` | Precise instructions: what to build, which files, constraints, how to verify. Required. |
| `acceptance_cmd` | A shell command that exits 0 only when the work is done. Run by the bridge after every run. |
| `acceptance` | The done-criteria in words. The implementer must verify them and end with `DONE:` or `BLOCKED:`. |
| `max_rounds` | Runs in total, the first included (default 3, max 8) when a goal is set. The check can add up to 10 minutes after the last run. |
| `fresh` | Start a new DeepSeek session instead of continuing the current one. |
| `include_conversation` | Send the conversation as context (default true). |
| `model` | Any `deepseek/...` model; default `deepseek/deepseek-flash`. Other providers are refused. |

Calls run one at a time; a second concurrent call is refused at once. DeepSeek is told not to commit or push.

`acceptance_cmd` runs only if Claude Code's own permission rules allow that exact command without asking, because nobody can answer a prompt in an unattended run. Allow it explicitly, for example `Bash(python3 -m pytest -q)`. It is refused when the Bash sandbox is enabled, since the bridge would run it outside the sandbox.

## Security model and data flow. Read this before enabling unattended runs.

- **The implementer is a full-privilege agent.** `opencode run --auto` approves every tool call. It can read and write your files and run shell commands as you. Claude Code's allow and deny rules, PreToolUse hooks, Bash sandbox and path protections do not apply to it. One allow rule for `implement` therefore removes those guards for everything DeepSeek does. Run it in a git branch or worktree, and review the diff. "Do not commit" is an instruction, not an enforcement.
- **What is sent to DeepSeek, a third party:** the task; your global and project `CLAUDE.md`; git status, recent commits and the diff stat; and the conversation (the first 30k and last 210k characters, each tool result clipped to 1,500 characters, system reminders stripped). Nothing is redacted: a secret that appears in the conversation is sent.
- **Web search** (the `webSearch` setting, on by default) sends the agent's queries to Exa through opencode.
- **Prompt injection.** The transcript and tool outputs are marked to the implementer as data, not instructions, and the report it returns is marked to Claude as unverified. That lowers the risk; it does not remove it. Do not delegate from a conversation that holds untrusted content (web pages, issues, files from strangers) you would not trust the agent with.
- **The environment scrub is best effort.** Before opencode starts, variables that look like secrets are dropped (names containing KEY, TOKEN, SECRET, PASS, CREDENTIAL, COOKIE, AUTH, DSN or PRIVATE; `AWS_*`; any URL with a password). It stops an accidental `env` dump. It is not a sandbox: the agent can still read `~/.ssh`, `~/.aws`, opencode's own `auth.json` and the environment of parent processes. `DEEPSEEK_API_KEY` and `OPENCODE_*` are kept.
- **Logs** are written to `~/.claude/deepseek-bridge/runs/` (mode 700) and removed after 14 days. They hold the full briefing and the raw opencode output.
- **The `acceptance_cmd` check** passes through Claude Code's permission engine but not through the Bash tool, so PreToolUse hooks and classifiers do not see it.

## Settings

Set them in `/plugin configure deepseek-bridge`.

| Setting | Default | |
| --- | --- | --- |
| `model` | `deepseek/deepseek-flash` | opencode `provider/model`. |
| `timeoutMinutes` | 60 | Hard limit for one call (30, 60, 120, 240). The work stays in the tree and the next call continues. |
| `idleMinutes` | 15 | A run with no sign of life (no output, nothing written to opencode's database) is stopped after this long (5, 15, 30). A single command that runs silently longer than that is also stopped. |
| `opencodeMcp` | `off` | `off` disables the MCP servers listed in `~/.config/opencode/opencode.json` for these runs (about 14 times fewer input tokens per call with three servers). It does not read `.jsonc` or project-level configs. |
| `scrubEnv` | `on` | The environment scrub above. |
| `webSearch` | `on` | opencode's built-in web search. |
| `delegate` | `on` | Add the delegation guidance to Claude's system prompt. |

## When something looks wrong

- Every run leaves `~/.claude/deepseek-bridge/runs/<time>-<session>.md` (briefing, actions, texts) and the raw `-1.jsonl` / `-1.err` next to it.
- A header that says "recovered from opencode's own database" means the run finished and its output did not reach the bridge. The result is real.
- `STALLED` means no output and nothing in opencode's database for `idleMinutes`. The work so far is in the tree; call `implement` again to continue.
- `/reload-plugins` while a call is running kills the child. Wait for it to finish.
- A subagent that calls `implement` gets its own conversation and its own opencode session.

## Limitations

- It is a tool, not a model in the picker; Claude sees DeepSeek's report and actions, not its reasoning.
- opencode internals (event JSON, database schema) can change between versions.
- The conversation sent as context is bounded, so a very long session is trimmed in the middle.

## Develop and test

```
claude plugin validate .
claude plugin test .          # unit tests
e2e/run.sh fake               # free: a fake opencode drives the goal loop and the permission refusal
e2e/run.sh real               # a few cents: real opencode and DeepSeek, lost-output recovery, a pytest-verified fix
```

## License

MIT, see `LICENSE`.
