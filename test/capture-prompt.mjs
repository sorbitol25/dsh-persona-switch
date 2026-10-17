/**
 * capture-prompt.mjs — prove what the model actually receives.
 *
 * Starts a throwaway mock on 127.0.0.1 and points the DeepSeek route at it with
 * DEEPSEEK_BASE_URL, then runs `dsh headless "<prompt>"` and reports the exact
 * `system` field of the request body DSH sent.
 *
 *   node test/capture-prompt.mjs --persona jb "say hi"
 *   node test/capture-prompt.mjs --persona off "say hi"
 *   node test/capture-prompt.mjs --persona jb --complete off "say hi"   # override the front-matter
 *
 * The mock answers in the protocol the request arrived in, so `dsh` exits
 * cleanly and the run costs no tokens. Full bodies: DSH_CAPTURE_DIR=<dir>.
 *
 * Verified against @deepseek-ai/dsh 0.2.0-rc.2: the DeepSeek route speaks the
 * Anthropic Messages protocol on POST /v1/messages, with `tools`, `thinking`
 * and `output_config` riding along. Session-title generation is a separate,
 * smaller request that does not carry the agent persona.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const STATE_FILE = join(DSH_HOME, 'persona-switch.json')
const PERSONA_DIR = join(DSH_HOME, 'personas')
const PORT = Number(process.env.DSH_CAPTURE_PORT || 8129)
const REPLY = 'MOCK-REPLY'
const HARNESS_IDENTITY = 'You are an AI agent powered by DeepSeek Harness.'

const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : null
}
const persona = flag('--persona')
const completeArg = flag('--complete') // 'on' | 'off' | null (null = trust the front-matter)
const task = argv
  .filter((a, i) => !a.startsWith('--') && a !== persona && a !== completeArg)
  .join(' ') || 'say hi'

if (persona !== null) {
  mkdirSync(DSH_HOME, { recursive: true })
  const state = { active: persona === 'off' ? '' : persona }
  if (completeArg === 'on') state.complete = true
  if (completeArg === 'off') state.complete = false
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 1)}\n`)
  console.log(`# switched persona -> ${persona}${completeArg ? ` (complete=${completeArg})` : ''}`)
}

const seen = []
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    const url = req.url || ''
    if (process.env.DSH_CAPTURE_DIR) {
      try {
        mkdirSync(process.env.DSH_CAPTURE_DIR, { recursive: true })
        writeFileSync(join(process.env.DSH_CAPTURE_DIR, `req-${Date.now()}-${url.replace(/\W+/g, '_')}.json`), body)
      } catch { /* ignore */ }
    }
    let parsed = null
    try { parsed = JSON.parse(body) } catch { /* keep raw */ }
    if (parsed && Array.isArray(parsed.messages)) seen.push({ url, body: parsed })

    // --- Anthropic Messages (the DeepSeek route) -------------------------
    if (url.includes('/v1/messages')) {
      const blocks = [
        ['message_start', { type: 'message_start', message: { id: 'msg_mock', type: 'message', role: 'assistant', model: parsed?.model || 'mock', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: REPLY } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }],
        ['message_stop', { type: 'message_stop' }],
      ]
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      for (const [event, data] of blocks) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      res.end()
      return
    }

    // --- OpenAI chat completions (other routes) ---------------------------
    if (url.includes('/chat/completions')) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', model: 'mock', choices: [{ index: 0, delta: { role: 'assistant', content: REPLY }, finish_reason: null }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', model: 'mock', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }

    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(url.includes('/models') ? JSON.stringify({ object: 'list', data: [{ id: 'mock', object: 'model' }] }) : '{}')
  })
})

await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve))
console.log(`# mock on http://127.0.0.1:${PORT}`)

const child = spawn(`dsh headless ${JSON.stringify(task)}`, {
  shell: true,
  env: {
    ...process.env,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || 'mock-key',
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${PORT}`,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let stdout = ''
let stderr = ''
child.stdout.on('data', (d) => { stdout += d })
child.stderr.on('data', (d) => { stderr += d })
const code = await new Promise((resolve) => child.on('exit', resolve))
server.close()
console.log(`# exit=${code}  stdout=${JSON.stringify(stdout.trim().slice(0, 120))}`)


if (seen.length === 0) {
  console.error('# no message request captured — is DEEPSEEK_BASE_URL honoured on this version?')
  console.error(stderr.trim().split('\n').slice(0, 10).join('\n'))
  process.exit(2)
}

const systemOf = (b) => {
  const s = b.system
  if (Array.isArray(s)) return s.map((c) => c.text || '').join('')
  return typeof s === 'string' ? s : ''
}
const active = (() => { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')).active || '' } catch { return '' } })()
const personaBody = active
  ? readFileSync(join(PERSONA_DIR, `${active}.md`), 'utf8').replace(/^---[\s\S]*?\n---\n?/, '').trim()
  : ''

console.log('')
let agentTurnSeen = false
for (const [i, req] of seen.entries()) {
  const text = systemOf(req.body)
  const tools = Array.isArray(req.body.tools) ? req.body.tools.length : 0
  const kind = tools ? 'agent turn' : 'helper'
  if (tools) agentTurnSeen = true
  console.log(`# request ${i + 1} (${kind})  ${req.url}`)
  console.log(`#   system bytes     : ${Buffer.byteLength(text, 'utf8')}`)
  console.log(`#   system sha256    : ${createHash('sha256').update(text).digest('hex').slice(0, 24)}`)
  console.log(`#   tools            : ${tools}`)
  console.log(`#   harness identity : ${text.includes(HARNESS_IDENTITY) ? 'PRESENT' : 'absent'}`)
  if (tools) {
    console.log(`#   thinking         : ${JSON.stringify(req.body.thinking)}`)
    console.log(`#   output_config    : ${JSON.stringify(req.body.output_config)}`)
    if (active) {
      console.log(`#   persona "${active}"   : ${text.trim() === personaBody ? 'system message IS the persona (exact match)' : 'differs from the seed body'}`)
    }
    console.log('#   --- first 300 chars ---')
    console.log(`#   ${text.slice(0, 300).replace(/\n/g, '\n#   ')}`)
  }
  console.log('')
}
console.log(agentTurnSeen ? '# verdict: agent turn captured' : '# verdict: only helper requests captured')
