// Gives every Anthropic request a stable per-session metadata.user_id in the
// Claude Code format, so Sub2API-style gateways keep one conversation on one
// upstream account and its prompt cache stays warm. Without it Sub2API hashes
// the cache_control-marked message, which moves every turn.
//
// Hook point adapted from @mzzsfy/dsh-llm-pi-gateway (MIT): the official
// llm-pi-ai adapter builds pi-ai options from a whitelist, so the only place
// to add metadata is the snapshot.models.streamSimple call it makes.

import { createHash } from 'node:crypto'
import { hostname } from 'node:os'

export const name = 'dsh-plugin-sub2api-sticky'
export const inject = ['llm']

const OFFICIAL_ROW = 'llm-pi-ai'
const PATCHED = Symbol.for('dsh-plugin-sub2api-sticky.patched')
const sha256 = (text) => createHash('sha256').update(text).digest('hex')

let active = false
let device

async function loadDevice() {
  try {
    const { getOrCreateAnonymousUserId } = await import('@deepseek-ai/dsh-anonymous-user-id')
    return sha256(getOrCreateAnonymousUserId())
  } catch {
    return sha256(`dsh-plugin-sub2api-sticky:${hostname()}`)
  }
}

/** Claude Code legacy format; Sub2API only reads the session part for stickiness. */
export function userIdFor(sessionId, deviceHex) {
  const h = sha256(sessionId)
  const uuid = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
  return `user_${deviceHex}_account__session_${uuid}`
}

/** pi-ai options are frozen: return a new object, never mutate. */
export function withUserId(options, model, deviceHex) {
  if (model?.api !== 'anthropic-messages' || !options || typeof options !== 'object') return options
  const next = {}
  // 1h cache: users often pause 5-30 min, which expires the default 5m cache and
  // rewrites the whole context. An explicit cacheRetention setting wins.
  if (options.cacheRetention === undefined) next.cacheRetention = 'long'
  const { sessionId, metadata } = options
  if (typeof sessionId === 'string' && sessionId && !metadata?.user_id) {
    next.metadata = { ...metadata, user_id: userIdFor(sessionId, deviceHex) }
  }
  return Object.keys(next).length ? { ...options, ...next } : options
}

function wrapModels(models) {
  if (!models || typeof models.streamSimple !== 'function') return models
  return new Proxy(models, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target)
      if (prop === 'streamSimple') {
        return (model, context, options) =>
          value.call(target, model, context, active && device ? withUserId(options, model, device) : options)
      }
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function patch(adapter) {
  const proto = adapter && Object.getPrototypeOf(adapter)
  if (!proto || typeof proto.streamWithSnapshot !== 'function') return false
  if (proto[PATCHED]) return true
  const original = proto.streamWithSnapshot
  // Wrapper stays after dispose and passes through once `active` is false.
  proto.streamWithSnapshot = function (options, snapshot) {
    return original.call(this, options, snapshot ? { ...snapshot, models: wrapModels(snapshot.models) } : snapshot)
  }
  proto[PATCHED] = true
  return true
}

export function sweep(llm) {
  if (!(llm?.adapters instanceof Map) || !(llm.directory instanceof Map)) return 0
  let n = 0
  for (const entry of llm.directory.values()) {
    if (entry?.settingsNs !== OFFICIAL_ROW) continue
    if (patch(llm.adapters.get(entry.provider)?.adapter)) n += 1
  }
  return n
}

export async function apply(ctx) {
  const llm = ctx.llm
  if (!(llm?.adapters instanceof Map)) {
    ctx.logger?.warn?.('sub2api-sticky: unexpected llm service shape, disabled')
    return
  }
  device ??= await loadDevice()
  active = true
  sweep(llm)
  // Official adapters may register after this plugin loads.
  const off = ctx.on('llm/adapters-updated', () => sweep(llm), { global: true })
  ctx.fiber?.effect?.(() => () => { active = false; off?.() })
}
