/**
 * Copies the dashboard's static files into dist/ after a TypeScript build.
 * tsc only emits JS, so index.html / styles.css / app.js would otherwise be
 * missing from the production image.
 */
import { cp, access } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const from = join(root, 'src/web/public')
const to = join(root, 'dist/web/public')

try {
  await access(from)
} catch {
  console.error(`No static assets at ${from}`)
  process.exit(1)
}

await cp(from, to, { recursive: true })
console.log(`copied dashboard assets -> ${to}`)
