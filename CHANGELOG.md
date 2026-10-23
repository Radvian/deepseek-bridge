# Changelog

## 1.1.0

- Built-in guidance for any agent: skill `deepseek-bridge:delegate-to-deepseek` (decision rules, pre-flight checklist, task template, result-reading table, post-call review, never-do list) with references for recipes, security, troubleshooting and install; `AGENTS.md`.
- New tool `help`: serves the guide by topic for agents that do not load skills.
- New tool `doctor`: PASS/WARN/FAIL setup checklist with a fix per problem; optional live request.
- The system-prompt section now carries seven golden rules and points to the guide; failed results point to `help`.
- Tool descriptions point new agents to `help` and `doctor`.

## 1.0.0

First release.

- `implement` tool: delegates a task to DeepSeek through `opencode run`, briefed with the task, CLAUDE.md files, git state and the conversation; later calls continue the same opencode session.
- Long agentic runs: configurable time limit, stall watchdog that consults opencode's database before killing a run, live status line and a progress log, `caffeinate` on macOS.
- Goal loop: `acceptance_cmd` is run by the bridge (permission-checked, real exit code) and the implementer is sent back with the failing output; `acceptance` alone sends it back until it says DONE or BLOCKED and the result says so.
- Output recovery: opencode's output is read from a file; a run whose output never arrived is rebuilt from opencode's database, including its session id.
- Safety: transcript marked as untrusted data, report marked as unverified, environment scrub (case-insensitive, URL credentials), log directory mode 700, one call at a time, `deepseek/` models only, no check run under an enabled sandbox.
- Settings: model, time limit, stall limit, opencode MCP servers, environment scrub, web search, delegation guidance.
