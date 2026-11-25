#!/usr/bin/env node
import { readFileSync } from 'node:fs'

const SYMPTOM =
  /\b(not working|isn'?t working|doesn'?t work|stopped working|still (?:being|getting|seeing|failing|broken|happening)|broken|failing|fails|failed|error|errors|bug|regress\w*|rate.?limit\w*|throttl\w*|429s?|5\d\ds?|timing out|timeout|timed out|hangs?|stuck|something'?s wrong|not showing)\b/i

export const GUIDANCE = [
  'EVIDENCE BEFORE CHANGE: this prompt reports a problem. A symptom word is not a cause.',
  '1. Find the failing event itself: the HTTP status, the error log line, the failing request, or a repro.',
  '2. State the cause in one sentence and cite that evidence.',
  '3. Only then change code, config or flags, commit, or open a PR.',
  'If you cannot get evidence, say what you checked and ask. Do not guess a cause and build on the guess.',
].join('\n')

export function guidanceFor(prompt) {
  return SYMPTOM.test(prompt) ? GUIDANCE : ''
}

function readPrompt() {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8') || '{}')
    return typeof input.prompt === 'string' ? input.prompt : ''
  } catch {
    return ''
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const additionalContext = guidanceFor(readPrompt())
  if (additionalContext) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } }))
  }
}
