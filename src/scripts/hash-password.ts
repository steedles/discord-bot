/**
 * Produces a DASHBOARD_USERS entry.
 *
 *   pnpm dashboard:hash <email> <password>
 *
 * The plaintext never reaches a file - paste the printed line into `.env`,
 * which is gitignored.
 */
import { hashPassword } from '../web/password.js'

const [email, password] = process.argv.slice(2)

if (!email || !password) {
  console.error('Usage: pnpm dashboard:hash <email> <password>')
  process.exit(1)
}

console.log(hashPassword(email, password))
