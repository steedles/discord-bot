import { describe, expect, it } from 'vitest'
import { bandValue, validateSettings, type Band, type FeatureDescriptor } from '../types.js'

const feature: FeatureDescriptor = {
  id: 'test',
  name: 'Test',
  description: 'x',
  icon: '🧪',
  kind: 'listener',
  defaultEnabled: false,
  commands: [],
  settings: [
    {
      key: 'floors',
      type: 'bands',
      label: 'Floors',
      edgeLabel: 'Up to',
      valueLabel: 'Minimum',
      min: 0,
      max: 1_000_000,
      maxRows: 4,
      default: [
        { upTo: 100_000, value: 500 },
        { upTo: null, value: 5_000 },
      ],
    },
  ],
}

const bands = (input: unknown) => validateSettings(feature, { floors: input })

describe('bandValue', () => {
  const floors: Band[] = [
    { upTo: 50_000, value: 500 },
    { upTo: 1_000_000, value: 5_000 },
    { upTo: null, value: 20_000 },
  ]

  it('picks the band the size falls in', () => {
    expect(bandValue(floors, 10_000)).toBe(500)
    expect(bandValue(floors, 200_000)).toBe(5_000)
    expect(bandValue(floors, 9_000_000)).toBe(20_000)
  })

  it('treats an edge as exclusive, so a band owns everything below it', () => {
    expect(bandValue(floors, 49_999)).toBe(500)
    expect(bandValue(floors, 50_000)).toBe(5_000)
  })

  it('says nothing when the size is unknown', () => {
    expect(bandValue(floors, undefined)).toBeUndefined()
    expect(bandValue(floors, Number.NaN)).toBeUndefined()
  })
})

describe('bands validation', () => {
  it('sorts the rows and forces the last one to be the catch-all', () => {
    // Given out of order and with no open-ended row, the top band becomes it -
    // otherwise the largest tokens would fall through unfiltered.
    const result = bands([
      { upTo: 1_000_000, value: 5_000 },
      { upTo: 10_000, value: 100 },
    ])

    expect(result.ok).toBe(true)
    expect(result.settings.floors).toEqual([
      { upTo: 10_000, value: 100 },
      { upTo: null, value: 5_000 },
    ])
  })

  it('keeps an explicit catch-all wherever it was written', () => {
    const result = bands([
      { upTo: null, value: 9_000 },
      { upTo: 20_000, value: 200 },
    ])

    expect(result.settings.floors).toEqual([
      { upTo: 20_000, value: 200 },
      { upTo: null, value: 9_000 },
    ])
  })

  it('drops a duplicated edge rather than keeping both', () => {
    const result = bands([
      { upTo: 10_000, value: 100 },
      { upTo: 10_000, value: 400 },
      { upTo: null, value: 900 },
    ])

    expect(result.settings.floors).toHaveLength(2)
  })

  it('rejects the shapes that would silently misfilter', () => {
    expect(bands([]).ok).toBe(false)
    expect(bands('nope').ok).toBe(false)
    expect(bands([{ upTo: -5, value: 100 }]).ok).toBe(false)
    expect(bands([{ upTo: 10_000, value: 'lots' }]).ok).toBe(false)
    expect(bands([{ upTo: 10_000, value: 2_000_000 }]).ok).toBe(false)
  })

  it('enforces the row cap', () => {
    const rows = [1, 2, 3, 4, 5].map((n) => ({ upTo: n * 1_000, value: n }))

    expect(bands(rows).ok).toBe(false)
  })

  it('leaves the descriptor default untouched when a value is stored', () => {
    const first = validateSettings(feature, { floors: [{ upTo: null, value: 1 }] })
    const second = validateSettings(feature, {})

    expect(first.settings.floors).toEqual([{ upTo: null, value: 1 }])
    expect(second.settings.floors).toEqual(feature.settings[0]!.default)
  })
})
