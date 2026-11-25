#!/usr/bin/env node
import { readFileSync } from 'node:fs'

const LITERAL_SHA = /^[0-9a-f]{7,40}$/i
const SEGMENT_BREAKS = new Set([';', '&', '|', '\n'])
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace'])
const LEASE_PREFIX = '--force-with-lease'
const SHORT_FORCE = /^-[a-zA-Z]*f[a-zA-Z]*$/

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

function pushArgs(words) {
  const gitAt = words.findIndex((w) => w.text === 'git' || w.text.endsWith('/git'))
  if (gitAt === -1) return null
  let i = gitAt + 1
  while (i < words.length && words[i].text.startsWith('-')) {
    i += GIT_OPTIONS_WITH_VALUE.has(words[i].text) ? 2 : 1
  }
  if (words[i]?.text !== 'push') return null
  return words.slice(i + 1)
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
  for (const words of splitCommand(command)) {
    const args = pushArgs(words)
    if (args === null) continue
    let options = true
    for (const word of args) {
      const text = word.text
      if (options && text === '--') {
        options = false
        continue
      }
      if (options && (text === '--force' || SHORT_FORCE.test(text))) {
        problems.push(`${text} overwrites the remote branch without checking what is there`)
        continue
      }
      if (options && text.startsWith(LEASE_PREFIX) && !text.startsWith('--force-with-lease-')) {
        const problem = leaseProblem(word)
        if (problem) problems.push(problem)
        continue
      }
      if (!text.startsWith('-') && text.startsWith('+')) {
        problems.push(`the refspec ${text} starts with +, which is a force push`)
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
