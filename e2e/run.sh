#!/bin/bash
# End-to-end checks of the installed deepseek-bridge through headless Claude Code (`claude -p`, model haiku).
# The fake-opencode scenarios are free; those marked REAL call opencode and DeepSeek (a few cents).
# Usage: e2e/run.sh [fake|real|all]   (default: fake)
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
MODE="${1:-fake}"
PASS=0; FAIL=0

ask() { # dir, extra PATH dir (or -), claude flags..., prompt
  local dir="$1" shim="$2"; shift 2
  ( cd "$dir" && [ "$shim" != "-" ] && export PATH="$shim:$PATH"; perl -e 'alarm 300; exec @ARGV' claude -p --model haiku "$@" < /dev/null 2>&1 )
}
repo() { local d; d="$(mktemp -d)"; ( cd "$d" && git init -q && echo x > README.md && git add -A && git -c user.email=e@e.e -c user.name=e commit -qm init ); echo "$d"; }
RUNS="$HOME/.claude/deepseek-bridge/runs"
newest() { ls -t "$RUNS"/*-1.jsonl 2>/dev/null | head -1; }
check() { # name, condition result (0 = ok)
  if [ "$2" = 0 ]; then echo "PASS  $1"; PASS=$((PASS+1)); else echo "FAIL  $1"; FAIL=$((FAIL+1)); fi
}

if [ "$MODE" = fake ] || [ "$MODE" = all ]; then
  d="$(repo)"
  out="$(ask "$d" "$HERE/shims/flag-on-resume" --allowedTools="Bash(test -f ok.flag)" "Call the implement tool exactly once with task 'make ok.flag exist' and acceptance_cmd 'test -f ok.flag' and max_rounds 3. Reply with ONLY the tool result text, verbatim.")"
  [ -f "$d/ok.flag" ]; check "goal loop: failing check sends it back, then passes (exit code is real)" $?

  d="$(repo)"
  out="$(ask "$d" "$HERE/shims/flag-on-resume" "Call the implement tool exactly once with task 'noop' and acceptance_cmd 'python3 -c \"import sys; sys.exit(0)\"'. Reply with ONLY the tool result text, verbatim.")"
  echo "$out" | grep -q "Allow exactly this command" || { out="$(ask "$d" "$HERE/shims/flag-on-resume" "Call the implement tool exactly once with task 'noop' and acceptance_cmd 'python3 -c \"import sys; sys.exit(0)\"'. Reply with ONLY the tool result text, verbatim.")"; echo "$out" | grep -q "Allow exactly this command"; }; check "a check the permissions do not allow is not run, with the rule to add" $?
fi

if [ "$MODE" = fake ] || [ "$MODE" = all ]; then
  d="$(repo)"
  out="$(ask "$d" - "Without calling any tool, list the names of the skills you can see whose name contains deepseek. Output only the names, comma separated.")"
  echo "$out" | grep -q "delegate-to-deepseek"; check "the guide skill is listed to agents" $?

  for topic in overview recipes security troubleshooting install; do
    out="$(ask "$d" - "Call the mcp__deepseek-bridge__help tool once with topic '$topic'. Then reply with only the first markdown heading line of its result, verbatim.")"
    echo "$out" | grep -qE "^#" ; check "help serves the '$topic' topic" $?
  done

  out="$(ask "$d" - "Call the mcp__deepseek-bridge__doctor tool once. Reply with ONLY its last line, verbatim.")"
  echo "$out" | grep -qE "READY|NOT READY"; check "doctor returns a verdict" $?
fi

if [ "$MODE" = real ] || [ "$MODE" = all ]; then
  d="$(repo)"
  out="$(ask "$d" - "Call the implement tool exactly once with task 'Create notes.txt containing the line alpha'. Reply with ONLY the tool result text, verbatim.")"
  echo "$out" | grep -q "finished in" && grep -q alpha "$d/notes.txt"; check "REAL: a normal run, output read from the file" $?

  d="$(repo)"
  ask "$d" "$HERE/shims/lose-stdout" "Call the implement tool exactly once with task 'Create notes.txt containing the line beta'. Reply with the word done." > /dev/null
  j="$(newest)"; log="${j%-1.jsonl}.md"
  [ -n "$j" ] && [ ! -s "$j" ] && grep -q beta "$d/notes.txt" && sed -n '/^## Actions/,/^## Texts/p' "$log" | grep -qE '^(write|bash|read|edit)'; check "REAL: output lost (empty file), actions and result recovered from opencode's database" $?

  d="$(repo)"
  printf 'def add(a, b):\n    return a - b\n' > "$d/calc.py"; printf 'from calc import add\n\n\ndef test_add():\n    assert add(2, 3) == 5\n' > "$d/test_calc.py"
  out="$(ask "$d" - --allowedTools="Bash(python3 -m pytest -q)" "Call the implement tool exactly once with task 'The test fails; fix calc.py without touching the test' and acceptance_cmd 'python3 -m pytest -q'. Reply with ONLY the tool result text, verbatim.")"
  echo "$out" | grep -q "Check run by the bridge" && ( cd "$d" && python3 -m pytest -q >/dev/null 2>&1 ); check "REAL: bug fixed, verified by pytest run by the bridge" $?
fi

echo "$PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
