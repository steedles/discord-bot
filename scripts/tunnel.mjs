/**
 * Opens an ngrok tunnel to the dashboard and points .env at it.
 *
 *   pnpm tunnel
 *
 * Needed only when the dashboard must be reachable from off this machine - a
 * phone, or someone else. Discord itself accepts `http://localhost` redirect
 * URIs, so plain local development does not need a tunnel.
 *
 * Leave this running: closing it drops the tunnel. On ngrok's free plan the URL
 * changes every restart, and Discord matches redirect URIs literally, so the
 * new callback has to be re-registered each time. A reserved domain
 * (`NGROK_DOMAIN`) avoids that.
 */
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const envPath = join(root, '.env')
const port = process.env.DASHBOARD_PORT || '4300'
const domain = process.env.NGROK_DOMAIN || ''

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const args = ['http', port, '--log', 'stdout', '--log-format', 'logfmt']
if (domain) args.push(`--domain=${domain}`)

console.log(`Starting ngrok -> http://localhost:${port}${domain ? ` as ${domain}` : ''}`)
const ngrok = spawn('ngrok', args, { stdio: ['ignore', 'pipe', 'pipe'] })

let failed = null
const watch = (chunk) => {
  const text = chunk.toString()
  if (/ERR_NGROK_4018|authentication failed|failed to start tunnel/i.test(text)) failed = text.trim()
}
ngrok.stdout.on('data', watch)
ngrok.stderr.on('data', watch)
ngrok.on('exit', (code) => {
  if (code !== 0 && !failed) failed = `ngrok exited with code ${code}`
})

/** ngrok exposes the assigned URL on its local admin API. */
async function publicUrl() {
  for (let i = 0; i < 40; i++) {
    if (failed) return null
    try {
      const res = await fetch('http://127.0.0.1:4040/api/tunnels')
      const { tunnels = [] } = await res.json()
      const https = tunnels.find((t) => t.public_url?.startsWith('https://'))
      if (https) return https.public_url
    } catch {
      // admin API not up yet
    }
    await sleep(500)
  }
  return null
}

const url = await publicUrl()

if (!url) {
  console.error('\nCould not open a tunnel.')
  if (failed) console.error(failed)
  console.error(
    '\nngrok v3 needs a one-time authtoken. Get yours at\n' +
      '  https://dashboard.ngrok.com/get-started/your-authtoken\n' +
      'then run:\n' +
      '  ngrok config add-authtoken <YOUR_TOKEN>\n',
  )
  ngrok.kill()
  process.exit(1)
}

// Rewrite DASHBOARD_URL in place, preserving the rest of the file.
const env = await readFile(envPath, 'utf8')
const updated = env.includes('DASHBOARD_URL=')
  ? env.replace(/^DASHBOARD_URL=.*$/m, `DASHBOARD_URL=${url}`)
  : `${env.trimEnd()}\nDASHBOARD_URL=${url}\n`
await writeFile(envPath, updated)

console.log(`
────────────────────────────────────────────────────────────
  Tunnel is up.

  Dashboard      ${url}
  Preview login  ${url}/dev-login

  Add this to the Discord app under OAuth2 -> Redirects,
  character for character:

      ${url}/auth/callback

  .env DASHBOARD_URL now points here. Restart the dashboard
  so it picks the new URL up.
────────────────────────────────────────────────────────────

Leave this running. Ctrl-C closes the tunnel.
`)

const stop = () => {
  ngrok.kill()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
