import type { RolesField } from './types.js'

/**
 * Settings shared by everything that speaks unprompted.
 *
 * Every alert-producing feature needs the same two questions answered - who to
 * ping, and how often - and answering them once here is what stops ten
 * descriptors drifting into ten slightly different wordings. They are ordinary
 * fields: the dashboard, the validator and `readSettings` treat them exactly as
 * they treat a feature's own.
 */

/** Roles pinged on an alert. Empty is the default: a ping nobody asked for is how a channel gets muted. */
export function mentionRolesField(overrides: Partial<RolesField> = {}): RolesField {
  return {
    key: 'mentionRoles',
    type: 'roles',
    label: 'Roles to ping',
    description:
      'Picked from this server’s roles. Nothing selected means the alert posts without pinging anyone.',
    default: [],
    maxRoles: 5,
    ...overrides,
  }
}
