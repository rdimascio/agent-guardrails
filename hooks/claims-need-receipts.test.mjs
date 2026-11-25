import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { claimsIn, verdict } from './claims-need-receipts.mjs'

const HOOK = fileURLToPath(new URL('./claims-need-receipts.mjs', import.meta.url))
const FIXTURES = mkdtempSync(path.join(tmpdir(), 'claims-need-receipts-'))

const prompt = (text) => ({ type: 'user', message: { role: 'user', content: text } })
const say = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })
const call = (name, input = {}) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `t-${name}`, name, input }] } })
const result = (text) => ({ type: 'user', toolUseResult: {}, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: [{ type: 'text', text }] }] } })
const jsonl = (entries) => entries.map((e) => JSON.stringify(e)).join('\n')

function runHook(name, entries, extra = {}) {
  const transcript = path.join(FIXTURES, `${name}.jsonl`)
  writeFileSync(transcript, jsonl(entries))
  const input = { hook_event_name: 'Stop', transcript_path: transcript, ...extra }
  return String(execFileSync('node', [HOOK], { input: JSON.stringify(input) }))
}

test('blocks "tests pass" when the turn only edited files', () => {
  const out = runHook('edit-only', [
    prompt('fix the parser'),
    call('Edit', { file_path: '/a.ts' }),
    result('The file /a.ts has been updated successfully.'),
    say('Fixed the null check. All tests pass.'),
  ])
  assert.equal(JSON.parse(out).decision, 'block')
  assert.match(JSON.parse(out).reason, /tests pass/i)
})

test('blocks "merged" with no git, gh or MCP call', () => {
  const out = runHook('merged-no-call', [prompt('status?'), say('I merged it and the branch is clean.')])
  assert.equal(JSON.parse(out).decision, 'block')
})

test('blocks a bare "Fixed" with no tool call in the turn', () => {
  const out = runHook('fixed-no-tools', [prompt('the button is off'), say('Fixed. The button lines up now.')])
  assert.equal(JSON.parse(out).decision, 'block')
})

test('evidence from an earlier turn does not count', () => {
  const out = runHook('old-evidence', [
    prompt('run the tests'),
    call('Bash', { command: 'npm test' }),
    result('ok'),
    prompt('and now?'),
    say('All tests pass.'),
  ])
  assert.equal(JSON.parse(out).decision, 'block')
})

test('passes "tests pass" after a test run', () => {
  const out = runHook('tests-ran', [
    prompt('fix the parser'),
    call('Bash', { command: 'npm test' }),
    result('Tests: 12 passed, 12 total'),
    say('Fixed. Tests pass.'),
  ])
  assert.equal(out, '')
})

test('passes "pushed" after a git push', () => {
  const out = runHook('pushed', [prompt('push it'), call('Bash', { command: 'git push origin feat' }), result('ok'), say('Pushed.')])
  assert.equal(out, '')
})

test('passes questions, hedges and negations', () => {
  assert.equal(runHook('question', [prompt('hi'), say('Should I merge it now that the tests pass?')]), '')
  assert.equal(runHook('hedged', [prompt('plan'), say('Once CI is green it will be merged.')]), '')
  assert.equal(runHook('negated', [prompt('status'), say('Nothing is merged yet. I have not pushed the branch.')]), '')
})

test('passes a claim that cites an id from an earlier tool result', () => {
  const out = runHook('cites-id', [
    prompt('merge 2089'),
    call('Bash', { command: 'gh pr merge 2089' }),
    result('Merged pull request #2089'),
    prompt('is it in?'),
    say('Yes. #2089 was merged.'),
  ])
  assert.equal(out, '')
})

test('never loops: stop_hook_active short-circuits', () => {
  assert.equal(runHook('loop-guard', [prompt('x'), say('Done. Tests pass.')], { stop_hook_active: true }), '')
})

test('claimsIn ignores code blocks, quotes and labels', () => {
  assert.deepEqual(claimsIn('```\nDone. tests pass\n```\n> merged'), [])
  assert.deepEqual(claimsIn('**Done:**\n- item'), [])
})

test('verdict prefers last_assistant_message over the transcript reply', () => {
  const transcriptText = jsonl([prompt('x'), say('Looking now.')])
  assert.equal(verdict({ reply: 'Done.', transcriptText })?.kind, 'generic')
})
