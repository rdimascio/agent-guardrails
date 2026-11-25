#!/usr/bin/env node
import { readFileSync } from 'node:fs'

const LITERAL_SHA = /^[0-9a-f]{7,40}$/i
const SEGMENT_BREAKS = new Set([';', '&', '|', '\n', '(', ')'])
const VARIABLE_START = /[A-Za-z_{0-9@*#?!$-]/

const ALLOWED_LONG_OPTIONS = new Set([
  '--set-upstream',
  '--tags',
  '--follow-tags',
  '--dry-run',
  '--quiet',
  '--verbose',
  '--no-verify',
  '--porcelain',
  '--atomic',
  '--force-if-includes',
])
const ALLOWED_SHORT_FLAGS = new Set(['u', 'n', 'q', 'v'])
const PINNED_LEASE = /^--force-with-lease=([A-Za-z0-9_./-]+):(.+)$/
const STRICT_REFSPEC = /^[A-Za-z0-9_./-]+(?::[A-Za-z0-9_./-]+)?$/
const PUSH_WORD = /push/i

const GLOBALS_WITHOUT_VALUE = new Set([
  '-p',
  '-P',
  '--paginate',
  '--no-pager',
  '--bare',
  '--no-replace-objects',
  '--no-lazy-fetch',
  '--literal-pathspecs',
  '--glob-pathspecs',
  '--noglob-pathspecs',
  '--icase-pathspecs',
  '--no-optional-locks',
  '--no-advice',
])
const GLOBALS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--attr-source', '--exec-path', '--list-cmds'])
const KNOWN_SUBCOMMANDS = new Set(
  (
    'add am annotate apply archive bisect blame branch bundle cat-file check-attr check-ignore check-mailmap check-ref-format checkout ' +
    'checkout-index cherry cherry-pick clean clone commit commit-graph commit-tree config count-objects describe diff diff-files diff-index ' +
    'diff-tree difftool fetch fetch-pack for-each-ref format-patch fsck gc grep hash-object help init log ls-files ls-remote ls-tree ' +
    'merge merge-base merge-file merge-tree mergetool mv name-rev notes pull push range-diff read-tree rebase reflog remote repack replace ' +
    'rerere reset restore rev-list rev-parse revert rm shortlog show show-branch show-ref sparse-checkout stash status submodule switch ' +
    'symbolic-ref tag update-index update-ref var verify-commit verify-tag version whatchanged worktree write-tree maintenance'
  ).split(' '),
)
const RISKY_CONFIG_KEY = /^(?:remote\.|alias\.|push\.|url\.|include|core\.sshcommand$|core\.hookspath$)/i
const CONFIG_READS = new Set(['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l', 'get', 'list'])
const REMOTE_WRITES_ANYWHERE = new Set(['add', 'set-url'])
const REMOTE_WRITES = new Set(['set-branches', 'set-head', 'rename', 'remove', 'rm', 'prune', 'update'])
const SAFE_CONFIG_KEY = /^(?:user\.[\w.-]+|color\.[\w.-]+|core\.quotepath)(?:=|$)/i
const EXEC_LONG_OPTIONS = ['--exec', '--extcmd', '--upload-pack', '--receive-pack', '--open-files-in-pager']
const MIN_LONG_PREFIX = 3
const EXEC_SHORT_FLAGS = { rebase: 'x', difftool: 'x', fetch: 'u', pull: 'u', clone: 'u', 'ls-remote': 'u', archive: 'u', grep: 'O' }
const RUNS_OTHER_COMMANDS = [
  { sub: 'submodule', arg: 'foreach' },
  { sub: 'bisect', arg: 'run' },
]

const COMMAND_WORD = String.raw`(?:^|[\s;&|(])(?:\S*/)?`
const COMMAND_END = String.raw`(?=$|[\s;&|)<'"])`
const NESTING = [
  { pattern: new RegExp(`${COMMAND_WORD}(?:sh|bash|zsh|dash|ksh|fish|csh|tcsh)${COMMAND_END}`), why: 'it runs a shell' },
  { pattern: new RegExp(`${COMMAND_WORD}(?:eval|xargs|exec|source|env\\s+-S)${COMMAND_END}`), why: 'it runs eval, xargs, exec or source' },
  {
    pattern: new RegExp(`${COMMAND_WORD}(?:python\\d*(?:\\.\\d+)?|node|nodejs|ruby|perl|php|deno|bun|lua|osascript|pwsh)(?:\\s+-\\S+)*?\\s+-(?:c|e|E|p|r|-eval|-print)(?=$|\\s)`),
    why: 'it runs inline interpreter code',
  },
  { pattern: /<</, why: 'it feeds a heredoc or here-string' },
  { pattern: /\$\(|`/, why: 'it runs command substitution' },
]
const GIT_CONFIG_ENV = /\bGIT_CONFIG_\w*/
const ALIAS_CONFIG_KEY = /^alias\./i

export function splitCommand(command) {
  const segments = []
  let words = []
  let word = null
  let quote = null

  const startWord = () => {
    if (word === null) word = { text: '', computed: false }
  }
  const endWord = () => {
    if (word !== null) words.push(word)
    word = null
  }
  const endSegment = () => {
    endWord()
    if (words.length > 0) segments.push(words)
    words = []
  }

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (quote === "'") {
      if (ch === "'") quote = null
      else word.text += ch
      continue
    }
    if (ch === '\\' && i + 1 < command.length) {
      startWord()
      word.text += command[++i]
      continue
    }
    if (ch === '`' || (ch === '$' && VARIABLE_START.test(command[i + 1] ?? '')) || (ch === '$' && command[i + 1] === '(')) {
      startWord()
      word.computed = true
      word.text += ch
      continue
    }
    if (quote === '"') {
      if (ch === '"') quote = null
      else word.text += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      startWord()
      quote = ch
      continue
    }
    if (SEGMENT_BREAKS.has(ch)) {
      endSegment()
      continue
    }
    if (/\s/.test(ch)) {
      endWord()
      continue
    }
    startWord()
    word.text += ch
  }
  endSegment()
  return segments
}

function isGitWord(word) {
  return word.text === 'git' || word.text.endsWith('/git')
}

export function gitInvocation(words) {
  const gitAt = words.findIndex(isGitWord)
  if (gitAt === -1) return null
  const globals = []
  let k = gitAt + 1
  let unknownGlobal = false
  while (k < words.length && words[k].text.startsWith('-')) {
    const text = words[k].text
    const name = text.split('=')[0]
    if (GLOBALS_WITH_VALUE.has(name) && !text.includes('=')) {
      globals.push(text, words[k + 1]?.text ?? '')
      k += 2
    } else {
      if (!GLOBALS_WITHOUT_VALUE.has(text) && !GLOBALS_WITH_VALUE.has(name)) unknownGlobal = true
      globals.push(text)
      k += 1
    }
  }
  return { prefix: words.slice(0, gitAt), globals, globalWords: words.slice(gitAt + 1, k), sub: words[k] ?? null, args: words.slice(k + 1), unknownGlobal }
}

function configValues(globals) {
  const values = []
  for (let k = 0; k < globals.length; k++) {
    const text = globals[k]
    if (text === '-c' || text === '--config-env') values.push(globals[++k] ?? '')
    else if (text.startsWith('--config-env=')) values.push(text.slice('--config-env='.length))
  }
  return values
}

function isExecLongOption(arg) {
  const name = arg.split('=')[0]
  return name.startsWith('--') && name.length >= MIN_LONG_PREFIX && EXEC_LONG_OPTIONS.some((option) => option.startsWith(name))
}

function hasExecShortFlag(sub, arg) {
  const flag = EXEC_SHORT_FLAGS[sub]
  return flag !== undefined && /^-[a-zA-Z]/.test(arg) && !arg.startsWith('--') && arg.slice(1).includes(flag)
}

function configWriteProblems(git) {
  const sub = git.sub?.text ?? ''
  const args = git.args.map((word) => word.text)
  if (sub === 'config' && args.some((arg) => RISKY_CONFIG_KEY.test(arg)) && !args.some((arg) => CONFIG_READS.has(arg))) {
    return ['git config writes a remote, alias, push, url, include, sshCommand or hooksPath setting']
  }
  if (sub === 'remote' && args.some((arg) => REMOTE_WRITES_ANYWHERE.has(arg))) return ['git remote add or set-url changes where pushes go']
  return []
}

function invocationProblems(git, pushing) {
  const problems = [...configWriteProblems(git)]
  const values = configValues(git.globals)
  for (const value of values) {
    if (ALIAS_CONFIG_KEY.test(value)) problems.push(`-c ${value} defines an alias`)
  }
  if (!pushing) return problems
  for (const value of values) {
    if (!SAFE_CONFIG_KEY.test(value)) problems.push(`-c ${value} is not an allowed config key in a command that pushes`)
  }
  if (git.globals.some((text) => text.startsWith('--config-env'))) problems.push('--config-env is not allowed in a command that pushes')
  const words = [...git.prefix, ...git.globalWords, ...(git.sub === null ? [] : [git.sub]), ...git.args]
  for (const word of words) {
    if (word.computed) problems.push(`${word.text} is computed when the command runs, so the hook cannot check it`)
  }
  const sub = git.sub?.text ?? ''
  if (git.unknownGlobal) problems.push('git has a global option the hook does not know')
  if (git.sub !== null && !KNOWN_SUBCOMMANDS.has(sub)) problems.push(`git ${sub} is not a known git command and may be an alias`)
  if (sub === 'push') return problems
  const args = git.args.map((word) => word.text)
  if (args.some((arg) => PUSH_WORD.test(arg))) problems.push(`git ${sub} has an argument that mentions push`)
  if (sub === 'config' && args.some((arg) => RISKY_CONFIG_KEY.test(arg))) problems.push('git config touches remote, alias or push settings in a command that pushes')
  if (sub === 'remote' && args.some((arg) => REMOTE_WRITES.has(arg))) problems.push('git remote changes a remote in a command that pushes')
  for (const arg of args) {
    if (isExecLongOption(arg) || hasExecShortFlag(sub, arg)) problems.push(`git ${sub} ${arg} can run another command`)
  }
  for (const rule of RUNS_OTHER_COMMANDS) {
    if (sub === rule.sub && args.includes(rule.arg)) problems.push(`git ${sub} ${rule.arg} runs other commands`)
  }
  return problems
}

function optionProblem(text) {
  if (ALLOWED_LONG_OPTIONS.has(text)) return null
  const lease = text.match(PINNED_LEASE)
  if (lease) return LITERAL_SHA.test(lease[2]) ? null : `the lease in ${text} is not a literal SHA`
  if (text.startsWith('--force-with-lease')) return `${text} is not pinned to a SHA, so it trusts your remote-tracking ref, which any fetch moves`
  if (/^-[a-zA-Z]+$/.test(text) && [...text.slice(1)].every((flag) => ALLOWED_SHORT_FLAGS.has(flag))) return null
  return `${text} is not on the list of allowed push options`
}

function refspecProblem(text) {
  if (text.startsWith('+')) return `the refspec ${text} starts with +, which is a force push`
  if (text.startsWith(':')) return `the refspec ${text} deletes a remote branch`
  if (!STRICT_REFSPEC.test(text)) return `${text} is not a plain remote or refspec`
  return null
}

function nestingProblems(command) {
  return NESTING.filter((rule) => rule.pattern.test(command)).map((rule) => `the command may push and ${rule.why}, so the hook cannot see what really runs`)
}

export function isPushing(segments) {
  return segments.some((words) => words.some((word) => word.computed || PUSH_WORD.test(word.text)))
}

export function findForcePushes(command) {
  const segments = splitCommand(command)
  const pushing = isPushing(segments)
  const problems = pushing ? nestingProblems(command) : []
  const invocations = segments.map(gitInvocation).filter((git) => git !== null)
  if (pushing && GIT_CONFIG_ENV.test(command)) problems.push('GIT_CONFIG_* variables can change remote or push config for this push')
  for (const git of invocations) {
    problems.push(...invocationProblems(git, pushing))
    if (git.sub?.text !== 'push') continue
    let options = true
    for (const word of git.args) {
      const text = word.text
      if (options && text === '--' && !word.computed) {
        options = false
        continue
      }
      const problem = options && text.startsWith('-') && text.length > 1 ? optionProblem(text) : refspecProblem(text)
      if (problem) problems.push(problem)
    }
  }
  return [...new Set(problems)]
}

export const HOW_TO_PUSH =
  'Plain pushes and -u, --tags, --follow-tags, --dry-run, -n, -q, -v, --no-verify, --porcelain and --atomic are allowed. ' +
  'To force push, read the remote SHA yourself (git ls-remote origin <branch>), check it, then run ' +
  'git push --force-with-lease=<branch>:<that-sha> origin <branch> as a plain command. ' +
  'If that is rejected, fetch and look at what landed before you try again.'

function readInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    return null
  }
}

function main() {
  const input = readInput()
  if (!input || input.tool_name !== 'Bash') return
  const problems = findForcePushes(String(input.tool_input?.command ?? ''))
  if (problems.length === 0) return
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `Blocked push: ${problems.join('; ')}.\n\n${HOW_TO_PUSH}`,
      },
    }),
  )
}

if (import.meta.url === `file://${process.argv[1]}`) main()
