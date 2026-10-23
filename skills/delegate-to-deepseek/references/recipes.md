# Recipes

Copy, then adapt. Every recipe ends with a check the bridge runs itself.

## Check commands (acceptance_cmd) by ecosystem

| Ecosystem | `acceptance_cmd` | Allow rule to add in Claude Code settings |
| --- | --- | --- |
| Python | `python3 -m pytest -q` | `Bash(python3 -m pytest -q)` |
| Node | `npm test` | `Bash(npm test)` |
| Node, typed | `npm run build` | `Bash(npm run build)` |
| Go | `go test ./...` | `Bash(go test ./...)` |
| Rust | `cargo test` | `Bash(cargo test)` |
| Java | `./gradlew test` | `Bash(./gradlew test)` |
| Make | `make check` | `Bash(make check)` |
| Several steps | `./scripts/verify.sh` | `Bash(./scripts/verify.sh)` |

Rules:
- The check must exit 0 only when the work is really done. A check that always passes verifies nothing.
- Put several steps in one script (`set -e`, then the lint, the build, the tests) and allow the script, because `a && b` needs every part allowed separately.
- The implementer can edit files the check runs. Tell it not to touch the tests or the script, and read the diff for test edits afterwards.
- A check that takes longer than 10 minutes is killed; make it faster or narrower.
- No test suite yet? Write a tiny script that exercises the feature (`node scripts/smoke.js`), commit it first, and use that.

## Task skeletons

### Fix a bug with a known cause
```
GOAL: <function> returns <wrong> for <input>; it must return <right>.
CONTEXT: bug is in <file>:<function>. Cause: <what you found>. Tests: <path>.
DO: 1. fix the cause (do not special-case the input). 2. add a regression test with this input and two neighbours.
DO NOT: change the public signature; edit existing tests.
VERIFY: run `<check>` until it exits 0.
REPORT: files changed; any related bug you noticed but did not fix.
```

### Add a feature with tests
```
GOAL: <feature in one sentence>.
CONTEXT: follow the pattern of <existing file>; entry point <file>; docs in <file>.
DO: 1. implement <behaviour A>, <behaviour B>. 2. tests for each behaviour and for <edge cases>. 3. update the README section <name>.
DO NOT: add dependencies; change unrelated modules.
VERIFY: run `<check>` until it exits 0.
REPORT: files changed; decisions you made where the task was silent.
```

### Refactor or migrate (behaviour must not change)
```
GOAL: move <A> to <B> everywhere without changing behaviour.
CONTEXT: list of call sites: <paths or a grep command>. Old API: ...; new API: ...
DO: 1. migrate in small commits-worth of edits (do not commit). 2. delete the old API only after zero uses remain.
DO NOT: change behaviour; edit tests except to use the new API.
VERIFY: run `<check>` until it exits 0, then run `grep -rn "<old name>" src` and confirm no results.
REPORT: files changed; anything you could not migrate and why.
```

### Work from a screenshot or design
```
GOAL: make <component> match the screenshot.
CONTEXT: screenshot at /absolute/path/design.png (open it); component in <file>; styles in <file>.
DO: 1. compare and list differences. 2. fix them. 3. render or build if the project can.
VERIFY: run `<build or test command>`.
REPORT: what still differs.
```

### Research then implement
```
GOAL: <integrate library X / follow API Y>.
CONTEXT: search the web for the current docs of <X> version <v>; fetch <url> if given.
DO: 1. read the docs. 2. implement. 3. write a test that calls it.
REPORT: the doc URLs you relied on.
```
(Web search is on by default; the `webSearch` setting turns it off.)

## Multi-step plan (large goals)

1. Write the plan yourself: 3 to 6 steps, each 5 to 25 minutes, each with its own check.
2. Step 1 with `fresh: true`. Review the diff. Run the check.
3. Step 2 without `fresh`, so DeepSeek keeps what it learned. Say what step 1 produced if you changed anything by hand.
4. Repeat. After the last step run the whole check suite yourself.
5. If a step fails twice, stop and decide whether to change the plan or do that part yourself.

## Goal loop settings

| Situation | Use |
| --- | --- |
| A test suite or build exists | `acceptance_cmd` only. |
| Done is partly subjective (docs, UI polish) | `acceptance` in words plus an `acceptance_cmd` for the objective part. Review the rest yourself. |
| Nothing can be checked | Do not delegate; or write the check first. |
| Hard task, flaky model | `max_rounds` 5. Never above 8. |
| Quick task | `max_rounds` 1 (one run, then the check runs once and reports). |

## Worked example: overnight run

User says: "implement the CSV export and have it ready by morning."
1. `git switch -c feature/csv-export`.
2. `doctor` with `live: true`; fix anything red.
3. Confirm with the user that `mcp__deepseek-bridge__implement` and `Bash(python3 -m pytest -q)` are allowed.
4. Call `implement` with the feature skeleton, `acceptance_cmd: "python3 -m pytest -q"`, `max_rounds: 5`.
5. On return: read the header and the diff, run the tests yourself, write the user a summary of what changed and what you verified.
6. If the header says TIMED OUT or STALLED, call again without `fresh`: "continue; remaining: ...".
