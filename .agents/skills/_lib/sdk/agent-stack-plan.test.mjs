import assert from 'node:assert/strict'
import test from 'node:test'

import {
  STACK,
  applyTrainReleases,
  recommendVersion,
  trainsByPackage
} from './agent-stack-plan.mjs'
import { readRepoJson } from '../../../../.github/scripts/lib/release-train.mjs'

const trainOf = trainsByPackage(
  readRepoJson('.github/release-trains.json'),
  readRepoJson('nx.json')
)

function entry (spec, reasons = [], blockers = []) {
  return {
    slug: spec.slug,
    npmName: `@qvac/${spec.slug}`,
    localVersion: '0.15.0',
    publishedVersion: '0.15.0',
    reasons,
    blockers,
    outstanding: [],
    hasBreaking: false,
    needsWork: reasons.length > 0,
    needsRelease: reasons.length > 0 && blockers.length === 0
  }
}

function finish (packages) {
  const bySlug = new Map(packages.map((p) => [p.slug, p]))
  for (const [i, p] of packages.entries()) {
    p.needsWork = p.reasons.length > 0
    p.needsRelease = p.needsWork && p.blockers.length === 0
    p.recommendation = recommendVersion(p, STACK[i], bySlug)
  }
  return bySlug
}

test('every agent-stack package belongs to the sdk train', () => {
  for (const spec of STACK) assert.equal(trainOf.get(`@qvac/${spec.slug}`), 'sdk')
})

test('one changed train package gives every unchanged member a patch', () => {
  const packages = STACK.map((spec) =>
    entry(spec, spec.slug === 'ai-sdk-provider' ? ['code_changes'] : [])
  )
  applyTrainReleases(packages, trainOf)
  const bySlug = finish(packages)

  const cli = bySlug.get('cli')
  assert.equal(cli.needsRelease, true)
  assert.equal(cli.recommendation.suggested, '0.15.1')
  assert.equal(cli.recommendation.rationale, 'Released with the sdk train')
  assert.equal(
    bySlug.get('ai-sdk-provider').recommendation.rationale,
    'Outstanding non-breaking commits → patch'
  )
})

test('no train release when no member needs one', () => {
  const packages = STACK.map((spec) => entry(spec))
  applyTrainReleases(packages, trainOf)
  const bySlug = finish(packages)
  for (const p of bySlug.values()) assert.equal(p.needsRelease, false)
})

test('a blocked member stays blocked inside an active train', () => {
  const blocker = { code: 'ai_sdk_major_mismatch', message: 'hold' }
  const packages = STACK.map((spec) => {
    if (spec.slug === 'cli') return entry(spec, ['code_changes'])
    if (spec.slug === 'openclaw-plugin') return entry(spec, [], [blocker])
    return entry(spec)
  })
  applyTrainReleases(packages, trainOf)
  const bySlug = finish(packages)
  assert.equal(bySlug.get('openclaw-plugin').needsRelease, false)
  assert.equal(bySlug.get('openclaw-plugin').recommendation.kind, 'blocked')
})
