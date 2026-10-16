import { describe, expect, it, vi } from 'vitest'

vi.stubEnv('DISCORD_TOKEN', 'test-token')
vi.stubEnv('DISCORD_CLIENT_ID', '000000000000000000')

const { allowedGuildIds } = await import('../access.js')

const BOT = new Set(['alpha', 'falco', 'kanto'])

describe('dashboard server access', () => {
  it('keeps a Discord login to the servers it could manage when it signed in', () => {
    const ids = allowedGuildIds(
      { local: false, username: 'Falco', guildIds: ['falco', 'somewhere-else'] },
      BOT,
      null,
    )
    expect(ids).toEqual(['falco'])
  })

  it('lets an unrestricted password login see every server the bot is in', () => {
    expect(allowedGuildIds({ local: true, username: 'ash', guildIds: [] }, BOT, null)).toEqual([
      'alpha',
      'falco',
      'kanto',
    ])
    expect(
      allowedGuildIds({ local: true, username: 'ash', guildIds: [] }, BOT, {
        restricted: false,
        guildIds: ['falco'],
      }),
    ).toEqual(['alpha', 'falco', 'kanto'])
  })

  it('limits a restricted password login to the servers that were ticked', () => {
    expect(
      allowedGuildIds({ local: true, username: 'falco', guildIds: [] }, BOT, {
        restricted: true,
        guildIds: ['falco', 'left-the-bot'],
      }),
    ).toEqual(['falco'])
  })

  it('does not let a saved row take servers away from the owner login', () => {
    const ids = allowedGuildIds({ local: true, username: 'Wayne@Steedman.co.za', guildIds: [] }, BOT, {
      restricted: true,
      guildIds: [],
    })
    expect(ids).toEqual(['alpha', 'falco', 'kanto'])
  })
})
