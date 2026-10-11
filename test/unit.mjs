/**
 * Unit test for dsh-persona-switch. Runs the real apply() against a fake Cordis
 * context, so it exercises seeding, listing, switching, complete-mode toggling,
 * state persistence, and the model-facing tool — with no model calls and no
 * token spend.
 *
 *   node test/unit.mjs
 *
 * DSH_HOME is pointed at a throwaway directory so the live state is untouched.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-ps-test-'))
process.env.DSH_HOME = home

const mod = await import('../lib/index.js')

let pass = 0
let fail = 0
function check(label, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok   ${label}`) } else { fail++; console.log(`  FAIL ${label} ${extra}`) }
}

// --- fake context ----------------------------------------------------------
const sections = []
const commands = []
const tools = []
let disposed = 0

const ctx = {
  inject(deps, cb) {
    const inner = {}
    if (deps.includes('systemPrompt')) {
      inner.systemPrompt = {
        section(sec) {
          const live = { ...sec, bytes: Buffer.byteLength(typeof sec.text === 'function' ? sec.text() : sec.text, 'utf8'), read: () => (typeof sec.text === 'function' ? sec.text() : sec.text) }
          sections.push(live)
          return () => { disposed++; const i = sections.indexOf(live); if (i >= 0) sections.splice(i, 1) }
        },
        getSectionOrder(n) { return n === 'DEPLOYMENT_PERSONA_PREFIX' ? 0 : 10200 },
      }
    }
    if (deps.includes('commands')) inner.commands = { register: (c) => commands.push(c) }
    if (deps.includes('tools')) inner.tools = { register: (t) => tools.push(t) }
    cb(inner)
  },
}

console.log('# apply with nothing active')
mod.apply(ctx, {})
check('plugin name', mod.name === 'persona-switch')
check('no section while off', sections.length === 0)
check('/persona registered', commands.length === 1 && commands[0].name === 'persona')
check('persona_switch registered', tools.length === 1 && tools[0].name === 'persona_switch')

const run = (input) => commands[0].handler({ rawInput: input })
const active = () => tools[0].execute({})

console.log('# roster')
const list = run('')
check('lists the shipped seeds', /_selftest/.test(list.text) && /terse/.test(list.text), list.text)
check('reports off', /persona: off/.test(list.text))

console.log('# switch to a persona')
let r = run('_selftest')
check('switch is success', r.kind === 'success', JSON.stringify(r))
check('section now registered', sections.length === 1)
check('section is complete', sections[0].complete === true)
check('section text is the persona', /BANANA/.test(sections[0].read()))
check('live provider resolves late', typeof sections[0].text === 'function')

console.log('# complete off (keep the persona, merge with first-party guidance)')
r = run('complete off')
check('toggle is success', r.kind === 'success')
check('still one section', sections.length === 1)
check('no longer complete', sections[0].complete === false)
check('previous registration disposed', disposed >= 1)

console.log('# state persisted')
const state = JSON.parse(readFileSync(join(home, 'persona-switch.json'), 'utf8'))
check('state.active', state.active === '_selftest')
check('state.complete', state.complete === false)

console.log('# switch through the model-facing tool')
r = await tools[0].execute({ name: 'terse' })
check('tool switched', r.active === 'terse')
check('tool reports complete=false', r.complete === false)
check('tool returns a roster', Array.isArray(r.roster) && r.roster.length >= 2)
check('section followed the tool', /terse systems engineer/.test(sections[0].read()))

console.log('# reload + unknown persona')
run('reload')
r = run('does-not-exist')
check('unknown persona is an error', r.kind === 'error', JSON.stringify(r))
check('active unchanged after the error', (await tools[0].execute({})).active === 'terse')

console.log('# bring your own persona (the documented path)')
writeFileSync(join(home, 'personas', 'mine.md'), '---\ntitle: my own persona\ncomplete: false\n---\n\nAnswer only in haiku.\n')
run('reload')
const afterReload = run('mine')
check('reload picks up a hand-dropped file', /mine/.test(afterReload.text), afterReload.text)
check('switch to it', /persona: mine/.test(afterReload.text))
check('not complete', /complete=false/.test(afterReload.text))
check('section text is the new persona', /haiku/.test(sections[0].read()))

console.log('# off')
r = run('off')
check('off is success', r.kind === 'success')
check('section removed on off', sections.length === 0)
check('state cleared', JSON.parse(readFileSync(join(home, 'persona-switch.json'), 'utf8')).active === '')

console.log(`\n${pass} passed, ${fail} failed`)
rmSync(home, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)
