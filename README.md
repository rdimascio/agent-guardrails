# agent-guardrails

the hooks i run so coding agents can ship real code without me watching every command. three small Claude Code hooks, plain node, no dependencies.

## install

1. copy `hooks/` somewhere stable, like `~/.claude/guardrails/`
2. merge `settings.example.json` into `~/.claude/settings.json` (or a repo's `.claude/settings.json`) and fix the paths
3. `npm test` to check they run on your node (20+)

## force-push guard

`PreToolUse` on Bash. blocks `--force`, `-f`, `+refspec` pushes and a bare `--force-with-lease`.
the only force push it lets through is `--force-with-lease=<branch>:<sha>` with a sha you typed out yourself. a sha built inside the command with `$(...)` gets blocked too.
a bare lease checks against your remote-tracking ref, and any background fetch moves that ref, so it can still eat someone else's commits.

## evidence first

`UserPromptSubmit`. when the prompt has a symptom word (broken, failing, rate limit, timeout, 5xx, etc) it adds a short note to the context.
the note says find the failing event, state the cause, then change things.
stops the agent from reading "it's rate limited" literally and editing config before anyone looked at a log.

## claims need receipts

`Stop`. if the last reply says "tests pass", "fixed", "merged", "deployed" and so on, it checks what actually ran this turn.
no test command for a test claim, or no git/gh/deploy/MCP call for a ship claim, and it blocks the stop and asks for the command + output.
questions, hedges ("once ci is green"), negations and claims that cite an id from real tool output pass.

## license

MIT
