import { describe, expect, it } from 'vitest'
import { pingFor } from '../mentions.js'
import { readSettings } from '../../features/types.js'
import type { FeatureSettings } from '../../features/types.js'

const read = (settings: FeatureSettings) => readSettings(settings)

const ROLE = '123456789012345678'
const OTHER_ROLE = '987654321098765432'
const USER = '111111111111111111'

/**
 * The ping line is the one part of an alert that reaches people who are not
 * looking at the channel, so the failures that matter are the quiet ones: a
 * role that stops being pinged after an upgrade, or one that gets pinged when
 * the channel asked for silence.
 */
describe('pingFor', () => {
  it('pings the roles a channel picked', () => {
    const ping = pingFor(read({ mentionRoles: [ROLE, OTHER_ROLE] }))
    expect(ping?.content).toBe(`<@&${ROLE}> <@&${OTHER_ROLE}>`)
    expect(ping?.allowed).toEqual({ users: [], roles: [ROLE, OTHER_ROLE] })
  })

  it('says nothing when no role and nobody is named', () => {
    expect(pingFor(read({ mentionRoles: [] }))).toBeUndefined()
  })

  it('still honours a role configured before the picker existed', () => {
    const ping = pingFor(read({ mentionRoleId: ROLE }))
    expect(ping?.content).toBe(`<@&${ROLE}>`)
  })

  it('prefers the picker once it has been used', () => {
    const ping = pingFor(read({ mentionRoles: [OTHER_ROLE], mentionRoleId: ROLE }))
    expect(ping?.allowed.roles).toEqual([OTHER_ROLE])
  })

  it('holds the ping back on a low-priority alert by default', () => {
    expect(pingFor(read({ mentionRoles: [ROLE] }), { priority: 'normal' })).toBeUndefined()
    expect(pingFor(read({ mentionRoles: [ROLE] }), { priority: 'high' })?.content).toBe(`<@&${ROLE}>`)
  })

  it('pings every alert when the channel asked for that', () => {
    const ping = pingFor(read({ mentionRoles: [ROLE], pingOn: 'every' }), { priority: 'normal' })
    expect(ping?.content).toBe(`<@&${ROLE}>`)
  })

  it('says nothing at all when pinging is off, whoever is named', () => {
    const settings = { mentionRoles: [ROLE], mentionUserIds: USER, pingOn: 'never' }
    expect(pingFor(read(settings), { priority: 'high' })).toBeUndefined()
  })

  /**
   * A feature with no priority grade - a launch, a price target - must not have
   * its ping held back by a `pingOn` default it never declares a field for.
   */
  it('ignores pingOn when the feature does not grade its alerts', () => {
    expect(pingFor(read({ mentionRoles: [ROLE] }))?.content).toBe(`<@&${ROLE}>`)
  })

  it('adds the person an alert belongs to, without losing the roles', () => {
    const ping = pingFor(read({ mentionRoles: [ROLE] }), { extraUserIds: [USER] })
    expect(ping?.content).toBe(`<@&${ROLE}> <@${USER}>`)
    expect(ping?.allowed).toEqual({ users: [USER], roles: [ROLE] })
  })

  it('names every mention explicitly, so nothing else can be pinged', () => {
    const ping = pingFor(read({ mentionRoles: [ROLE], mentionUserIds: `@everyone ${USER}` }))
    expect(ping?.allowed).toEqual({ users: [USER], roles: [ROLE] })
    expect(ping?.content).not.toContain('@everyone')
  })
})
