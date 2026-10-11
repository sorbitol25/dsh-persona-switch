/**
 * dsh-persona-switch — live persona switching for DeepSeek Harness.
 *
 * The deployment persona in DSH is composition/config only: there is no
 * end-user prompt-editing API. This row gets around that without patching core
 * by registering one prompt section whose `text` is a *provider* — evaluated at
 * every assembly — so flipping the active persona takes effect on the next turn
 * and needs no restart.
 *
 *   /persona            show the active persona and the roster
 *   /persona list       roster (title / complete / bytes)
 *   /persona jb         switch (name = personas/<name>.md)
 *   /persona off        stop overriding the system prompt
 *   /persona reload     re-read the persona directory
 *   /persona complete on|off|auto
 *
 * Personas live in $DSH_HOME/personas/*.md with optional front-matter:
 *
 *   ---
 *   title: JB (slim2)
 *   complete: true      # this persona becomes the *entire* system prompt
 *   suffix: ""          # optional text appended after first-party guidance
 *   ---
 *   <persona prose>
 *
 * No third-party imports on purpose: the plugin only touches services that DSH
 * already provides (systemPrompt / commands / tools). Nothing here can break
 * because an npm peer drifted.
 *
 * @module dsh-persona-switch
 */
import {
  appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Cordis plugin name. */
export const name = 'persona-switch'

/**
 * Empty on purpose: both consumers are attached with `ctx.inject`, so the row
 * still applies in profiles that ship only some of them (headless has no
 * command surface, sdk-minimal has no tools).
 */
export const inject = []

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const PERSONA_DIR = join(DSH_HOME, 'personas')
const STATE_FILE = join(DSH_HOME, 'persona-switch.json')
const LOG_FILE = join(DSH_HOME, 'persona-switch.log')
const SECTION_NAME = 'persona-switch:persona'
const SUFFIX_SECTION_NAME = 'persona-switch:persona-suffix'

/** Append one diagnostic line. Never throws: logging must not break a turn. */
function log(msg) {
  try {
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`)
  } catch {
    /* ignore */
  }
}

/** Split an optional `---` front-matter block off a persona file. */
function parsePersona(raw) {
  let body = raw
  const meta = {}
  if (raw.startsWith('---')) {
    const end = raw.indexOf('\n---', 3)
    if (end !== -1) {
      const head = raw.slice(3, end)
      const nl = raw.indexOf('\n', end + 1)
      body = raw.slice(nl === -1 ? raw.length : nl + 1)
      for (const line of head.split(/\r?\n/)) {
        const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line.trim())
        if (!m) continue
        let v = m[2].trim()
        if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
          v = v.slice(1, -1)
        }
        meta[m[1].toLowerCase()] = v === 'true' ? true : v === 'false' ? false : v
      }
    }
  }
  return { meta, text: body.replace(/^\s*\n/, '').replace(/\s+$/, '') }
}

/** Read every persona in the directory. A broken file is skipped, not fatal. */
function loadPersonas() {
  const out = new Map()
  let entries = []
  try {
    entries = readdirSync(PERSONA_DIR)
  } catch {
    return out
  }
  for (const entry of entries.sort()) {
    if (!entry.toLowerCase().endsWith('.md')) continue
    const file = join(PERSONA_DIR, entry)
    try {
      const { meta, text } = parsePersona(readFileSync(file, 'utf8'))
      const key = entry.slice(0, -3)
      out.set(key, {
        key,
        file,
        title: typeof meta.title === 'string' ? meta.title : key,
        complete: meta.complete === true,
        suffix: typeof meta.suffix === 'string' ? meta.suffix : '',
        text,
        bytes: Buffer.byteLength(text, 'utf8'),
      })
    } catch (err) {
      log(`persona load failed: ${entry}: ${err && err.message}`)
    }
  }
  return out
}

/** Copy the shipped personas into $DSH_HOME/personas the first time. */
function seedPersonas() {
  try {
    if (existsSync(PERSONA_DIR)) return false
    mkdirSync(PERSONA_DIR, { recursive: true })
    cpSync(join(PKG_ROOT, 'personas'), PERSONA_DIR, { recursive: true })
    log(`seeded ${PERSONA_DIR}`)
    return true
  } catch (err) {
    log(`seed failed: ${err && err.message}`)
    return false
  }
}

function readState() {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeState(state) {
  try {
    mkdirSync(DSH_HOME, { recursive: true })
    writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 1)}\n`)
    return true
  } catch (err) {
    log(`state write failed: ${err && err.message}`)
    return false
  }
}

/**
 * Mount the row.
 *
 * @param ctx - the profile-root context (systemPrompt / commands / tools are
 *   attached with `ctx.inject`, so a profile that lacks one still gets the rest).
 * @param config - `{ maxPersonaBytes, tool }`, see cordis.patch.yml.
 */
export function apply(ctx, config = {}) {
  const cfg = { maxPersonaBytes: 400000, tool: true, ...(config && typeof config === 'object' ? config : {}) }
  seedPersonas()

  let personas = loadPersonas()
  const state = readState()
  let active = typeof state.active === 'string' ? state.active : ''
  let completeOverride = typeof state.complete === 'boolean' ? state.complete : null
  let sectionDispose = null
  let suffixDispose = null
  /** Replaced once `systemPrompt` is available; a no-op before that. */
  let rebuildSection = () => {}

  const current = () => personas.get(active)
  const clip = (text) => {
    const cap = Number(cfg.maxPersonaBytes) || 0
    if (!cap || Buffer.byteLength(text, 'utf8') <= cap) return text
    return `${text.slice(0, cap)}\n\n[persona-switch] truncated at ${cap} bytes`
  }
  const activeText = () => {
    const p = current()
    return p ? clip(p.text) : ''
  }
  const activeSuffix = () => {
    const p = current()
    return p && p.suffix ? clip(p.suffix) : ''
  }
  const activeComplete = () => {
    const p = current()
    if (!p) return false
    return completeOverride === null ? p.complete : completeOverride
  }

  function status(note = '') {
    const p = current()
    const out = [p
      ? `persona: ${p.key}  complete=${activeComplete()}  ${p.bytes} bytes${note}`
      : `persona: off  (harness default system prompt)${note}`]
    if (personas.size === 0) {
      out.push(`roster: empty - drop *.md into ${PERSONA_DIR}`)
    } else {
      out.push('roster:')
      for (const q of [...personas.values()].sort((a, b) => a.key.localeCompare(b.key))) {
        out.push(`  ${q.key === active ? '*' : ' '} ${q.key.padEnd(18)} ${String(q.bytes).padStart(7)}B  complete=${q.complete ? 'y' : 'n'}  ${q.title}`)
      }
    }
    out.push(`dir: ${PERSONA_DIR}`)
    return out.join('\n')
  }

  function switchTo(key, complete) {
    const wanted = (key || '').trim()
    if (wanted && !personas.has(wanted)) return { kind: 'error', text: `unknown persona: ${wanted}\n${status()}` }
    active = wanted
    completeOverride = typeof complete === 'boolean' ? complete : null
    writeState({ active, complete: completeOverride, updated: new Date().toISOString() })
    rebuildSection()
    log(`switch persona=${active || 'off'} complete=${completeOverride === null ? 'auto' : completeOverride}`)
    return { kind: 'success', text: status() }
  }

  function setComplete(value) {
    if (!current()) return { kind: 'error', text: 'no active persona - /persona <name> first' }
    completeOverride = value
    writeState({ active, complete: completeOverride, updated: new Date().toISOString() })
    rebuildSection()
    return { kind: 'success', text: status() }
  }

  function runCommand(raw) {
    const arg = (raw || '').trim()
    if (arg === '' || /^(list|ls|show)$/i.test(arg)) return { kind: 'success', text: status() }
    const [head, ...rest] = arg.split(/\s+/)
    const verb = head.toLowerCase()
    if (verb === 'reload' || verb === 'rescan') {
      personas = loadPersonas()
      rebuildSection()
      return { kind: 'success', text: status('  [reloaded]') }
    }
    if (verb === 'off' || verb === 'none' || verb === 'default') return switchTo('', null)
    if (verb === 'complete') {
      const v = (rest[0] || 'auto').toLowerCase()
      if (v === 'on') return setComplete(true)
      if (v === 'off') return setComplete(false)
      if (v === 'auto') return setComplete(null)
      return { kind: 'error', text: 'usage: /persona complete on|off|auto' }
    }
    return switchTo(head, undefined)
  }


  // --- the live system-prompt section --------------------------------------
  ctx.inject(['systemPrompt'], (inner) => {
    const sp = inner.systemPrompt
    rebuildSection = () => {
      if (sectionDispose) { try { sectionDispose() } catch { /* ignore */ } sectionDispose = null }
      if (suffixDispose) { try { suffixDispose() } catch { /* ignore */ } suffixDispose = null }
      if (!current()) { log('section cleared (persona=off)'); return }
      sectionDispose = sp.section({
        name: SECTION_NAME,
        order: sp.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
        text: () => activeText(),
        interpolate: false,
        complete: activeComplete(),
      })
      if (activeSuffix()) {
        suffixDispose = sp.section({
          name: SUFFIX_SECTION_NAME,
          order: sp.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'),
          text: () => activeSuffix(),
          interpolate: false,
        })
      }
      log(`section registered persona=${active} complete=${activeComplete()} bytes=${activeText().length}`)
    }
    rebuildSection()
  })

  // --- human surface -------------------------------------------------------
  ctx.inject(['commands'], (inner) => {
    inner.commands.register({
      name: 'persona',
      description: 'Switch the system-prompt persona (JB presets and your own).',
      input: { hint: '[list|<name>|off|reload|complete on|off|auto]' },
      handler: ({ rawInput }) => runCommand(rawInput),
    })
    log('command /persona registered')
  })

  // --- model surface -------------------------------------------------------
  ctx.inject(['tools'], (inner) => {
    if (!cfg.tool) return
    try {
      inner.tools.register({
        name: 'persona_switch',
        description: 'Switch the active system-prompt persona. Call with no name to list the roster. The switch applies from the next turn.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: {
              type: 'string',
              description: 'Persona name (a *.md stem under $DSH_HOME/personas), "off" to disable, or "list".',
            },
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              active: { type: 'string' },
              complete: { type: 'boolean' },
              bytes: { type: 'number' },
              roster: { type: 'array', items: { type: 'string' } },
            },
            required: ['active', 'complete', 'bytes', 'roster'],
          },
          render: (_args, value) => [{
            type: 'text',
            text: `persona -> ${value.active || 'off'} (complete=${value.complete}, ${value.bytes} bytes)\nroster: ${value.roster.join(', ') || '(empty)'}`,
          }],
        },
        async execute(args) {
          const asked = args && typeof args.name === 'string' ? args.name.trim() : ''
          if (asked && !/^list$/i.test(asked)) {
            const r = runCommand(asked)
            if (r.kind === 'error') throw new Error(r.text)
          }
          const p = current()
          return {
            active: p ? p.key : '',
            complete: p ? activeComplete() : false,
            bytes: p ? activeText().length : 0,
            roster: [...personas.keys()].sort(),
          }
        },
      })
      log('tool persona_switch registered')
    } catch (err) {
      log(`tool registration failed: ${err && err.message}`)
    }
  })

  log(`applied. personas=${personas.size} active=${active || 'off'} home=${DSH_HOME}`)
}

