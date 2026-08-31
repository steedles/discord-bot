import { describe, expect, it } from 'vitest'
import { parseUserIds } from '../../discord/mentions.js'

/**
 * Ping targets are typed by hand into a settings box, so the parser has to cope
 * with however somebody happened to paste them. A parse that silently yields
 * nothing produces a channel that looks like it is working and never pings.
 */
describe('parseUserIds', () => {
  it('reads a bare id', () => {
    expect(parseUserIds('123456789012345678')).toEqual(['123456789012345678'])
  })

  it('reads a pasted mention', () => {
    expect(parseUserIds('<@123456789012345678>')).toEqual(['123456789012345678'])
  })

  it('reads the nickname form of a mention', () => {
    expect(parseUserIds('<@!123456789012345678>')).toEqual(['123456789012345678'])
  })

  it('accepts commas, spaces and newlines between ids', () => {
    const expected = ['123456789012345678', '987654321098765432']
    expect(parseUserIds('123456789012345678, 987654321098765432')).toEqual(expected)
    expect(parseUserIds('123456789012345678 987654321098765432')).toEqual(expected)
    expect(parseUserIds('123456789012345678\n987654321098765432')).toEqual(expected)
    expect(parseUserIds('<@123456789012345678> <@987654321098765432>')).toEqual(expected)
  })

  it('drops the same person listed twice', () => {
    expect(parseUserIds('123456789012345678, <@123456789012345678>')).toEqual([
      '123456789012345678',
    ])
  })

  it('ignores anything that is not snowflake-shaped', () => {
    expect(parseUserIds('')).toEqual([])
    expect(parseUserIds('   ')).toEqual([])
    expect(parseUserIds('@steedles')).toEqual([])
    expect(parseUserIds('12345')).toEqual([])
  })

  it('caps the list so one field cannot ping a crowd', () => {
    const many = Array.from({ length: 20 }, (_, i) => `1234567890123456${String(i).padStart(2, '0')}`)
    expect(parseUserIds(many.join(' '))).toHaveLength(10)
  })
})
