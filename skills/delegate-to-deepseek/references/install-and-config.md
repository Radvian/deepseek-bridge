# Install, configure, upgrade

## Requirements

- Claude Code with plugin (mod) support (tested on 2.1.299).
- opencode 1.19 or later (tested on 1.19.4): https://opencode.ai. Check with `opencode --version`.
- A DeepSeek API key saved in opencode: in a terminal run `opencode auth login` and choose DeepSeek. Check with `opencode auth list` (it prints provider names, never keys).
- macOS or Linux. The plugin uses `sh`, `tail`, `sed`, `find`; `caffeinate` is used on macOS when present.
- A git repository for the work, preferably on its own branch.

## Install

In Claude Code:
```
/plugin install deepseek-bridge --marketplace Radvian/deepseek-bridge
```
From a shell:
```
claude plugin install deepseek-bridge --marketplace Radvian/deepseek-bridge
```
Then start a new session (or run `/reload-plugins` when no call is running).

## Verify

Call `mcp__deepseek-bridge__doctor` (with `live: true` for one tiny real request). Every line must be PASS, or WARN with a reason you accept. The last line says READY or NOT READY.

## Permissions (ask the user; never edit settings yourself)

For unattended use, the user adds to `permissions.allow` in `~/.claude/settings.json`:
```json
"mcp__deepseek-bridge__implement",
"mcp__deepseek-bridge__help",
"mcp__deepseek-bridge__doctor",
"Bash(python3 -m pytest -q)"
```
The last line is an example: allow the exact check command you will pass as `acceptance_cmd`.

## Settings

`/plugin configure deepseek-bridge@deepseek-bridge`

| Setting | Default | Meaning |
| --- | --- | --- |
| `model` | `deepseek/deepseek-flash` | opencode `provider/model`. Only `deepseek/...` is accepted. |
| `timeoutMinutes` | 60 | Hard limit for one call: 30, 60, 120 or 240. The work stays in the tree; the next call continues. |
| `idleMinutes` | 15 | Stop a run with no sign of life for this long: 5, 15 or 30. |
| `opencodeMcp` | off | `off` disables the MCP servers in `~/.config/opencode/opencode.json` for these runs (far fewer input tokens). `on` leaves them. |
| `scrubEnv` | on | Drop secret-looking environment variables from the implementer's environment. |
| `webSearch` | on | opencode's web search (queries go to Exa). |
| `delegate` | on | Adds a short delegation guide to the system prompt of every session. |

## Upgrade

```
claude plugin update deepseek-bridge@deepseek-bridge
```
then `/reload-plugins` when no call is running. Upgrade opencode with `opencode upgrade`.

## Uninstall

```
claude plugin uninstall deepseek-bridge@deepseek-bridge
```
Remove the three `mcp__deepseek-bridge__*` allow rules, and `~/.claude/deepseek-bridge/` if the logs are not wanted.

## Notes for agents installing this for a user

1. Do the install and `doctor`. Report the doctor result in plain words.
2. Do not edit settings or sign in on the user's behalf. Tell them the exact rule or command.
3. Do not run a delegation as a demo without asking: it spends the user's DeepSeek credit and can edit their files.
