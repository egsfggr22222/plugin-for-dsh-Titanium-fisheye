/**
 * 钛合金鱼眼 (Titanium Fisheye) — Host half.
 *
 * Gives the agent an eye. The agent's own shell cannot see the screen correctly:
 * a process that never declared DPI awareness is shown a scaled-down desktop, and
 * reading pixels from that view produces numbers that are wrong by the scale
 * factor — silently, with no error. Every capture here goes through capture.ps1,
 * which declares awareness first, so the picture and the reported size always
 * describe the same real pixels.
 *
 * Three targets, each using the mechanism that works for it:
 *
 *   screen    what a person sees, including whatever window covers the desktop
 *   desktop   the wallpaper and icons, painted by the shell itself, so they are
 *             visible even where application windows cover them
 *   window    one window's full content, painted by that window, so it does not
 *             need to be raised or focused to be captured
 *
 * A capture is never handed over unchecked: the engine measures its own output
 * and reports a size mismatch or a blank frame as a failure rather than as an
 * image. The tool result carries the image and its exact dimensions.
 *
 * @module titanium-fisheye
 */

import { execFileSync, spawn } from 'node:child_process'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

/** Route prefix this owner serves. */
const ROUTE = '/api/titanium-fisheye'
/** This package's own directory. */
const HERE = dirname(fileURLToPath(import.meta.url))
/** The capture engine. */
const CAPTURE_SCRIPT = join(HERE, 'capture.ps1')
/** How long one capture may take. */
const CAPTURE_TIMEOUT_MS = 30000
/** Results are held in memory so repeated reads do not re-capture. */
const RESULT_TTL_MS = 120000
/**
 * How many captures to keep.
 *
 * A desktop capture is a few megabytes of lossless PNG, so an unbounded list
 * would fill the disk. The cap is by count rather than bytes because the count
 * is what the settings page can act on, and 40 frames is enough to review a
 * session without becoming a storage problem.
 */
const MAX_SHOTS = 40

/**
 * Where captures are written.
 *
 * They live under DSH_HOME so they sit beside every other plugin's data rather
 * than on the user's Desktop, and they are cleaned by age rather than being
 * deleted instantly: `read_image` needs a file to open after the tool returns.
 */
function shotsDir() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'titanium-fisheye')
}

// ── the capture engine ───────────────────────────────────────────────────────

/**
 * Run capture.ps1 and parse its single JSON line.
 *
 * The engine writes to a temp file, which is deleted after it is read: the image
 * reaches the tool result as bytes, never as something left lying on disk.
 */
function runCapture(mode, options = {}) {
  const frame = join(tmpdir(), `titanium-fisheye-${process.pid}-${Date.now()}.png`)
  const args = [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', CAPTURE_SCRIPT,
    '-Mode', mode,
  ]
  if (options.out !== false) args.push('-Out', frame)
  if (typeof options.title === 'string' && options.title !== '') args.push('-Title', options.title)
  if (Number.isFinite(options.hwnd) && options.hwnd !== 0) args.push('-Hwnd', String(options.hwnd))

  let parsed
  try {
    const out = execFileSync('powershell.exe', args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: CAPTURE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const line = out.trim().split(/\r?\n/u).filter((l) => l.trim() !== '').pop() ?? ''
    parsed = JSON.parse(line)
  } catch (error) {
    // The engine reports its own failures as JSON on stdout; reaching here means
    // it could not run at all, which is a different problem worth naming.
    void rm(frame, { force: true }).catch(() => {})
    return { ok: false, reason: 'engine-failed', detail: String(error?.message ?? error).slice(0, 300) }
  }

  if (parsed?.ok !== true) {
    void rm(frame, { force: true }).catch(() => {})
    return { ok: false, ...parsed }
  }

  // Modes that only report facts never write a file; nothing to read back.
  if (options.out === false || parsed.path === undefined) {
    return { ok: true, ...parsed }
  }

  let bytes
  try {
    bytes = readFileSync(frame)
  } catch (error) {
    return { ok: false, reason: 'read-failed', detail: String(error?.message ?? error).slice(0, 200) }
  } finally {
    void rm(frame, { force: true }).catch(() => {})
  }
  return { ok: true, ...parsed, bytes }
}

/** Pixel dimensions of a PNG, read from its IHDR header. */
function pngSize(bytes) {
  try {
    if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50) {
      return { w: bytes.readUInt32BE(16), h: bytes.readUInt32BE(20) }
    }
  } catch { /* not a PNG */ }
  return null
}

// ── stored results ───────────────────────────────────────────────────────────

/**
 * Captures kept on disk, indexed in memory.
 *
 * A tool result must be lossless JSON, so the picture cannot ride inside it:
 * each capture is written to shotsDir() and its path returned. This map indexes
 * those files for the settings page.
 *
 * The list is capped by count and by age, whichever bites first, and eviction
 * deletes the file as well — the index and the folder describe the same set.
 */
const recent = new Map()

function remember(id, entry) {
  recent.set(id, { ...entry, at: Date.now() })
  const cutoff = Date.now() - RESULT_TTL_MS
  const removed = []
  for (const [key, value] of recent) {
    if (value.at < cutoff) {
      removed.push(key)
      recent.delete(key)
    }
  }
  if (recent.size > MAX_SHOTS) {
    const ordered = [...recent.entries()].sort((a, b) => a[1].at - b[1].at)
    for (const [key] of ordered.slice(0, recent.size - MAX_SHOTS)) {
      removed.push(key)
      recent.delete(key)
    }
  }
  for (const key of removed) {
    void rm(join(shotsDir(), `${key}.png`), { force: true }).catch(() => {})
  }
}

/**
 * Captures available right now, newest first.
 *
 * The folder is scanned rather than the in-memory index alone: a file written
 * before this process started is still a capture the user can see and clear,
 * even though this process never recorded it. The index supplies the metadata
 * for files it knows; a name alone is enough for the rest.
 */
async function recentList() {
  const index = new Map()
  for (const [id, value] of recent) index.set(id, value)

  const rows = []
  let names = []
  try {
    names = await readdir(shotsDir())
  } catch {
    names = []
  }

  for (const name of names) {
    if (!name.endsWith('.png')) continue
    const id = name.slice(0, -4)
    const known = index.get(id)
    if (known !== undefined) {
      rows.push({
        id,
        kind: known.kind,
        width: known.width,
        height: known.height,
        title: known.title ?? '',
        path: join(shotsDir(), name),
        at: known.at,
      })
      continue
    }
    // A file this process did not create: the timestamp in its name is the only
    // record of when it was taken, and an unknown size is reported as 0.
    const stamp = Number.parseInt(id.slice(id.lastIndexOf('-') + 1), 10)
    rows.push({
      id,
      kind: id.slice(0, id.lastIndexOf('-')),
      width: 0,
      height: 0,
      title: '',
      path: join(shotsDir(), name),
      at: Number.isFinite(stamp) ? stamp : 0,
    })
  }
  return rows.sort((a, b) => b.at - a.at)
}

/**
 * Capture, file it, and index it.
 *
 * Both the tool and the settings page go through here, so a picture produced by
 * either arrives in the same folder with the same metadata; nothing is left in a
 * temp directory that the page would then be unable to show or delete.
 */
async function saveCapture(action, options = {}) {
  const result = runCapture(action, { title: options.title, hwnd: options.hwnd, out: true })
  if (result.ok !== true) return { ok: false, reason: result.reason ?? 'capture-failed', detail: result.detail ?? '' }

  const size = pngSize(result.bytes)
  if (size === null) return { ok: false, reason: 'not-a-png', detail: 'the engine returned something that is not a PNG' }
  if (size.w !== result.width || size.h !== result.height) {
    return {
      ok: false,
      reason: 'size-mismatch',
      detail: `engine reported ${result.width}x${result.height} but the image is ${size.w}x${size.h}`,
    }
  }

  const id = `${action}-${Date.now()}`
  const file = join(shotsDir(), `${id}.png`)
  await mkdir(shotsDir(), { recursive: true })
  await writeFile(file, result.bytes)
  remember(id, {
    kind: action,
    width: size.w,
    height: size.h,
    title: result.title ?? '',
    path: file,
  })

  const payload = {
    ok: true,
    id,
    kind: action,
    path: file,
    width: size.w,
    height: size.h,
    screen: { w: result.screen?.w ?? 0, h: result.screen?.h ?? 0 },
    title: result.title ?? '',
    ink: typeof result.ink === 'number' ? result.ink : 0,
    note: result.note ?? '',
  }
  if (result.bounds !== undefined && result.bounds !== null) {
    payload.bounds = {
      x: result.bounds.x ?? 0,
      y: result.bounds.y ?? 0,
      w: result.bounds.w ?? 0,
      h: result.bounds.h ?? 0,
    }
  }
  return payload
}

// ── the tool ─────────────────────────────────────────────────────────────────

const TOOL_DESCRIPTION = [
  "钛合金鱼眼 (Titanium Fisheye): capture the screen, the desktop, or one window as a real image.",
  'Use it whenever you need to see what is actually on screen instead of reasoning about it.',
  '',
  'Why this tool exists: your own shell is shown a scaled-down desktop (it never',
  'declared DPI awareness), so anything measured there is off by the scale factor',
  'with no error to warn you. A capture from this tool is measured in physical',
  'pixels, and its reported width and height are the truth about the image.',
  '',
  'Targets:',
  '  screen    what a person sees: the topmost pixels, so a covering window hides',
  '            whatever is beneath it',
  '  desktop   the wallpaper and desktop icons, painted by the shell itself, so',
  '            they are visible even where application windows cover the desktop',
  '  window    one visible window\'s full content, painted by the window itself, so',
  '            it does not need to be raised, focused, or uncovered first',
  '  list      every visible window with its exact bounds; use it to pick a target',
  '  info      the real screen size and origin',
  '',
  'Minimized windows are not captured: they have no content to paint, and restoring',
  'them would rearrange the user\'s screen. `list` marks them so you can skip them.',
  '',
  'Every result reports `width` and `height` of the returned image, and `screen`',
  'with the real desktop size. Trust those numbers over any estimate.',
].join('\n')

function registerEyeTool(ctx) {
  const registry = typeof ctx.get === 'function' ? ctx.get('tools') : ctx.tools
  if (registry === undefined || typeof registry.register !== 'function') return

  ctx.effect(() => registry.register({
    name: 'eye',
    description: TOOL_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['screen', 'desktop', 'window', 'list', 'info'],
          description: 'Which capture to take, or list the windows to pick from.',
        },
        title: {
          type: 'string',
          description: 'For action window: the window title. An exact match wins; a substring works when it is unique.',
        },
        hwnd: {
          type: 'integer',
          description: 'For action window: the window handle from `list`. Use this when titles are ambiguous.',
        },
        attach: {
          type: 'boolean',
          description: 'Whether to include the image itself in the result so you can look at it. Defaults to true.',
        },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          kind: { type: 'string' },
          id: { type: 'string' },
          path: { type: 'string' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          screen: { type: 'object', additionalProperties: true },
          title: { type: 'string' },
          bounds: { type: 'object', additionalProperties: true },
          ink: { type: 'number' },
          note: { type: 'string' },
          reason: { type: 'string' },
          detail: { type: 'string' },
          windows: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
      // The text names the file and its exact size. The model opens the file
      // itself, which also means the picture is available to any reader of the
      // session rather than being trapped inside this tool's result.
      render: (_args, value) => {
        if (value === undefined || value === null) return []
        if (value.ok === false) {
          return [{ type: 'text', text: `eye: ${value.reason}${value.detail ? ` — ${value.detail}` : ''}` }]
        }
        if (Array.isArray(value.windows)) {
          const visible = value.windows.filter((w) => w.minimized !== true)
          return [{
            type: 'text',
            text: `eye: ${value.windows.length} window(s), ${visible.length} capturable at ${value.screen?.w}x${value.screen?.h}. `
              + visible.slice(0, 8).map((w) => `[${w.hwnd}] ${w.title} ${w.w}x${w.h}`).join(' | '),
          }]
        }
        if (typeof value.path !== 'string' || value.path === '') return []
        return [{
          type: 'text',
          text: `eye: ${value.kind} ${value.width}x${value.height} (screen ${value.screen?.w}x${value.screen?.h})`
            + `${value.title ? ` — ${value.title}` : ''}. Open it with read_image: ${value.path}`,
        }]
      },
    },
    async execute(args) {
      const action = typeof args?.action === 'string' ? args.action : ''

      if (action === 'info' || action === 'list') {
        const result = runCapture(action, { out: false })
        if (result.ok !== true) throw new Error(`eye: ${result.reason}${result.detail ? ` — ${result.detail}` : ''}`)
        // Rebuild rather than pass through: the engine's object can carry fields
        // the result schema does not know, and the value must be lossless JSON.
        if (action === 'info') {
          return {
            ok: true,
            screen: { w: result.screen?.w ?? 0, h: result.screen?.h ?? 0, x: result.screen?.x ?? 0, y: result.screen?.y ?? 0 },
            monitorCount: typeof result.monitorCount === 'number' ? result.monitorCount : 0,
          }
        }
        return {
          ok: true,
          screen: { w: result.screen?.w ?? 0, h: result.screen?.h ?? 0 },
          windows: (Array.isArray(result.windows) ? result.windows : []).map((w) => ({
            hwnd: typeof w.hwnd === 'number' ? w.hwnd : 0,
            title: typeof w.title === 'string' ? w.title : '',
            className: typeof w.className === 'string' ? w.className : '',
            x: typeof w.x === 'number' ? w.x : 0,
            y: typeof w.y === 'number' ? w.y : 0,
            w: typeof w.w === 'number' ? w.w : 0,
            h: typeof w.h === 'number' ? w.h : 0,
            minimized: w.minimized === true,
            foreground: w.foreground === true,
          })),
        }
      }

      const isWindow = action === 'window'
      if (action !== 'screen' && action !== 'desktop' && !isWindow) {
        throw new Error(`eye: unknown action ${JSON.stringify(action)}`)
      }

      // One implementation shared with the settings page: capture, verify the
      // size, file it under the capture folder, and index it for the page.
      const saved = await saveCapture(action, { title: args?.title, hwnd: args?.hwnd })
      if (saved.ok !== true) {
        throw new Error(`eye: ${saved.reason}${saved.detail ? ` — ${saved.detail}` : ''}`)
      }
      return saved
    },
  }), 'titanium-fisheye: eye tool')
}

// ── routes ───────────────────────────────────────────────────────────────────

function send(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    ...headers,
  })
  res.end(body)
}

function sendPng(res, bytes) {
  res.writeHead(200, {
    'content-type': 'image/png',
    'cache-control': 'no-store',
    'content-length': bytes.length,
  })
  res.end(bytes)
}

async function route(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname.slice(ROUTE.length).replace(/\/+$/u, '') || '/'
  const method = String(req.method ?? 'GET').toUpperCase()

  if (method === 'GET' && (path === '/' || path === '/state')) {
    const info = runCapture('info', { out: false })
    return send(res, 200, {
      ok: info.ok === true,
      screen: info.screen ?? null,
      monitorCount: info.monitorCount ?? 0,
      recent: await recentList(),
    })
  }

  if (method === 'GET' && path.startsWith('/recent/')) {
    const id = decodeURIComponent(path.slice('/recent/'.length))
    const entry = recent.get(id)
    if (entry === undefined) return send(res, 404, { error: 'not found' })
    // Serve from disk: the file is the capture, and reading it back also proves
    // it is still there before the page tries to render it.
    let bytes
    try {
      bytes = await readFile(entry.path ?? join(shotsDir(), `${id}.png`))
    } catch {
      recent.delete(id)
      return send(res, 404, { error: 'gone' })
    }
    return sendPng(res, bytes)
  }

  // Delete one capture. The id must look like an id this plugin produced, so a
  // crafted request cannot walk out of the capture folder.
  if (method === 'DELETE' && path.startsWith('/recent/')) {
    const id = decodeURIComponent(path.slice('/recent/'.length))
    if (!/^[a-z]+-\d{10,}$/u.test(id)) return send(res, 400, { error: 'bad id' })
    recent.delete(id)
    await rm(join(shotsDir(), `${id}.png`), { force: true }).catch(() => {})
    return send(res, 200, { ok: true, id })
  }

  // Delete every capture. The folder is the source of truth, not the in-memory
  // index: files written before this process started are still captures the user
  // expects "clear" to remove.
  if (method === 'POST' && path === '/recent/clear') {
    recent.clear()
    let cleared = 0
    try {
      const entries = await readdir(shotsDir())
      await Promise.all(entries
        .filter((name) => name.endsWith('.png'))
        .map((name) => rm(join(shotsDir(), name), { force: true })
          .then(() => { cleared++ })
          .catch(() => {})))
    } catch { /* the folder may not exist yet, which simply means nothing to clear */ }
    return send(res, 200, { ok: true, cleared })
  }

  // Reveal one capture in Explorer, so the user can open or move it.
  if (method === 'POST' && path === '/reveal') {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const text = Buffer.concat(chunks).toString('utf8').trim()
    let body = {}
    if (text !== '') {
      try { body = JSON.parse(text) } catch { return send(res, 400, { error: 'invalid json' }) }
    }
    const id = typeof body.id === 'string' ? body.id : ''
    if (!/^[a-z]+-\d{10,}$/u.test(id)) return send(res, 400, { error: 'bad id' })
    const file = join(shotsDir(), `${id}.png`)
    try {
      // /select, highlights the file instead of opening it for editing.
      const shown = spawn('explorer.exe', ['/select,', file], { detached: true, stdio: 'ignore' })
      shown.unref()
    } catch (error) {
      return send(res, 500, { error: String(error?.message ?? error).slice(0, 200) })
    }
    return send(res, 200, { ok: true, id, path: file })
  }

  if (method === 'POST' && path === '/capture') {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const text = Buffer.concat(chunks).toString('utf8').trim()
    let body = {}
    if (text !== '') {
      try { body = JSON.parse(text) } catch { return send(res, 400, { error: 'invalid json' }) }
    }
    const action = typeof body.action === 'string' ? body.action : 'screen'

    if (action === 'list' || action === 'info') {
      const result = runCapture(action, { out: false })
      return send(res, result.ok === true ? 200 : 400, result.ok === true ? result : { ok: false, ...result })
    }

    // Same path the tool takes: filed under the capture folder and indexed, so a
    // button in the settings page produces something the page can then show and
    // delete like any other capture.
    const saved = await saveCapture(action, { title: body.title, hwnd: body.hwnd })
    if (saved.ok !== true) return send(res, 400, saved)
    return send(res, 200, saved)
  }

  return send(res, 404, { error: 'not found' })
}

export function apply(ctx) {
  ctx.inject(['webServer'], (scoped) => {
    scoped.effect(
      () => scoped.webServer.register({ kind: 'prefix', path: ROUTE, handler: route }),
      'titanium-fisheye: routes',
    )
  })

  ctx.inject(['tools'], (scoped) => {
    registerEyeTool(scoped)
  })

  // The measurement rules cannot live in the tool description: they are a
  // working method, not a parameter, and they only matter once a picture exists.
  // A skill keeps them out of every other task's context.
  ctx.inject(['skills'], (scoped) => {
    // Reading at load time keeps the skill in this file's own text, but a
    // missing file must not take the whole plugin down: the tool still works
    // without the guidance, so an unreadable skill is skipped.
    let content = ''
    try {
      content = readFileSync(join(HERE, 'skills', 'eye-measure.md'), 'utf8')
    } catch {
      content = ''
    }
    if (content === '') return

    scoped.effect(() => scoped.skills.register({
      name: 'eye-measure',
      description: 'How to measure positions from a screenshot without being misled by image scaling.',
      whenToUse: 'Before reading coordinates off a picture, or whenever something you placed lands in the wrong spot.',
      source: 'custom',
      provider: 'titanium-fisheye',
      invocation: { modelInvocable: true, userInvocable: true },
      content,
    }), 'titanium-fisheye: skill')
  })
}
