#!/usr/bin/env node
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs'

const TAIL_BYTES = 600_000

const TEST_CLAIM =
  /\b(?:tests?|specs?|suites?|checks?|ci|builds?|typecheck|lint)\b[^.\n]{0,40}?\b(?:pass(?:es|ed|ing)?|green|succeed(?:s|ed)?)\b|\ball (?:green|passing)\b/i
const SHIP_VERB = '(?:merged|deployed|pushed|shipped|released|published)'
const SHIP_CLAIM = new RegExp(
  `\\b(?:I|we)\\s+(?:have\\s+|just\\s+)?${SHIP_VERB}\\b|\\b(?:is|are|was|were|has been|have been|now)\\s+${SHIP_VERB}\\b|^\\W*${SHIP_VERB}\\b`,
  'i',
)
const GENERIC_CLAIM =
  /^\W*(?:done|fixed|verified|confirmed)\b(?![-:*])|\b(?:is|are|now|all|has been|have been)\s+(?:done|fixed|resolved)\b|\b(?:it|this|that|everything)\s+(?:now\s+)?works\b|\bworks now\b|\bworking now\b|\bI (?:verified|confirmed|tested)\b/i

const HEDGE =
  /\b(?:if|once|after|when|until|before|will|should|would|could|might|may|can|need(?:s|ed)? to|to be|not yet|pending|plan(?:ned)? to|expect\w*|unless|whether|claims?|claimed|says?|said|reports?|reported|according to|thought|assumed|agent|subagent|reviewer)\b/i

const NEGATOR_BEFORE = /(?:\b(?:nothing|none|not|never|no longer)\b|n['’]t\b)[^\n]{0,25}$/i
const NEGATOR_AFTER = /^[^\n]{0,20}\b(?:nothing|none)\b/i
const CLAUSE_BREAK = /[.!?,|\n;:]/

const TEST_CMD =
  /\b(?:test|tests|vitest|jest|mocha|pytest|tsc|typecheck|lint|eslint|yarn|npm|pnpm|bun|cargo|make|go\s+test|rspec|phpunit)\b|node\s+--test|gh\s+(?:pr\s+checks|run)\b/
const SHIP_CMD = /\b(?:git|gh|deploy\w*|wrangler|vercel|fly|kubectl|aws|npm\s+publish)\b/
const IDENTIFIER = /#\d{2,}|\b\d+\/\d+\b|\b[0-9a-f]{7,40}\b|\b\d+\s+(?:passed|passing|tests?|pass|failed)\b/g
const CODE_SPAN = /`([^`\n]{4,})`/g

const DELEGATION_TOOLS = ['Agent', 'Task']
const SHELL_TOOL = 'Bash'
const MCP_PREFIX = 'mcp__'

export const NEEDED = {
  test: 'a test, typecheck or CI command run this turn',
  ship: 'a git, gh, deploy or MCP call this turn',
  generic: 'any tool result this turn',
}

export function prose(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .split('\n')
    .map((line) => (/^\s*>/.test(line) ? '' : line))
    .join('\n')
}

function isNegated(text, index, length) {
  const before = text.slice(Math.max(0, index - 120), index)
  const after = text.slice(index + length, index + length + 60)
  const beforeClause = before.split(CLAUSE_BREAK).pop() ?? ''
  const afterClause = after.split(CLAUSE_BREAK).shift() ?? ''
  return NEGATOR_BEFORE.test(beforeClause) || NEGATOR_AFTER.test(afterClause)
}

function sentences(text) {
  return prose(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export function claimsIn(reply) {
  const claims = []
  for (const sentence of sentences(reply)) {
    if (sentence.endsWith('?') || HEDGE.test(sentence)) continue
    for (const [kind, re] of [
      ['test', TEST_CLAIM],
      ['ship', SHIP_CLAIM],
      ['generic', GENERIC_CLAIM],
    ]) {
      const m = sentence.match(re)
      if (m && !isNegated(sentence, m.index, m[0].length)) {
        claims.push({ kind, phrase: m[0].trim(), sentence })
        break
      }
    }
  }
  return claims
}

function isTypedPrompt(entry) {
  return (
    entry?.type === 'user' &&
    entry.toolUseResult === undefined &&
    entry.isMeta !== true &&
    entry.isSidechain !== true &&
    !(Array.isArray(entry.message?.content) && entry.message.content.some((part) => part?.type === 'tool_result'))
  )
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part?.type === 'text')
    .map((part) => part.text)
    .join('\n')
}

export function scanTurn(transcriptText) {
  let turn = { tools: [], results: [], reply: '' }
  const allResults = []
  for (const line of transcriptText.split('\n')) {
    if (!line.trim()) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry.isSidechain === true) continue
    if (isTypedPrompt(entry)) {
      turn = { tools: [], results: [], reply: '' }
      continue
    }
    const content = entry.message?.content
    if (!Array.isArray(content)) continue
    if (entry.type === 'assistant') {
      for (const part of content) {
        if (part?.type === 'tool_use') turn.tools.push({ name: part.name ?? '', command: String(part.input?.command ?? '') })
      }
      const text = textOf(content).trim()
      if (text) turn.reply = text
      continue
    }
    if (entry.type === 'user') {
      for (const part of content) {
        if (part?.type !== 'tool_result') continue
        const text = textOf(part.content)
        turn.results.push(text)
        allResults.push(text)
      }
    }
  }
  return { ...turn, allResults: allResults.join('\n') }
}

function citesToolOutput(reply, allResults) {
  if (!allResults) return false
  const tokens = [...reply.matchAll(CODE_SPAN)].map((m) => m[1]).concat(reply.match(IDENTIFIER) ?? [])
  return tokens.some((token) => allResults.includes(token))
}

function hasEvidence(kind, turn) {
  if (turn.tools.some((t) => DELEGATION_TOOLS.includes(t.name))) return true
  if (kind === 'generic') return turn.results.length > 0
  const shell = turn.tools.filter((t) => t.name === SHELL_TOOL).map((t) => t.command)
  if (kind === 'test') return shell.some((c) => TEST_CMD.test(c))
  return turn.tools.some((t) => t.name.startsWith(MCP_PREFIX)) || shell.some((c) => SHIP_CMD.test(c))
}

export function decide({ reply, turn }) {
  const text = (reply || '').trim()
  if (!text) return null
  const claims = claimsIn(text)
  if (claims.length === 0) return null
  if (citesToolOutput(text, turn.allResults)) return null
  return claims.find((claim) => !hasEvidence(claim.kind, turn)) ?? null
}

export function verdict({ reply, transcriptText }) {
  const turn = scanTurn(transcriptText)
  return decide({ reply: reply || turn.reply, turn })
}

export function blockReason(claim) {
  return (
    `Your reply claims "${claim.phrase}" ("${claim.sentence.slice(0, 120)}"), but nothing in this turn shows it: ` +
    `the claim needs ${NEEDED[claim.kind]}. ` +
    'Run the check now and cite its output (the command and the result line), ' +
    'or send the reply again with the claim marked as not checked.'
  )
}

function tail(path) {
  try {
    const size = statSync(path).size
    const start = Math.max(0, size - TAIL_BYTES)
    const fd = openSync(path, 'r')
    const buf = Buffer.alloc(size - start)
    readSync(fd, buf, 0, buf.length, start)
    closeSync(fd)
    return buf.toString('utf8')
  } catch {
    return ''
  }
}

function main() {
  let input
  try {
    input = JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    return
  }
  if (input.stop_hook_active || !input.transcript_path) return
  const claim = verdict({ reply: input.last_assistant_message, transcriptText: tail(input.transcript_path) })
  if (claim) process.stdout.write(JSON.stringify({ decision: 'block', reason: blockReason(claim) }))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main()
  } catch {
    process.exitCode = 0
  }
}
