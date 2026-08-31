/**
 * Reports whether Discord will grant the privileged Message Content intent.
 *
 *   pnpm intents:check
 *
 * Worth running before any deploy that turns Token Brief on. Requesting an intent
 * the developer portal has not granted makes Discord refuse the entire login, so
 * the failure mode is a dead bot rather than one missing feature - much better
 * to find out here.
 */
import { Client, GatewayIntentBits } from 'discord.js'
import { config } from '../config.js'

const TIMEOUT_MS = 25_000

async function probe(intents: GatewayIntentBits[], label: string): Promise<boolean> {
  const client = new Client({ intents })

  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      console.log(`  ${label}: TIMED OUT`)
      void client.destroy()
      resolve(false)
    }, TIMEOUT_MS)

    client.once('clientReady', () => {
      clearTimeout(timer)
      console.log(`  ${label}: GRANTED  (${client.user?.tag}, ${client.guilds.cache.size} guild(s))`)
      void client.destroy()
      resolve(true)
    })

    client.login(config.DISCORD_TOKEN).catch((err: Error) => {
      clearTimeout(timer)
      const denied = /disallowed intents/i.test(err.message)
      console.log(`  ${label}: ${denied ? 'DENIED' : `ERROR - ${err.message}`}`)
      resolve(false)
    })
  })
}

console.log('\nChecking gateway intents for this bot token...\n')

const basicOk = await probe([GatewayIntentBits.Guilds], 'Guilds (always available)')

if (!basicOk) {
  console.log('\nThe token itself is not working. Check DISCORD_TOKEN.\n')
  process.exit(1)
}

const messageOk = await probe(
  [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  'Message Content (privileged)',
)

if (messageOk) {
  console.log(`
  Token Brief can run. Turn it on with:
    ENABLE_MESSAGE_CONTENT=true     (.env, and deploy/homelab/.env.homelab)
  then redeploy.
`)
  process.exit(0)
}

console.log(`
  Token Brief cannot run yet. Discord is refusing the Message Content intent.

  This is a SEPARATE switch from app verification - a verified app still has
  the intent off until it is explicitly enabled:

    1. https://discord.com/developers/applications  -> your app
    2. "Bot" in the left sidebar
    3. Scroll to "Privileged Gateway Intents"
    4. Toggle "MESSAGE CONTENT INTENT" on
    5. Click "Save Changes" at the bottom - the toggle alone does not persist

  Keep ENABLE_MESSAGE_CONTENT=false until this reports GRANTED. Requesting an
  ungranted intent makes Discord refuse the whole login, not just the feature.
`)
process.exit(1)
