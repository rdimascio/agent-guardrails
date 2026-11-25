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

function denies(commands) {
  for (const command of commands) assert.notDeepEqual(findForcePushes(command), [], `should deny: ${command}`)
}

function allows(commands) {
  for (const command of commands) assert.deepEqual(findForcePushes(command), [], `should allow: ${command}`)
}

test('the hook denies through PreToolUse and ignores other tools', () => {
  assert.equal(decision('git push --force origin feat'), 'deny')
  assert.equal(decision('git push origin feat'), 'allow')
  assert.equal(decision('git push --force', 'Edit'), 'allow')
})

test('denies --force, -f and short flag bundles with f', () => {
  denies(['git push --force origin feat', 'git push -f origin feat', 'git push -uf origin feat'])
})

test('denies abbreviated long options', () => {
  denies(['git push --forc origin feat', 'git push --for origin feat', 'git push --mir origin', 'git push --del origin feat'])
})

test('denies --mirror, --all, --prune and every form of delete', () => {
  denies([
    'git push --mirror origin',
    'git push --all origin',
    'git push --prune origin refs/heads/*:refs/heads/*',
    'git push --delete origin feat',
    'git push -d origin feat',
    'git push origin :feat',
    'git push origin :refs/heads/feat',
  ])
})

test('denies options that are not on the allow list', () => {
  denies(['git push -o ci.skip origin feat', 'git push --push-option=x origin feat', 'git push --receive-pack=/tmp/x origin feat', 'git push --repo=origin'])
})

test('denies a bare or unpinned --force-with-lease', () => {
  denies([
    'git push --force-with-lease origin feat',
    'git push --force-with-lease=feat origin feat',
    'git push --force-with-lease=feat:origin/feat origin feat',
    'git push --force-with-le origin feat',
  ])
})

test('denies + refspecs', () => {
  denies(['git push origin +feat', 'git push origin +HEAD:feat', 'git push origin -- +feat'])
})

test('denies computed words anywhere in a push', () => {
  denies([
    'git push --force-with-lease=feat:$(git rev-parse origin/feat) origin feat',
    'git push --force-with-lease=feat:`git rev-parse origin/feat` origin feat',
    'git push --force-with-lease=feat:$SHA origin feat',
    'F=--force; git push $F origin feat',
    'git push origin "$BRANCH"',
    'git push origin ${BRANCH}',
  ])
})

test('denies remote config from -c, --config-env and GIT_CONFIG_*', () => {
  denies([
    'git -c remote.origin.push=+refs/heads/*:refs/heads/* push origin',
    'git -c remote.origin.mirror=true push origin',
    'git -c remote.origin.push=refs/heads/feat:refs/heads/feat push origin',
    'git --config-env=remote.origin.mirror=MIRROR push origin',
    'git --config-env remote.origin.push=SPEC push origin',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.origin.mirror GIT_CONFIG_VALUE_0=true git push origin',
    'GIT_CONFIG_PARAMETERS="\'remote.origin.mirror\'=\'true\'" git push origin',
  ])
})

test('finds push behind any git global option', () => {
  denies([
    'git --attr-source HEAD --super-prefix x/ push -f origin feat',
    'git --exec-path=/tmp --no-pager push origin +feat',
    'git --list-cmds=main push --force origin feat',
    'git -C ../repo push --mirror origin',
  ])
})

test('denies nesting around a push even with no force word', () => {
  denies([
    'bash -c "git push origin feat"',
    "sh -c 'git push origin feat'",
    'zsh -c "git push origin +feat"',
    'eval "git push origin feat"',
    'echo "git push origin feat" | sh',
    'echo "git push origin feat" | /bin/bash',
    'bash <<EOF\ngit push origin feat\nEOF',
    'bash <<< "git push origin feat"',
    'echo feat | xargs git push origin',
    'echo $(git push origin feat)',
    'python3 -c "import os; os.system(\'git push origin feat\')"',
    "node -e \"require('child_process').execSync('git push origin feat')\"",
    'ruby -e "system(%q(git push origin feat))"',
  ])
})

test('finds a push later in a chain', () => {
  denies(['git fetch && git push --force origin feat', 'echo hi; git push -f', 'true || (git push --mirror origin)'])
})

test('allows plain pushes and allow-listed options', () => {
  allows([
    'git push',
    'git push origin feat',
    'git push -u origin feat',
    'git push --set-upstream origin feat',
    'git push --tags',
    'git push --follow-tags origin feat',
    'git push --dry-run origin feat',
    'git push -n -q -v origin feat',
    'git push -uv origin feat',
    'git push --no-verify --atomic --porcelain origin feat',
    'git -C ../repo push origin feat',
    'git -c push.default=current push',
    'git push origin HEAD:refs/heads/feat',
    'git fetch && git push origin feat',
  ])
})

test('allows the pinned lease with a literal SHA', () => {
  allows([
    `git push --force-with-lease=feat:${SHA} origin feat`,
    `git push --force-with-lease=feat:${SHA.slice(0, 12)} --force-if-includes origin feat`,
  ])
})

test('ignores commands that are not a push', () => {
  allows(['ls -la', 'git commit -m "no --force here"', "echo 'git push --force'", 'git log --grep=push', 'bun run test'])
})
