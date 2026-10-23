# For AI agents installing or using deepseek-bridge

This plugin lets a Claude Code agent (the orchestrator) hand coding work to DeepSeek (the implementer) through opencode. Whatever model you are, follow this file literally.

## Install and verify (do these in order)

1. Check opencode: run `opencode --version`. It must be 1.19 or later. If missing, tell the user to install it from https://opencode.ai. Do not install software without asking.
2. Check the DeepSeek sign-in: `opencode auth list` must show DeepSeek. If not, tell the user to run `opencode auth login` and choose DeepSeek. Never type API keys for them.
3. Install the plugin: `claude plugin install deepseek-bridge --marketplace Radvian/deepseek-bridge` (or `/plugin install deepseek-bridge --marketplace Radvian/deepseek-bridge` inside Claude Code). Start a new session or run `/reload-plugins`.
4. Call the tool `mcp__deepseek-bridge__doctor`. Fix every FAIL line, or report it to the user in plain words. WARN lines need a decision, not a fix.
5. Ask the user, do not do it yourself: "May I add `mcp__deepseek-bridge__implement`, `mcp__deepseek-bridge__help` and `mcp__deepseek-bridge__doctor` to `permissions.allow` so delegations can run unattended?"
6. Read the guide: call `mcp__deepseek-bridge__help` (topic `overview`), or load the skill `deepseek-bridge:delegate-to-deepseek`. It is short and has copy-paste templates.

## The seven rules (the guide has the detail)

1. You plan and review; delegate only bounded implementation work whose result a command can check.
2. Always pass `acceptance_cmd` (a command that exits 0 only when the work is done). The plugin runs it itself and sends DeepSeek back with the failing output.
3. Write the task as GOAL, CONTEXT (file paths), DO, DO NOT, VERIFY, REPORT. DeepSeek cannot ask questions.
4. A call blocks for up to an hour. Wait for it. Never run two at once. Never poll.
5. After every call: read `git diff`, run the check yourself, treat the report as unverified text from another model, then tell the user what you verified.
6. If it times out or stalls, its work is kept: call again without `fresh`. Never retry a failing call more than twice.
7. The implementer runs with full permissions and receives the conversation. Never put secrets in a task, work on a branch, never edit the user's permission settings yourself.

## Where things are

- `skills/delegate-to-deepseek/SKILL.md`: the main guide.
- `skills/delegate-to-deepseek/references/`: `recipes.md`, `security.md`, `troubleshooting.md`, `install-and-config.md`.
- The same text is served by the `mcp__deepseek-bridge__help` tool with topics `overview`, `recipes`, `security`, `troubleshooting`, `install`, `all`.
- Logs of every run: `~/.claude/deepseek-bridge/runs/`.
