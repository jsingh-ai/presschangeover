import assert from 'node:assert/strict'
import test from 'node:test'
import { createRadiusQueryExecutor } from '../src/radius/create-radius-service.js'

test('single-connection Radius executor serializes concurrent repository queries', async () => {
  let active = 0
  let maximumActive = 0
  let releaseFirst!: () => void
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve })
  const calls: string[] = []
  const executor = createRadiusQueryExecutor(async (text) => {
    calls.push(text)
    active += 1
    maximumActive = Math.max(maximumActive, active)
    if (text === 'first') await firstBlocked
    active -= 1
    return { rows: [] }
  }, true)

  const first = executor.query('first')
  const second = executor.query('second')
  await Promise.resolve()

  assert.deepEqual(calls, ['first'])
  releaseFirst()
  await Promise.all([first, second])
  assert.deepEqual(calls, ['first', 'second'])
  assert.equal(maximumActive, 1)
})

test('default Radius executor preserves concurrent query execution', async () => {
  let active = 0
  let maximumActive = 0
  let release!: () => void
  const blocked = new Promise<void>((resolve) => { release = resolve })
  const executor = createRadiusQueryExecutor(async () => {
    active += 1
    maximumActive = Math.max(maximumActive, active)
    await blocked
    active -= 1
    return { rows: [] }
  }, false)

  const first = executor.query('first')
  const second = executor.query('second')
  await Promise.resolve()
  assert.equal(maximumActive, 2)
  release()
  await Promise.all([first, second])
})
