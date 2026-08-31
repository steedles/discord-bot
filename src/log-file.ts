/**
 * Log files that survive a redeploy.
 *
 * Docker's own logs live inside the container, so `docker compose up --build`
 * destroys them along with the container it replaces. That is not a theoretical
 * problem: nineteen hours of chart-skip diagnostics were lost to exactly this,
 * on the one deploy that was meant to be followed by reading them.
 *
 * So the bot also writes to a file on a named volume. Nothing here replaces
 * stdout - `docker compose logs` keeps working unchanged, and a container that
 * cannot open its log file must still start, because logging to a file is a
 * convenience and running the bot is the job.
 *
 * Rotation is by date in the filename rather than by a rotating-file library.
 * One fewer dependency, and a day per file is the granularity anyone actually
 * greps by; the cost is that a single very loud day is one large file.
 */
import fs from 'node:fs'
import path from 'node:path'

/** Files older than this are deleted. Matches the snapshot history's horizon. */
const KEEP_DAYS = 14

/** UTC, deliberately: a file that changes name at local midnight is worse. */
export function fileNameFor(date: Date): string {
  return `bot-${date.toISOString().slice(0, 10)}.log`
}

/**
 * Deletes logs older than `KEEP_DAYS`.
 *
 * Compares by the date in the *filename* rather than by mtime, because an
 * append-only file's mtime is the last time anything was logged, which for a
 * busy day-old file is a few seconds ago.
 */
export function prunable(files: string[], now: Date, keepDays = KEEP_DAYS): string[] {
  const cutoff = new Date(now.getTime() - keepDays * 24 * 60 * 60_000)
  const cutoffDay = cutoff.toISOString().slice(0, 10)

  return files.filter((f) => {
    const match = /^bot-(\d{4}-\d{2}-\d{2})\.log$/.exec(f)
    return match !== null && match[1]! < cutoffDay
  })
}

function prune(dir: string, now: Date): void {
  try {
    for (const file of prunable(fs.readdirSync(dir), now)) {
      fs.rmSync(path.join(dir, file), { force: true })
    }
  } catch {
    // A failed prune is a disk-space problem for later, not a reason to refuse
    // to log now.
  }
}

/**
 * Opens today's log file for appending, rotating when the date changes.
 *
 * Returns undefined when the directory cannot be used, so the caller falls back
 * to stdout only rather than failing to start.
 */
export function openLogFile(dir: string): NodeJS.WritableStream | undefined {
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    return undefined
  }

  let current: fs.WriteStream | undefined
  let currentName = ''

  const streamFor = (now: Date): fs.WriteStream | undefined => {
    const name = fileNameFor(now)
    if (current && name === currentName) return current

    try {
      const next = fs.createWriteStream(path.join(dir, name), { flags: 'a' })
      // Never let an unwritable log file take the process down with it.
      next.on('error', () => {})
      current?.end()
      current = next
      currentName = name
      prune(dir, now)
      return next
    } catch {
      return current
    }
  }

  streamFor(new Date())
  if (!current) return undefined

  /*
   * A shim rather than the stream itself, because the file the writes go to
   * changes at midnight while pino holds this reference forever.
   */
  return {
    write(chunk: string | Uint8Array): boolean {
      return streamFor(new Date())?.write(chunk) ?? true
    },
    end(): void {
      current?.end()
    },
  } as NodeJS.WritableStream
}
