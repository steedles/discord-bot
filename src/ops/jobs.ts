import { randomBytes } from 'node:crypto'
import type { OpsJob, OpsJobResult, OpsJobType } from '../db/models.js'
import { getCollections } from '../db/mongo.js'
import { log } from '../logger.js'
import type { EnvKey } from './env-keys.js'

/**
 * The job queue between the dashboard and the homelab's `ops-runner`.
 *
 * ## The shape: the runner pulls
 *
 * The bot never reaches out to the host. The runner - a systemd user service
 * on the homelab - polls `GET /api/ops/runner/next` on loopback every few
 * seconds, claims the oldest queued job, does it, and posts the outcome back.
 * That direction is the whole security model: no Docker socket in a container,
 * no SSH key on the bot, nothing the web can exec. The runner's job types and
 * the env keys it will write are fixed allowlists on both sides.
 *
 * ## Where the secrets are
 *
 * An `apply-env` job carries API keys. They are held **in this process's
 * memory only**, in `pendingValues`, until the runner claims the job - at which
 * point they are handed over once and deleted here. Mongo gets the audit row
 * (`OpsJob`: which keys, who, when, how it went) and never a value. A bot
 * restart between queueing and claiming loses the values, and the job is
 * marked failed on the next boot rather than silently forgotten; the runner
 * polls every ten seconds, so that window is small and the failure is visible.
 *
 * ## Surviving the restart the job causes
 *
 * `apply-env` and `restart` both recreate the bot, which means the process
 * that queued the job is not the one that hears the result. That is why the
 * record lives in Mongo and the runner reports by `jobId` - the new process
 * finds the row and completes it. The values are already gone by then, which
 * is the point.
 */

/** In-memory only. Never persisted, never logged, never listed. */
const pendingValues = new Map<string, Partial<Record<EnvKey, string>>>()

/** Last time the runner polled. Undefined until it has, once, this process. */
let runnerLastSeenAt: Date | undefined

/** A runner that has not polled in this long is reported offline. */
export const RUNNER_OFFLINE_AFTER_MS = 60_000

/** A claimed job the runner never reported on is failed after this. */
const CLAIM_TIMEOUT_MS = 15 * 60_000

export interface EnqueueInput {
  type: OpsJobType
  env?: Partial<Record<EnvKey, string>>
  services?: string[]
  requestedBy: string
  requestedByName: string
  guildId: string
}

export async function enqueueJob(input: EnqueueInput): Promise<OpsJob> {
  const { opsJobs } = getCollections()
  const jobId = randomBytes(12).toString('hex')

  const job: OpsJob = {
    jobId,
    type: input.type,
    ...(input.env ? { envKeys: Object.keys(input.env) } : {}),
    ...(input.services ? { services: input.services } : {}),
    requestedBy: input.requestedBy,
    requestedByName: input.requestedByName,
    guildId: input.guildId,
    status: 'queued',
    createdAt: new Date(),
  }

  if (input.env) pendingValues.set(jobId, input.env)
  await opsJobs.insertOne(job)

  log.ops.info(
    { jobId, type: job.type, envKeys: job.envKeys, services: job.services, by: job.requestedBy },
    'ops job queued',
  )
  return job
}

/** What the runner receives. The only place a value leaves this process. */
export interface ClaimedJob {
  jobId: string
  type: OpsJobType
  env?: Partial<Record<EnvKey, string>>
  services?: string[]
}

/**
 * Hands the oldest queued job to the runner, or nothing.
 *
 * A queued `apply-env` whose values are no longer in memory (the bot restarted
 * in between) is failed here rather than handed over empty - and the loop
 * continues to the next, so one lost job does not block the queue.
 */
export async function claimNextJob(): Promise<ClaimedJob | undefined> {
  runnerLastSeenAt = new Date()
  const { opsJobs } = getCollections()

  for (;;) {
    const job = await opsJobs.findOneAndUpdate(
      { status: 'queued' },
      { $set: { status: 'claimed', claimedAt: new Date() } },
      { sort: { createdAt: 1 }, returnDocument: 'after' },
    )
    if (!job) return undefined

    if (job.type === 'apply-env') {
      const env = pendingValues.get(job.jobId)
      pendingValues.delete(job.jobId)
      if (!env) {
        await completeJob(job.jobId, {
          ok: false,
          summary: 'The bot restarted before the runner picked this up, so the values are gone. Submit them again.',
          steps: [],
        })
        continue
      }
      log.ops.info({ jobId: job.jobId, envKeys: job.envKeys }, 'ops job claimed')
      return { jobId: job.jobId, type: job.type, env }
    }

    log.ops.info({ jobId: job.jobId, type: job.type, services: job.services }, 'ops job claimed')
    return { jobId: job.jobId, type: job.type, services: job.services }
  }
}

export async function completeJob(jobId: string, result: OpsJobResult): Promise<boolean> {
  const { opsJobs } = getCollections()
  const updated = await opsJobs.updateOne(
    { jobId, status: { $in: ['queued', 'claimed'] } },
    { $set: { status: result.ok ? 'done' : 'failed', finishedAt: new Date(), result } },
  )
  pendingValues.delete(jobId)

  if (updated.matchedCount === 0) {
    log.ops.warn({ jobId }, 'result for a job that is not open - ignored')
    return false
  }
  log.ops.info({ jobId, ok: result.ok, summary: result.summary }, 'ops job finished')
  return true
}

export async function getJob(jobId: string): Promise<OpsJob | undefined> {
  const { opsJobs } = getCollections()
  await failStaleClaims()
  return (await opsJobs.findOne({ jobId })) ?? undefined
}

export async function listRecentJobs(limit = 10): Promise<OpsJob[]> {
  const { opsJobs } = getCollections()
  await failStaleClaims()
  return opsJobs.find({}).sort({ createdAt: -1 }).limit(limit).toArray()
}

export function runnerStatus(): { configured: boolean; online: boolean; lastSeenAt: Date | null } {
  const online =
    runnerLastSeenAt !== undefined && Date.now() - runnerLastSeenAt.getTime() < RUNNER_OFFLINE_AFTER_MS
  return { configured: true, online, lastSeenAt: runnerLastSeenAt ?? null }
}

/**
 * Called once at startup. Anything still `queued` was queued by a previous
 * process, and if it carried values they went with it - say so on the row
 * rather than leaving a job that looks pending forever.
 */
export async function failOrphanedJobs(): Promise<void> {
  const { opsJobs } = getCollections()
  const result = await opsJobs.updateMany(
    { status: 'queued' },
    {
      $set: {
        status: 'failed',
        finishedAt: new Date(),
        result: {
          ok: false,
          summary: 'The bot restarted before the runner picked this up. Submit it again.',
          steps: [],
        },
      },
    },
  )
  if (result.modifiedCount > 0) {
    log.ops.warn({ count: result.modifiedCount }, 'failed jobs orphaned by a restart')
  }
}

/** A runner that claimed a job and died would otherwise leave it "running" forever. */
async function failStaleClaims(): Promise<void> {
  const { opsJobs } = getCollections()
  await opsJobs.updateMany(
    { status: 'claimed', claimedAt: { $lt: new Date(Date.now() - CLAIM_TIMEOUT_MS) } },
    {
      $set: {
        status: 'failed',
        finishedAt: new Date(),
        result: {
          ok: false,
          summary: 'The runner claimed this job but never reported back. Check `journalctl --user -u discord-bot-ops-runner` on the homelab.',
          steps: [],
        },
      },
    },
  )
}
