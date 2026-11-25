import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { findForcePushes } from './force-push-guard.mjs'

const HOOK = fileURLToPath(new URL('./force-push-guard.mjs', import.meta.url))
const SHA = 'cf6c1b600d171828e2803707025f03fea1445fb7'

function decision(command, toolName = 'Bash') {
  const out = execFileSync('node', [HOOK], {
    encoding: 'utf8',
    input: JSON.stringify({ tool_name: toolName, tool_input: { command } }),
  })
  return out.trim() ? JSON.parse(out).hookSpecificOutput.permissionDecision : 'allow'
}

test('denies --force and -f', () => {
  assert.equal(decision('git push --force origin feat'), 'deny')
  assert.equal(decision('git push -f origin feat'), 'deny')
  assert.equal(decision('git push -uf origin feat'), 'deny')
})

test('denies a bare --force-with-lease', () => {
  assert.equal(decision('git push --force-with-lease origin feat'), 'deny')
  assert.equal(decision('git push --force-with-lease=feat origin feat'), 'deny')
})

test('denies a lease that is a ref, not a SHA', () => {
  assert.equal(decision('git push --force-with-lease=feat:origin/feat origin feat'), 'deny')
})

test('denies a lease SHA computed inside the command', () => {
  assert.equal(decision('git push --force-with-lease=feat:$(git rev-parse origin/feat) origin feat'), 'deny')
  assert.equal(decision('git push --force-with-lease=feat:`git rev-parse origin/feat` origin feat'), 'deny')
  assert.equal(decision('git push --force-with-lease=feat:$SHA origin feat'), 'deny')
})

test('denies a + refspec', () => {
  assert.equal(decision('git push origin +feat'), 'deny')
  assert.equal(decision('git push origin +HEAD:feat'), 'deny')
})

test('finds a force push later in a chain and behind git options', () => {
  assert.equal(decision('git fetch && git -C ../repo push --force origin feat'), 'deny')
  assert.equal(decision('echo hi; git -c push.default=current push -f'), 'deny')
})

test('allows the pinned form with a literal SHA', () => {
  assert.equal(decision(`git push --force-with-lease=feat:${SHA} origin feat`), 'allow')
  assert.equal(decision(`git push --force-with-lease=feat:${SHA.slice(0, 12)} --force-if-includes origin feat`), 'allow')
})

test('allows normal pushes and other commands', () => {
  assert.equal(decision('git push origin feat'), 'allow')
  assert.equal(decision('git push -u origin feat'), 'allow')
  assert.equal(decision('git commit -m "no --force here"'), 'allow')
  assert.equal(decision("echo 'git push --force'"), 'allow')
  assert.equal(decision('git push --force', 'Edit'), 'allow')
})

test('explains each problem', () => {
  assert.equal(findForcePushes('git push --force-with-lease origin feat').length, 1)
  assert.deepEqual(findForcePushes('ls -la'), [])
})
