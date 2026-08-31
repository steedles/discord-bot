/**
 * One JSON object per line to stdout, which is where Docker wants it.
 *
 * Never log a payload wholesale and never log anything from the browser profile:
 * the Privy token lives in that profile and a log file is a place credentials go
 * to be forgotten about.
 */
const line = (level: string, msg: string, data?: Record<string, unknown>) => {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...data }) + '\n')
}

export const log = {
  info: (msg: string, data?: Record<string, unknown>) => line('info', msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => line('warn', msg, data),
  error: (msg: string, data?: Record<string, unknown>) => line('error', msg, data),
}
