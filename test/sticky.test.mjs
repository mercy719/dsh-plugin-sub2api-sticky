import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, userIdFor, withUserId } from '../lib/index.js'

// Sub2API v0.2.19 ParseMetadataUserID legacy pattern.
const SUB2API = /^user_([a-fA-F0-9]{64})_account_([a-fA-F0-9-]*)_session_([a-fA-F0-9-]{36})$/
const DEV = 'a'.repeat(64)
const anthropic = { api: 'anthropic-messages' }

test('user_id matches Sub2API and is stable per session', () => {
  const a = userIdFor('s1', DEV)
  assert.match(a, SUB2API)
  assert.equal(a, userIdFor('s1', DEV))
  assert.notEqual(SUB2API.exec(a)[3], SUB2API.exec(userIdFor('s2', DEV))[3])
})

test('Anthropic requests get user_id and 1h cache unless already set', () => {
  const opts = Object.freeze({ sessionId: 's1', metadata: Object.freeze({ x: 1 }) })
  const out = withUserId(opts, anthropic, DEV)
  assert.deepEqual(out.metadata, { x: 1, user_id: userIdFor('s1', DEV) })
  assert.equal(out.cacheRetention, 'long')
  assert.equal(withUserId(opts, { api: 'openai-completions' }, DEV), opts)
  const noSession = withUserId({ metadata: {} }, anthropic, DEV)
  assert.deepEqual(noSession, { metadata: {}, cacheRetention: 'long' })
  const own = { sessionId: 's1', metadata: { user_id: 'mine' }, cacheRetention: 'short' }
  assert.equal(withUserId(own, anthropic, DEV), own)
  assert.equal(withUserId({ cacheRetention: 'none' }, anthropic, DEV).cacheRetention, 'none')
})

test('apply patches official adapters, including late ones, and stops on dispose', async () => {
  const seen = []
  class Adapter {
    streamWithSnapshot(options, snapshot) { return snapshot.models.streamSimple(anthropic, {}, options) }
  }
  const models = { streamSimple: (model, ctx, options) => seen.push(options) }
  const llm = { adapters: new Map(), directory: new Map() }
  let onUpdate, dispose
  const ctx = {
    llm,
    on: (event, fn) => { onUpdate = fn; return () => { onUpdate = undefined } },
    fiber: { effect: (fn) => { dispose = fn() } },
  }
  await apply(ctx)
  // Adapter registered after apply, announced through llm/adapters-updated.
  llm.directory.set('relay', { provider: 'relay', settingsNs: 'llm-pi-ai' })
  llm.adapters.set('relay', { adapter: new Adapter() })
  onUpdate()
  new Adapter().streamWithSnapshot({ sessionId: 's1' }, { models })
  assert.match(seen[0].metadata.user_id, SUB2API)
  dispose()
  new Adapter().streamWithSnapshot({ sessionId: 's1' }, { models })
  assert.equal(seen[1].metadata, undefined)
})
