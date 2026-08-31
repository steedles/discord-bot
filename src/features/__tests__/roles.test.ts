import { describe, expect, it } from 'vitest'
import { mentionRolesField } from '../fields.js'
import { validateSettings, type FeatureDescriptor } from '../types.js'

const feature: FeatureDescriptor = {
  id: 'test',
  name: 'Test',
  description: 'x',
  icon: '🧪',
  kind: 'push',
  defaultEnabled: false,
  commands: [],
  settings: [mentionRolesField({ maxRoles: 2 })],
}

const roles = (value: unknown) => validateSettings(feature, { mentionRoles: value })

const A = '123456789012345678'
const B = '987654321098765432'

/**
 * The picker sends role ids, but the API is reachable without it, so the
 * validator is what stands between a settings row and a mention line built out
 * of whatever was posted.
 */
describe('roles validation', () => {
  it('accepts ids the picker sends', () => {
    const result = roles([A, B])
    expect(result.ok).toBe(true)
    expect(result.settings.mentionRoles).toEqual([A, B])
  })

  it('accepts an empty list - that is how a channel says "no ping"', () => {
    expect(roles([]).ok).toBe(true)
  })

  it('drops the same role listed twice', () => {
    expect(roles([A, A]).settings.mentionRoles).toEqual([A])
  })

  it('refuses anything that is not a role id', () => {
    expect(roles(['@everyone']).ok).toBe(false)
    expect(roles(['12345']).ok).toBe(false)
    // A snowflake with something attached is not a snowflake: the stored value
    // is pasted straight into a mention, so a partial match cannot pass.
    expect(roles([`<@&${A}>`]).ok).toBe(false)
  })

  it('refuses a list, not a role, and more roles than the field allows', () => {
    expect(roles('123').ok).toBe(false)
    expect(roles([A, B, '111111111111111111']).ok).toBe(false)
  })
})
