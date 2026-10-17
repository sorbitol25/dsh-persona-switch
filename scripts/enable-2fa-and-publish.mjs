#!/usr/bin/env node
// enable-2fa-and-publish.mjs — one command to satisfy npm's "2FA or bypass token" rule
// and publish dsh-persona-switch, without an authenticator app in the loop.
//
// npm refuses to publish for an account with tfa=false:
//   403 ... Two-factor authentication or granular access token with bypass 2fa enabled
//      is required to publish packages.
// This script:
//   1. runs `npm profile enable-2fa auth-and-writes` for you,
//   2. asks for your npm password ONCE, locally (not echoed, not stored),
//   3. picks "Verification code (TOTP)" when npm asks for a security method,
//   4. captures the TOTP secret npm hands out and computes the 6-digit code itself,
//   5. prints the recovery codes (store them),
//   6. saves the secret to %USERPROFILE%\.npm-2fa-secret and publishes with a fresh code.
//
//   node scripts/enable-2fa-and-publish.mjs              # enable 2FA (if needed) + publish
//   node scripts/enable-2fa-and-publish.mjs --publish    # only publish (secret already saved)
//   node scripts/enable-2fa-and-publish.mjs --dry-run    # everything except the upload
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'

const args = new Set(process.argv.slice(2))
const SECRET_FILE = path.join(os.homedir(), '.npm-2fa-secret')
const PKG = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

// --- TOTP (RFC 6238, SHA-1, 6 digits, 30 s) --------------------------------
function base32Decode(s) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0
  let value = 0
  const out = []
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const idx = alphabet.indexOf(ch)
    if (idx < 0) continue
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

export function totp(secretB32, at = Date.now(), step = 30, digits = 6) {
  const key = base32Decode(secretB32)
  const counter = Math.floor(at / 1000 / step)
  const buf = Buffer.alloc(8)
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0)
  buf.writeUInt32BE(counter >>> 0, 4)
  const hmac = crypto.createHmac('sha1', key).update(buf).digest()
  const off = hmac[hmac.length - 1] & 0x0f
  const code = ((hmac[off] & 0x7f) << 24) | (hmac[off + 1] << 16) | (hmac[off + 2] << 8) | hmac[off + 3]
  return String(code % 10 ** digits).padStart(digits, '0')
}

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    rl._writeToOutput = () => process.stdout.write('*')
    rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer) })
  })
}

function runWithOtp(argv, code) {
  return new Promise((resolve, reject) => {
    const p = spawn('npm', argv, {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: { ...process.env, npm_config_otp: code },
    })
    p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`npm ${argv.join(' ')} -> exit ${c}`))))
  })
}

// --- 2FA setup (only when no secret is saved yet) ---------------------------
async function enableTwoFactor() {
  console.log('2FA is off on this npm account; enabling auth-and-writes (npm requires it to publish).')
  const child = spawn('npm', ['profile', 'enable-2fa', 'auth-and-writes'], {
    shell: process.platform === 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let buf = ''
  let secret = null
  let sentPassword = false
  let sentMethod = false
  let sentCode = false
  const out = (s) => process.stdout.write(s)

  child.stdout.on('data', async (d) => {
    buf += d.toString()
    out(d.toString())

    if (!sentPassword && /password:/i.test(buf)) {
      sentPassword = true
      const pw = await askHidden('npm password: ')
      child.stdin.write(pw + '\n')
      buf = ''
      return
    }
    if (sentPassword && !sentMethod && !secret && /security method|security key|verification code/i.test(buf)) {
      sentMethod = true
      child.stdin.write('\u001b[B\r')          // arrow down + enter -> "Verification code (TOTP)"
      buf = ''
      return
    }
    const m = /secret=([A-Z2-7]{16,})/i.exec(buf) || /\b([A-Z2-7]{32})\b/.exec(buf)
    if (m) secret = m[1].toUpperCase()
    if (secret && !sentCode && /(verification code|authenticator|enter the code)/i.test(buf)) {
      sentCode = true
      child.stdin.write(totp(secret) + '\n')
      buf = ''
    }
  })
  child.stderr.on('data', (d) => out(d.toString()))

  await new Promise((resolve, reject) => {
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`npm profile enable-2fa -> exit ${code}`))))
  })
  if (!secret) throw new Error('could not capture the TOTP secret; run `npm profile enable-2fa auth-and-writes` by hand once')
  fs.writeFileSync(SECRET_FILE, secret + '\n', { mode: 0o600 })
  console.log(`\nTOTP secret saved to ${SECRET_FILE} — keep it private, and store the recovery codes above.`)
  return secret
}

// --- main ------------------------------------------------------------------
async function main() {
  let secret = fs.existsSync(SECRET_FILE) ? fs.readFileSync(SECRET_FILE, 'utf8').trim() : null
  if (!secret && !args.has('--publish')) secret = await enableTwoFactor()
  if (!secret) { console.error(`no secret at ${SECRET_FILE} — run without --publish first`); process.exit(1) }

  console.log(`\nTOTP now: ${totp(secret)}  (30 s window)`)
  const publishArgs = ['publish', '--access', 'public']
  if (args.has('--dry-run')) publishArgs.push('--dry-run')
  try {
    await runWithOtp(publishArgs, totp(secret))
    console.log(`\npublished ${PKG.name}@${PKG.version}`)
    console.log(`install : dsh plugin --profile web add ${PKG.name}@${PKG.version}`)
    console.log(`desktop : powershell -ExecutionPolicy Bypass -File scripts/install-desktop.ps1 -Version ${PKG.version}`)
  } catch (e) {
    console.error(`\npublish failed: ${e.message}`)
    process.exit(1)
  }
}

// only when executed directly (so the TOTP helper can be imported by tests)
if (process.argv[1] && /enable-2fa-and-publish\.mjs$/.test(process.argv[1])) {
  await main()
}

