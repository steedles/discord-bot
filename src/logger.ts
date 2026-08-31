import pino from 'pino'
import { config } from './config.js'
import { openLogFile } from './log-file.js'

const isDev = config.NODE_ENV !== 'production'

/*
 * Development keeps the pretty transport and nothing else - a local run has a
 * terminal to read and no container to lose.
 *
 * Production writes to stdout *and*, when LOG_DIR is set, to a dated file on a
 * named volume. Both, not either: `docker compose logs` stays the first thing
 * anyone reaches for, and the file is what is still there after a redeploy.
 */
const fileStream = isDev || !config.LOG_DIR ? undefined : openLogFile(config.LOG_DIR)

export const logger = isDev
  ? pino({
      level: config.LOG_LEVEL,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
      },
    })
  : pino(
      { level: config.LOG_LEVEL },
      fileStream
        ? pino.multistream([{ stream: process.stdout }, { stream: fileStream }])
        : process.stdout,
    )

if (config.LOG_DIR && !isDev && !fileStream) {
  // Said on stdout, since the file is precisely what did not open.
  logger.warn({ dir: config.LOG_DIR }, 'could not open log directory - stdout only')
}

export const log = {
  bot: logger.child({ mod: 'bot' }),
  db: logger.child({ mod: 'db' }),
  market: logger.child({ mod: 'market' }),
  risk: logger.child({ mod: 'risk' }),
  alerts: logger.child({ mod: 'alerts' }),
  scanner: logger.child({ mod: 'scanner' }),
  brief: logger.child({ mod: 'brief' }),
  tracker: logger.child({ mod: 'tracker' }),
  monitor: logger.child({ mod: 'monitor' }),
  signals: logger.child({ mod: 'signals' }),
  telegram: logger.child({ mod: 'telegram' }),
}
