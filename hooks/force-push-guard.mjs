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
const PINNED_LEASE = /^--force-with-lease=([^:]+):(.+)$/

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
const REMOTE_CONFIG = /(?:^|[=\s'"])remote\./i
const CONFIG_GLOBALS = new Set(['-c', '--config-env'])

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

function pushInvocation(words) {
  const gitAt = words.findIndex(isGitWord)
  if (gitAt === -1) return null
  const pushAt = words.findIndex((w, k) => k > gitAt && w.text === 'push')
  if (pushAt === -1) return null
  return { prefix: words.slice(0, gitAt), globals: words.slice(gitAt + 1, pushAt), args: words.slice(pushAt + 1) }
}

function configProblems(globals) {
  const problems = []
  for (let k = 0; k < globals.length; k++) {
    const text = globals[k].text
    const inline = ['-c', '--config-env='].find((flag) => text.startsWith(flag) && text !== '-c')
    if (CONFIG_GLOBALS.has(text) || inline !== undefined) {
      const value = inline === undefined ? (globals[++k]?.text ?? '') : text.slice(inline.length)
      if (REMOTE_CONFIG.test(value) || text.startsWith('--config-env')) problems.push(`${text} ${value}`.trim() + ' changes remote or push config for this push')
    }
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
  return null
}

function nestingProblems(command) {
  if (!/git/.test(command) || !/push/.test(command)) return []
  return NESTING.filter((rule) => rule.pattern.test(command)).map((rule) => `the command mentions git push and ${rule.why}, so the hook cannot see what really runs`)
}

export function findForcePushes(command) {
  const problems = [...nestingProblems(command)]
  const segments = splitCommand(command)
  const pushes = segments.map(pushInvocation).filter((push) => push !== null)
  if (pushes.length > 0 && GIT_CONFIG_ENV.test(command)) problems.push('GIT_CONFIG_* variables can change remote or push config for this push')
  for (const push of pushes) {
    problems.push(...configProblems(push.globals))
    const computed = [...push.prefix, ...push.globals, ...push.args].filter((word) => word.computed)
    for (const word of computed) problems.push(`${word.text} is computed when the command runs, so the hook cannot check it`)
    let options = true
    for (const word of push.args) {
      if (word.computed) continue
      const text = word.text
      if (options && text === '--') {
        options = false
        continue
      }
      const problem = options && text.startsWith('-') && text.length > 1 ? optionProblem(text) : refspecProblem(text)
      if (problem) problems.push(problem)
    }
  }
  return problems
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
