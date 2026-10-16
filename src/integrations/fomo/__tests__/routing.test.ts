import { describe, expect, it } from 'vitest'
import { normaliseHandle, prepareRoute, routeAllows } from '../routing.js'

describe('fomo server routing', () => {
  it('normalises a handle the way the feed will later compare it', () => {
    expect(normaliseHandle('  @FrankDeGods ')).toBe('frankdegods')
    expect(normaliseHandle('unipcs')).toBe('unipcs')
    expect(normaliseHandle('bad handle')).toBeNull()
    expect(normaliseHandle('@')).toBeNull()
  })

  it('lets an unrestricted server hear everyone, including a server with no row', () => {
    expect(routeAllows(undefined, 'frankdegods')).toBe(true)
    expect(routeAllows({ restricted: false, handles: ['orangie'] }, 'frankdegods')).toBe(true)
  })

  it('limits a restricted server to the accounts that were ticked', () => {
    const route = { restricted: true, handles: ['frankdegods', 'unipcs'] }
    expect(routeAllows(route, '@FrankDeGods')).toBe(true)
    expect(routeAllows(route, 'orangie')).toBe(false)
    expect(routeAllows(route, undefined)).toBe(false)
  })

  it('rejects a save that contains a handle the feed could never match', () => {
    const bad = prepareRoute(true, ['orangie', 'not a handle'])
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.invalid).toEqual(['not a handle'])
  })

  it('stores a restricted list once, lowercase, in a stable order', () => {
    const prepared = prepareRoute(true, ['@Unipcs', 'frankdegods', 'unipcs'])
    expect(prepared).toEqual({
      ok: true,
      route: { restricted: true, handles: ['frankdegods', 'unipcs'] },
    })
  })
})
