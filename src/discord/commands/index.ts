import type { Command } from '../command.js'
import { alertCommand } from './alert.js'
import { featureCommand } from './feature.js'
import { helpCommand } from './help.js'
import { monitorCommand } from './monitor.js'
import { priceCommand } from './price.js'
import { rugcheckCommand } from './rugcheck.js'
import { scanCommand } from './scan.js'
import { trackCommand } from './track.js'
import { walletCommand } from './wallet.js'
import { watchCommand } from './watch.js'

export const commands: Command[] = [
  // First in the list because it is first in Discord's picker, which is where
  // somebody who does not know what this bot does starts looking.
  helpCommand,
  priceCommand,
  scanCommand,
  alertCommand,
  trackCommand,
  featureCommand,
  watchCommand,
  monitorCommand,
  rugcheckCommand,
  walletCommand,
]

export const commandMap = new Map<string, Command>(commands.map((c) => [c.data.name, c]))
