# Troubleshooting

First step for any problem: call `mcp__deepseek-bridge__doctor`. Add `live: true` to also test one real request.

## Where to look

- Every run writes `~/.claude/deepseek-bridge/runs/<time>-<session>.md` (the briefing sent, the actions, the texts) and next to it `...-1.jsonl` (raw opencode events) and `...-1.err` (stderr). The path is in the result header after `log`.
- opencode's own sessions: `opencode session list`. A session's final messages: `opencode db "select id, json_extract(data,'$.role') as role, json_extract(data,'$.finish') as finish from message where session_id='ses_...' order by time_created desc limit 5" --format json`.
- Never print `opencode export <id>` into a conversation: it can be tens of megabytes.

## Symptom, cause, fix

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `doctor` says opencode not found | opencode not installed or not on PATH for Claude Code | Install from https://opencode.ai, restart Claude Code so PATH is picked up. |
| `doctor` says DeepSeek not signed in | No credential | In a terminal: `opencode auth login`, choose DeepSeek, paste the API key. Tell the user; never type keys yourself. |
| `FAILED (exit 1)` right away, stderr mentions auth, 401, or balance | Bad key or no credit | The user must fix the key or top up the DeepSeek account. |
| `FAILED` and stderr mentions an unknown option | opencode too old | `opencode upgrade`, then `doctor`. Needs 1.19 or later. |
| Claude Code asks permission on every call | The tool is not in `permissions.allow` | Ask the user to add `mcp__deepseek-bridge__implement` (and `help`, `doctor`). |
| `finished but NOT VERIFIED (the check could not run)` | The exact check command is not allowed, or the Bash sandbox is on | Ask the user to allow `Bash(<exact command>)`; with the sandbox on, run the check yourself. |
| `finished but FAILED VERIFICATION` | The work does not pass the check | Read the output in the result; call again without `fresh` with a precise description of the failure. |
| `TIMED OUT` | Task too big for the limit | Call again without `fresh` to continue; split the task; the user can raise `timeoutMinutes` (30, 60, 120, 240). |
| `STALLED (no output for N min)` | Silent for the whole `idleMinutes`; or a single command ran silently longer than that | Look at the log. Call again without `fresh`. Raise `idleMinutes` to 30 if a long silent command is legitimate. |
| Header says `recovered from opencode's own database` | The run finished but its output pipe lost it | Nothing to fix. The result is real. |
| `another implement call is still running` | One call at a time | Wait for the first to return. |
| It did nothing useful in 0 steps | Task too vague, or the model replied without acting | Rewrite the task with files, steps and a check; use `acceptance_cmd` so it is sent back. |
| It changed files it should not have | Task did not forbid it | `git checkout -- <file>` yourself (after telling the user), add DO NOT lines, call again. |
| It edited the tests to make them pass | The check can be gamed | Say "DO NOT edit tests" in the task; protect the tests with a script; read the diff. |
| `/reload-plugins` killed a running call | Reloading kills the child | Wait until the call returns before reloading. Then call again without `fresh`. |
| The status line shows nothing | Progress is shown only while a call runs | Normal. |

## When to stop retrying

- Same failure twice: change the task or the plan.
- Three different failures in a row: stop, summarise for the user what was tried and what the logs say, and ask.
- Never loop `implement` calls without reading each result.

## Reporting a bug

Include: the result header, the `doctor` output, the opencode version (`opencode --version`), Claude Code version, and the log path. Do not paste the log without checking it for secrets. Issues: https://github.com/Radvian/deepseek-bridge/issues
