/**
 * Admin account seed. Runs on every container boot (see docker-entrypoint.sh),
 * which is why it is a separate file from prisma/seed.js: that one wipes the
 * database and fills it with demo data, this one only makes sure the three
 * console accounts exist and can sign in.
 *
 * Idempotent by email. A first run creates the row; later runs leave an
 * existing row's name, id and everything it owns alone, and only re-hash the
 * password when ADMIN_SEED_RESET_PASSWORD=1 (so an administrator who changed
 * their password is not silently reset on the next deploy).
 *
 * Run by hand with: npm run db:seed:admins
 */
import { prisma } from '../src/lib/prisma.js'
import { hashPassword } from '../src/auth/password.js'

// The demo password from the brief. Any real deployment should pass
// ADMIN_SEED_PASSWORD instead; this default exists so a fresh clone works.
const DEFAULT_PASSWORD = 'admin123'

export const ADMIN_ACCOUNTS = [
  { email: 'admin.one@au.edu', name: 'Admin One' },
  { email: 'admin.two@au.edu', name: 'Admin Two' },
  { email: 'admin.three@au.edu', name: 'Admin Three' },
]

const envList = (value) =>
  String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

/**
 * ADMIN_SEED_EMAILS overrides the addresses, in order, so a deployment can own
 * its admin identities without editing this file. Fewer entries than accounts
 * leaves the rest at their defaults.
 */
function accounts() {
  const overrides = envList(process.env.ADMIN_SEED_EMAILS)
  return ADMIN_ACCOUNTS.map((account, i) => ({
    ...account,
    email: (overrides[i] ?? account.email).toLowerCase(),
  }))
}

export async function seedAdmins({ log = console.log } = {}) {
  const password = process.env.ADMIN_SEED_PASSWORD || DEFAULT_PASSWORD
  const resetExisting = process.env.ADMIN_SEED_RESET_PASSWORD === '1'
  const summary = { created: 0, updated: 0, unchanged: 0 }

  for (const { email, name } of accounts()) {
    const existing = await prisma.user.findUnique({ where: { email } })

    if (!existing) {
      // Hashed per account rather than once: a shared salt would make the three
      // rows visibly identical to anyone who reads the column.
      await prisma.user.create({
        data: { email, name, role: 'ADMIN', passwordHash: await hashPassword(password) },
      })
      summary.created += 1
      log(`seed-admins: created ${email}`)
      continue
    }

    // A row that exists but is not an admin, or has no password yet, still
    // needs fixing up — that is the case where the schema changed under an
    // already-deployed database.
    const needsRole = existing.role !== 'ADMIN'
    const needsPassword = existing.passwordHash === null || resetExisting

    if (!needsRole && !needsPassword) {
      summary.unchanged += 1
      continue
    }

    await prisma.user.update({
      where: { id: existing.id },
      data: {
        ...(needsRole ? { role: 'ADMIN' } : {}),
        ...(needsPassword ? { passwordHash: await hashPassword(password) } : {}),
      },
    })
    summary.updated += 1
    log(
      `seed-admins: updated ${email}` +
        `${needsRole ? ' (role -> ADMIN)' : ''}${needsPassword ? ' (password set)' : ''}`,
    )
  }

  log(
    `seed-admins: ${summary.created} created, ${summary.updated} updated, ` +
      `${summary.unchanged} already in place`,
  )
  return summary
}

// Running the file directly is the deploy path; importing it is the test path.
const isEntrypoint = process.argv[1] && import.meta.url === `file://${process.argv[1]}`
if (isEntrypoint) {
  seedAdmins()
    .then(() => prisma.$disconnect())
    .catch(async (err) => {
      console.error('seed-admins failed:', err)
      await prisma.$disconnect()
      process.exit(1)
    })
}
