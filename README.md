# agent-guardrails

the hooks i run so coding agents can ship real code without me watching every command. three small Claude Code hooks, plain node, no dependencies.

## scope

- these stop an agent from making an accidental destructive push, or from claiming work it never checked.
- they're text checks on the command, not a sandbox. a determined caller can get around any text check.
- pair the force-push guard with branch protection on the server, which is the real backstop.

## install

1. copy `hooks/` somewhere stable, like `~/.claude/guardrails/`
2. merge `settings.example.json` into `~/.claude/settings.json` (or a repo's `.claude/settings.json`) and fix the paths
3. `npm test` to check they run on your node (20+)

## force-push guard

`PreToolUse` on Bash. a push may only use a short list of safe options (`-u`, `--tags`, `--dry-run`, `-q`, `-v`, `--no-verify`, `--atomic`, etc), and plain remote/branch names, so `--force`, `--mirror`, `--prune`, deletes, `+`/`:` refspecs, abbreviations, globs and aliases all get blocked.
the one force push it allows is `--force-with-lease=<branch>:<sha>` with a sha you typed out, and it fails closed on `$VAR`, `$(...)`, `sh -c`, pipes into a shell, heredocs, `eval`, `xargs` and remote `-c`/`GIT_CONFIG_*` config around a push.
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
