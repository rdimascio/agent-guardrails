#!/usr/bin/env node
import { readFileSync } from 'node:fs'

const LITERAL_SHA = /^[0-9a-f]{7,40}$/i
const SEGMENT_BREAKS = new Set([';', '&', '|', '\n'])
const HIDDEN_CODE = /\$\(|`|\beval\b|\b(?:sh|bash|zsh|dash|ksh)\s+(?:-\w+\s+)*-\w*c\b/
const FORCE_INDICATOR = /(?:^|[\s'"])(?:-\w*f\w*|--force|--mirror|--delete)(?=$|[\s'"=;&|)])|(?:^|[\s'"]):?\+[\w/*.@-]|(?:^|[\s'"]):[\w/*.@-]/
const DANGEROUS_CONFIG = [
  { pattern: /^remote\..+\.push=\s*\+/i, why: 'a -c remote.*.push value that starts with + is a force push' },
  { pattern: /^remote\..+\.mirror=\s*(?:true|yes|on|1)\s*$/i, why: 'a -c remote.*.mirror=true push mirrors and can delete remote branches' },
]
const LEASE_PREFIX = '--force-with-lease'
const SHORT_FORCE = /^-[a-zA-Z]*f[a-zA-Z]*$/
const SHORT_DELETE = /^-[a-zA-Z]*d[a-zA-Z]*$/

export function splitCommand(command) {
  const segments = []
  let words = []
  let word = null
  let quote = null
  let depth = 0

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
    if (ch === '$' && command[i + 1] === '(') {
      startWord()
      word.computed = true
      depth++
      word.text += '$('
      i++
      continue
    }
    if (depth > 0) {
      if (ch === ')') depth--
      word.text += ch
      continue
    }
    if (ch === '`' || (ch === '$' && /[A-Za-z_{]/.test(command[i + 1] ?? ''))) {
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
  return { globals: words.slice(gitAt + 1, pushAt), args: words.slice(pushAt + 1) }
}

function configValues(globals) {
  const values = []
  for (let k = 0; k < globals.length; k++) {
    const text = globals[k].text
    if (text === '-c' && globals[k + 1]) values.push(globals[++k].text)
    else if (text.startsWith('-c') && text.length > 2) values.push(text.slice(2))
  }
  return values
}

export function hidesForcePush(command) {
  return /\bgit\b/.test(command) && /\bpush\b/.test(command) && HIDDEN_CODE.test(command) && FORCE_INDICATOR.test(command)
}

function leaseProblem(word) {
  const value = word.text.slice(LEASE_PREFIX.length)
  if (value === '') return 'bare --force-with-lease compares against your remote-tracking ref, which any fetch moves'
  if (word.computed) return `the lease SHA in ${word.text} is computed inside the command`
  const [, expected] = value.slice(1).split(':')
  if (expected === undefined) return `${word.text} has no SHA, so it still trusts your remote-tracking ref`
  if (!LITERAL_SHA.test(expected)) return `the lease in ${word.text} is not a literal SHA`
  return null
}

export function findForcePushes(command) {
  const problems = []
  if (hidesForcePush(command)) {
    problems.push('the command runs nested code ($(...), backticks, eval or a shell -c) next to a git push with a force, mirror or delete option, so the hook cannot check it')
  }
  for (const words of splitCommand(command)) {
    const push = pushInvocation(words)
    if (push === null) continue
    for (const value of configValues(push.globals)) {
      for (const rule of DANGEROUS_CONFIG) if (rule.pattern.test(value)) problems.push(rule.why)
    }
    let options = true
    for (const word of push.args) {
      const text = word.text
      if (options && text === '--') {
        options = false
        continue
      }
      if (options && (text === '--force' || SHORT_FORCE.test(text))) {
        problems.push(`${text} overwrites the remote branch without checking what is there`)
        continue
      }
      if (options && (text === '--mirror' || text === '--delete' || SHORT_DELETE.test(text))) {
        problems.push(`${text} can delete or overwrite remote branches`)
        continue
      }
      if (options && text.startsWith(LEASE_PREFIX) && !text.startsWith('--force-with-lease-')) {
        const problem = leaseProblem(word)
        if (problem) problems.push(problem)
        continue
      }
      if (!options || !text.startsWith('-')) {
        if (text.startsWith('+')) problems.push(`the refspec ${text} starts with +, which is a force push`)
        else if (text.startsWith(':') && text.length > 1) problems.push(`the refspec ${text} deletes a remote branch`)
      }
    }
  }
  return problems
}

export const HOW_TO_PUSH =
  'Read the remote SHA yourself (git ls-remote origin <branch>), check it, then push with ' +
  'git push --force-with-lease=<branch>:<that-sha> origin <branch>. ' +
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
        permissionDecisionReason: `Blocked force push: ${problems.join('; ')}.\n\n${HOW_TO_PUSH}`,
      },
    }),
  )
}

if (import.meta.url === `file://${process.argv[1]}`) main()
