import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { guidanceFor } from './evidence-first.mjs'

const HOOK = fileURLToPath(new URL('./evidence-first.mjs', import.meta.url))

function run(input) {
  return String(execFileSync('node', [HOOK], { input }))
}

test('symptom words get the guidance', () => {
  for (const prompt of ['the login page is broken', 'ci keeps failing', 'we hit the rate limit again', 'the api call times out with a timeout', 'getting 502s on deploy']) {
    assert.match(guidanceFor(prompt), /EVIDENCE BEFORE CHANGE/, prompt)
  }
})

test('a build request gets nothing', () => {
  assert.equal(guidanceFor('add a cancel button to the settings page'), '')
})

test('the hook prints the guidance as UserPromptSubmit context', () => {
  const parsed = JSON.parse(run(JSON.stringify({ prompt: 'my messages are still rate limited' })))
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit')
  assert.match(parsed.hookSpecificOutput.additionalContext, /Find the failing event/)
})

test('the hook prints nothing for a build request or bad input', () => {
  assert.equal(run(JSON.stringify({ prompt: 'add a cancel button' })), '')
  assert.equal(run('not json'), '')
})
