import type { On } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import {
  DIAGRAM_TOOL,
  IMAGE_TOOL,
  asShown,
  base64Bytes,
  d2RemoteNote,
  drawingOf,
  fileUrl,
  fitCells,
  inlineSides,
  installCommand,
  pngSize,
  rasterOf,
  rasterOfMime,
  terminalSupport,
} from '../hooks/lib'
import type { Shown } from '../hooks/lib'

// The first 24 bytes of an 840 x 320 PNG: signature, IHDR length, type, size.
const PNG_840x320 = btoa('\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR\x00\x00\x03\x48\x00\x00\x01\x40')
const SIZING = { maxColumns: 120, maxRows: 45, cellAspect: 2 }

// The first bytes of a JPEG, and an ImageMagick MVG script posing as one.
const JPEG_HEAD = btoa('\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01')
const MVG_AS_JPEG = btoa("push graphic-context\nviewbox 0 0 640 480\nimage over 0,0 0,0 'https://example.com/x.png'\n")

type Host = {
  binaries: Set<string>
  files: Map<string, string>
  sizes: Map<string, number>
  paths: Set<string>
  env: Record<string, string>
  ran: string[][]
  // The environment each process ran with, in the order of `ran`.
  runEnv: Record<string, string>[]
  // Every URL the plugin asked the engine to fetch.
  fetched: string[]
  // What `d2` prints to stderr and exits 1 with, a syntax error.
  d2Error?: string
}

function host(init: Partial<Host> = {}): Host {
  return {
    binaries: new Set(),
    files: new Map(),
    sizes: new Map(),
    paths: new Set(),
    env: { TMPDIR: '/tmp/t/', TERM_PROGRAM: 'ghostty', HOME: '/home/me' },
    ran: [],
    runEnv: [],
    fetched: [],
    ...init,
  }
}

const ok = (stdout = '') => ({
  value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})
const failed = (exitCode: number, stderr: string) => ({
  value: { exitCode, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false },
})

// The machine beneath the plugin: a process runs only when it is "installed",
// and a renderer writes a PNG to the output path its argv names.
function serve(on: On, h: Host): void {
  on('env.get', ($, e) => ({ value: h.env[e.name] }))
  on('session.cwd', () => ({ value: '/work' }))
  on('fs.exists', ($, e) => ({ value: h.files.has(e.path) || h.paths.has(e.path) }))
  on('fs.write', ($, e) => {
    h.files.set(e.path, btoa(e.text))

    return { value: undefined }
  })
  on('fs.read', ($, e) => {
    const base64 = h.files.get(e.path)
    if (base64 === undefined) {
      return { deny: `ENOENT ${e.path}` }
    }

    return { value: e.as === 'bytes' ? { base64 } : atob(base64) }
  })
  on('fs.stat', ($, e) => {
    const base64 = h.files.get(e.path)
    if (base64 === undefined) {
      return { deny: `ENOENT ${e.path}` }
    }

    return { value: { kind: 'file' as const, size: h.sizes.get(e.path) ?? base64Bytes(base64), mtimeMs: 0, isLink: false } }
  })
  on('fs.list', ($, e) => {
    const dir = `${e.path.replace(/\/+$/, '')}/`
    const names = [...h.files.keys()].filter(path => path.startsWith(dir)).map(path => path.slice(dir.length))

    return { value: names.map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })) }
  })
  on('http.fetch', ($, e) => {
    h.fetched.push(e.url)

    return { deny: 'no network in tests' }
  })
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    h.ran.push(argv)
    h.runEnv.push({ ...(e.init?.env ?? {}) })
    const bin = argv[0] ?? ''
    if (bin !== 'mkdir' && !h.binaries.has(bin)) {
      return { deny: `spawn ${bin} ENOENT` }
    }
    if (bin === 'd2' && argv[1] !== '--version' && h.d2Error !== undefined) {
      return failed(1, h.d2Error)
    }
    const out =
      bin === 'resvg'
        ? argv[argv.length - 1]
        : bin === 'magick'
          ? argv[argv.length - 1]?.replace(/^png:/, '')
          : bin === 'd2' && argv[1] !== '--version'
            ? argv[argv.length - 1]
            : bin === 'sips' && argv.includes('--out')
              ? argv[argv.indexOf('--out') + 1]
              : undefined
    if (out !== undefined) {
      h.files.set(out, PNG_840x320)
    }

    return ok(bin === 'uname' ? 'Darwin\n' : '')
  })
}

describe('helpers', () => {
  test('pngSize reads the IHDR size', () => {
    expect(pngSize(PNG_840x320)).toEqual({ width: 840, height: 320 })
    expect(pngSize(btoa('GIF89a-not-a-png-at-all-really'))).toBeUndefined()
  })

  test('fitCells keeps the natural size when it fits', () => {
    // 840 px at 2x is 420 px: 53 cells across, 53 * 320/840 / 2 = 10 rows.
    expect(fitCells({ width: 840, height: 320, scale: 2 }, 200, SIZING)).toEqual({ columns: 53, rows: 10 })
  })

  test('fitCells shrinks to the viewport and caps tall pictures', () => {
    expect(fitCells({ width: 4000, height: 1000, scale: 1 }, 64, SIZING).columns).toBe(60)
    const tall = fitCells({ width: 400, height: 4000, scale: 1 }, 200, SIZING)
    expect(tall.rows).toBe(45)
    expect(tall.columns).toBe(9)
  })

  test('installCommand names only what is missing, per package manager', () => {
    expect(installCommand('brew', { svg: true })).toBe('brew install resvg')
    expect(installCommand('apt', { svg: true })).toBe('sudo apt install librsvg2-bin')
    expect(installCommand('dnf', { svg: true })).toBe('sudo dnf install librsvg2-tools')
    expect(installCommand('pacman', { svg: false })).toBeUndefined()
    expect(installCommand(undefined, { svg: true })).toContain('resvg')
  })

  test('terminalSupport knows kitty graphics and iTerm2 from 3.5', () => {
    expect(terminalSupport({ termProgram: 'ghostty' }).graphics).toBe('kitty')
    expect(terminalSupport({ term: 'xterm-kitty' }).graphics).toBe('kitty')
    expect(terminalSupport({ termProgram: 'iTerm.app', termProgramVersion: '3.7.7' }).graphics).toBe('iterm2')
    expect(terminalSupport({ termProgram: 'iTerm.app', termProgramVersion: '3.4.23' }).graphics).toBeUndefined()
    expect(terminalSupport({ termProgram: 'iTerm.app' }).graphics).toBeUndefined()
    expect(terminalSupport({ termProgram: 'tmux', lcTerminal: 'iTerm2', lcTerminalVersion: '3.5.0', tmux: '/tmp/t' })).toEqual({
      name: 'iTerm2 3.5.0 via tmux',
      graphics: 'iterm2',
      isTmux: true,
      isRemote: false,
    })
    expect(terminalSupport({ termProgram: 'ghostty', forceImages: '1' }).graphics).toBe('kitty')
  })

  test('the force flag means kitty placeholders: iTerm2 from 3.6 and unknown terminals, never those without placeholders', () => {
    expect(terminalSupport({ termProgram: 'iTerm.app', termProgramVersion: '3.7.7', forceImages: '1' }).graphics).toBe('kitty')
    expect(terminalSupport({ termProgram: 'iTerm.app', termProgramVersion: '3.5.14', forceImages: '1' }).graphics).toBeUndefined()
    expect(terminalSupport({ term: 'st-256color', forceImages: '1' }).graphics).toBe('kitty')
    expect(terminalSupport({ term: 'st-256color' }).hint).toContain('CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1')
    expect(terminalSupport({ term: 'xterm-256color', ssh: '10.0.0.2 51000 10.0.0.1 22', forceImages: '1' })).toEqual({
      name: 'xterm-256color over ssh',
      graphics: 'kitty',
      isTmux: false,
      isRemote: true,
    })
    for (const termProgram of ['Apple_Terminal', 'vscode', 'WezTerm', 'WarpTerminal', 'Hyper', 'Tabby']) {
      expect(terminalSupport({ termProgram, forceImages: '1' }).graphics).toBeUndefined()
    }
    expect(terminalSupport({ termProgram: 'WarpTerminal' }).hint).toContain('Warp draws no kitty Unicode placeholders')
    expect(terminalSupport({ konsole: '250401', forceImages: '1' }).graphics).toBeUndefined()
    expect(terminalSupport({ terminalEmulator: 'JetBrains-JediTerm', forceImages: '1' }).graphics).toBeUndefined()
    expect(terminalSupport({ term: 'alacritty', forceImages: '1' }).graphics).toBeUndefined()
  })

  test('drawingOf sends a file only to a local kitty or Ghostty, bytes elsewhere', () => {
    const ghostty = terminalSupport({ termProgram: 'ghostty' })
    const iterm = terminalSupport({ termProgram: 'iTerm.app', termProgramVersion: '3.7.7' })
    const forcedIterm = terminalSupport({ termProgram: 'iTerm.app', termProgramVersion: '3.7.7', forceImages: '1' })
    const tmuxed = terminalSupport({ termProgram: 'tmux', ghostty: '/g', tmux: '/tmp/t' })
    const itermTmux = terminalSupport({ termProgram: 'tmux', lcTerminal: 'iTerm2', lcTerminalVersion: '3.7.7', tmux: '/tmp/t' })
    expect(drawingOf(ghostty, {})).toEqual({ source: 'file' })
    expect(drawingOf(terminalSupport({ term: 'xterm-ghostty', ssh: '/dev/ttys001' }), {})).toEqual({ source: 'bytes' })
    expect(drawingOf(terminalSupport({ term: 'st-256color', forceImages: '1' }), {})).toEqual({ source: 'bytes' })
    expect(drawingOf(iterm, { isFullscreen: true })).toEqual({ source: 'bytes' })
    expect(drawingOf(iterm, { isFullscreen: false })).toHaveProperty('reason')
    expect(drawingOf(iterm, {})).toHaveProperty('reason')
    expect(drawingOf(forcedIterm, { isFullscreen: false })).toEqual({ source: 'bytes' })
    expect(drawingOf(tmuxed, { passthrough: 'on' })).toEqual({ source: 'bytes' })
    expect(drawingOf(tmuxed, { passthrough: 'all' })).toEqual({ source: 'bytes' })
    expect(drawingOf(tmuxed, { passthrough: 'off' })).toHaveProperty('reason')
    expect(drawingOf(itermTmux, { passthrough: 'all', isFullscreen: true })).toHaveProperty('reason')
    expect(drawingOf(itermTmux, { passthrough: 'on', isFullscreen: true })).toEqual({ source: 'bytes' })
    expect(drawingOf(terminalSupport({ termProgram: 'vscode' }), { isFullscreen: true })).toHaveProperty('reason')
  })

  test('inlineSides only shrinks, and base64Bytes counts decoded bytes', () => {
    expect(inlineSides(3000, 1200)).toEqual([2048, 1536, 1024, 768, 512])
    expect(inlineSides(900, 1100)).toEqual([1024, 768, 512])
    expect(base64Bytes(btoa('abcd'))).toBe(4)
    expect(base64Bytes(btoa('abcde'))).toBe(5)
  })

  test('installCommand names D2 by its package, or by its own script where there is none', () => {
    expect(installCommand('brew', { svg: false, d2: true })).toBe('brew install d2')
    expect(installCommand('pacman', { svg: true, d2: true })).toBe('sudo pacman -S resvg d2')
    expect(installCommand('apt', { svg: true, d2: true })).toBe('sudo apt install librsvg2-bin && curl -fsSL https://d2lang.com/install.sh | sh -s --')
    expect(installCommand('apt', { svg: false, d2: true })).toBe('curl -fsSL https://d2lang.com/install.sh | sh -s --')
    expect(installCommand(undefined, { svg: false, d2: true })).toContain('d2lang.com')
  })

  test('d2RemoteNote speaks up only for an icon or image named by URL', () => {
    expect(d2RemoteNote('x: X {icon: https://icons.terrastruct.com/a.svg}')).toContain('not fetched')
    expect(d2RemoteNote('x: {\n  shape: image\n  icon: "http://example.com/a.png"\n}')).toContain('not fetched')
    expect(d2RemoteNote('x: {icon: ./local.png}')).toBe('')
    expect(d2RemoteNote('a -> b: see https://example.com')).toBe('')
  })

  test('rasterOf knows the raster signatures and nothing else', () => {
    expect(rasterOf(JPEG_HEAD)).toBe('jpeg')
    expect(rasterOf(btoa('GIF89a\x01\x00\x01\x00'))).toBe('gif')
    expect(rasterOf(btoa('RIFF\x00\x00\x00\x00WEBPVP8 '))).toBe('webp')
    expect(rasterOf(btoa('\x00\x00\x00\x18ftypheic\x00\x00'))).toBe('heic')
    expect(rasterOf(MVG_AS_JPEG)).toBeUndefined()
    expect(rasterOf(btoa('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeUndefined()
    expect(rasterOfMime('image/jpeg\n')).toBe('jpeg')
    expect(rasterOfMime('text/plain')).toBeUndefined()
  })

  test('asShown reads the result as an object or as its JSON text', () => {
    const shown: Shown = { kind: 'term-images', title: 'x', png: '/p.png', width: 1, height: 1, scale: 1, display: '' }
    expect(asShown(shown)?.png).toBe('/p.png')
    expect(asShown(JSON.stringify(shown))?.png).toBe('/p.png')
    expect(asShown([{ type: 'text', text: JSON.stringify(shown) }])?.png).toBe('/p.png')
    expect(asShown({ kind: 'other' })).toBeUndefined()
  })
})

const ITERM = { TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.7.7' }

const ABOVE_PROMPT = {
  hasSurvey: false,
  isCollapsed: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
} as const

function start(on: On, h: Host): string[] {
  serve(on, h)
  const registered: string[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.register', ($, e) => {
    registered.push(e.name)

    return { value: { tool: `mcp__term-images__${e.name}` } }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))

  return registered
}

describe('which sessions get the tools', () => {
  test('fileUrl percent-encodes each segment', () => {
    expect(fileUrl('/tmp/my dir/a#1.png')).toBe('file:///tmp/my%20dir/a%231.png')
  })

  test('Ghostty gets them as the session starts', async ($, on) => {
    const registered = start(on, host())
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    expect(registered).toEqual(['show_diagram', 'show_image'])
  })

  test('a terminal that draws no pictures never gets them', async ($, on) => {
    const h = host()
    h.env = { ...h.env, TERM_PROGRAM: 'Apple_Terminal' }
    const registered = start(on, h)
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({
      plugin: 'term-images',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: ABOVE_PROMPT,
      viewport: { columns: 100, rows: 40, isFullscreen: true },
    })
    await ui.unmount()
    expect(registered).toEqual([])
  })

  test('iTerm2 gets them once the screen says it is fullscreen', async ($, on) => {
    const h = host()
    h.env = { ...h.env, ...ITERM }
    const registered = start(on, h)
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    expect(registered).toEqual([])
    const ui = await $.ui.mount({
      plugin: 'term-images',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: ABOVE_PROMPT,
      viewport: { columns: 100, rows: 40, isFullscreen: true },
    })
    await ui.unmount()
    expect(registered).toEqual(['show_diagram', 'show_image'])
  })

  test('iTerm2 with the force flag gets them as the session starts, fullscreen or not', async ($, on) => {
    const h = host()
    h.env = { ...h.env, ...ITERM, CLAUDE_CODE_FORCE_TERMINAL_IMAGES: '1' }
    const registered = start(on, h)
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    expect(registered).toEqual(['show_diagram', 'show_image'])
  })

  test('Warp never gets them, even with the force flag', async ($, on) => {
    const h = host()
    h.env = { ...h.env, TERM_PROGRAM: 'WarpTerminal', CLAUDE_CODE_FORCE_TERMINAL_IMAGES: '1' }
    const registered = start(on, h)
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    expect(registered).toEqual([])
  })

  test('iTerm2 on the main screen does not get them', async ($, on) => {
    const h = host()
    h.env = { ...h.env, ...ITERM }
    const registered = start(on, h)
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({
      plugin: 'term-images',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: ABOVE_PROMPT,
      viewport: { columns: 100, rows: 40, isFullscreen: false },
    })
    await ui.unmount()
    expect(registered).toEqual([])
  })

  test('tmux needs passthrough and focus events', async ($, on) => {
    const h = host({ binaries: new Set(['tmux']) })
    h.env = { ...h.env, TERM_PROGRAM: 'tmux', GHOSTTY_RESOURCES_DIR: '/g', TMUX: '/tmp/tmux-1/default' }
    const registered = start(on, h)
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    expect(registered).toEqual([])
    expect(h.ran).toContainEqual(['tmux', 'show-options', '-gv', 'allow-passthrough'])
  })

  test('a large PNG gets a copy small enough to send as bytes', async ($, on) => {
    const h = host({ binaries: new Set(['sips']) })
    h.files.set('/work/big.png', PNG_840x320)
    h.sizes.set('/work/big.png', 3 * 1024 * 1024)
    serve(on, h)
    const answer = await $.tool.call({ tool: IMAGE_TOOL, path: 'big.png' })
    const shown = asShown(answer.result)
    expect(shown?.inline).toMatch(/^\/tmp\/t\/claude-term-images\/[0-9a-f]{8}\.png$/)
    expect(h.ran).toContainEqual(['sips', '-Z', '768', '/work/big.png', '--out', shown?.inline ?? '?'])
  })
})

describe('show_diagram', () => {
  test('renders a PNG locally with the network closed', async ($, on) => {
    const h = host({ binaries: new Set(['d2']) })
    serve(on, h)
    const answer = await $.tool.call({ tool: DIAGRAM_TOOL, tool_use_id: 'call-1', source: 'a -> b: hi', title: 'Flow' })
    const shown = asShown(answer.result)
    expect(shown?.title).toBe('Flow')
    expect(shown?.width).toBe(840)
    expect(shown?.height).toBe(320)
    expect(shown?.png).toMatch(/^\/tmp\/t\/claude-term-images\/[0-9a-f]{8}\.png$/)
    expect(shown?.display).toContain('Ghostty')
    expect(shown?.scale).toBe(2)
    expect(shown?.source).toMatch(/\.d2$/)
    expect(h.files.get(shown?.source ?? '')).toBe(btoa('a -> b: hi'))
    const at = h.ran.findIndex(argv => argv[0] === 'd2' && argv[1] !== '--version')
    expect(h.ran[at]).toEqual(['d2', '--pad', '40', shown?.source ?? '?', shown?.png ?? '?'])
    expect(h.runEnv[at]?.HTTPS_PROXY).toBe('http://127.0.0.1:9')
    expect(h.runEnv[at]?.https_proxy).toBe('http://127.0.0.1:9')
    expect(h.runEnv[at]?.NO_PROXY).toBe('')
    expect(shown?.display).not.toContain('not fetched')
  })

  test('without D2 it refuses with the install command and no fallback', async ($, on) => {
    const h = host({ binaries: new Set(['resvg']), paths: new Set(['/opt/homebrew/bin/brew']) })
    serve(on, h)
    const answer = await $.tool.call({ tool: DIAGRAM_TOOL, source: 'a -> b' })
    expect(answer.deny).toContain('brew install d2')
    expect(answer.deny).toContain('renders locally only')
    expect(h.ran.some(argv => argv[0] === 'resvg')).toBe(false)
  })

  test('on Debian or Ubuntu it names D2’s own install script', async ($, on) => {
    const h = host({ paths: new Set(['/usr/bin/apt-get']) })
    serve(on, h)
    const answer = await $.tool.call({ tool: DIAGRAM_TOOL, source: 'a -> b' })
    expect(answer.deny).toContain('curl -fsSL https://d2lang.com/install.sh | sh -s --')
  })

  test('an empty source is refused', async ($, on) => {
    serve(on, host())
    const answer = await $.tool.call({ tool: DIAGRAM_TOOL, source: '  ' })
    expect(answer.deny).toContain('`source` must hold the whole diagram')
  })

  test('a syntax error comes back with D2’s own words', async ($, on) => {
    const h = host({ binaries: new Set(['d2']), d2Error: 'err: failed to compile x.d2: 1:6: maps must be terminated with }' })
    serve(on, h)
    const answer = await $.tool.call({ tool: DIAGRAM_TOOL, source: 'a -> {' })
    expect(answer.deny).toContain('D2 could not render it')
    expect(answer.deny).toContain('maps must be terminated')
  })

  test('an icon by URL is not fetched, and the answer says so', async ($, on) => {
    const h = host({ binaries: new Set(['d2']) })
    serve(on, h)
    const answer = await $.tool.call({ tool: DIAGRAM_TOOL, source: 'x: X {icon: https://example.com/a.svg}' })
    expect(asShown(answer.result)?.display).toContain('not fetched')
    expect(h.fetched).toEqual([])
  })
})

describe('local only', () => {
  test('no diagram, renderer or image path asks the engine to fetch anything', async ($, on) => {
    const h = host({ binaries: new Set(['d2', 'resvg', 'magick']) })
    h.files.set('/work/photo.jpg', JPEG_HEAD)
    h.files.set('/work/a.svg', btoa('<svg/>'))
    serve(on, h)
    await $.tool.call({ tool: DIAGRAM_TOOL, source: 'a -> b' })
    await $.tool.call({ tool: IMAGE_TOOL, path: 'a.svg' })
    await $.tool.call({ tool: IMAGE_TOOL, path: 'photo.jpg' })
    expect(h.fetched).toEqual([])
  })
})

describe('show_image', () => {
  test('shows a PNG in place, relative to the working directory', async ($, on) => {
    const h = host()
    h.files.set('/work/out/chart.png', PNG_840x320)
    serve(on, h)
    const answer = await $.tool.call({ tool: IMAGE_TOOL, path: 'out/chart.png' })
    const shown = asShown(answer.result)
    expect(shown?.png).toBe('/work/out/chart.png')
    expect(shown?.title).toBe('chart.png')
    expect(shown?.scale).toBe(1)
  })

  test('ImageMagick is told the format, never left to guess it', async ($, on) => {
    const h = host({ binaries: new Set(['magick']) })
    h.files.set('/work/photo.jpg', JPEG_HEAD)
    serve(on, h)
    const answer = await $.tool.call({ tool: IMAGE_TOOL, path: 'photo.jpg' })
    const shown = asShown(answer.result)
    expect(h.ran.find(argv => argv[0] === 'magick' && argv.length === 3)).toEqual([
      'magick',
      'jpeg:/work/photo.jpg[0]',
      `png:${shown?.png ?? '?'}`,
    ])
  })

  test('a missing SVG renderer answers the Homebrew install command', async ($, on) => {
    const h = host({ paths: new Set(['/opt/homebrew/bin/brew']) })
    h.files.set('/work/a.svg', btoa('<svg/>'))
    serve(on, h)
    const answer = await $.tool.call({ tool: IMAGE_TOOL, path: 'a.svg' })
    expect(answer.deny).toContain('brew install resvg')
  })

  test('a script posing as an image is refused before any converter runs', async ($, on) => {
    const h = host({ binaries: new Set(['magick', 'sips']) })
    h.files.set('/work/evil.jpg', MVG_AS_JPEG)
    serve(on, h)
    const answer = await $.tool.call({ tool: IMAGE_TOOL, path: 'evil.jpg' })
    expect(answer.deny).toContain('is not a PNG, SVG, JPEG')
    expect(h.ran.some(argv => argv.includes('/work/evil.jpg') || argv.some(a => a.endsWith(':/work/evil.jpg')))).toBe(false)
  })
})

describe('drawing', () => {
  test('the result row draws the picture over a box of cells', async ($, on) => {
    const h = host()
    h.files.set('/tmp/t/claude-term-images/abc.png', PNG_840x320)
    serve(on, h)
    const output: Shown = {
      kind: 'term-images',
      title: 'Flow',
      png: '/tmp/t/claude-term-images/abc.png',
      width: 840,
      height: 320,
      scale: 2,
      display: '',
    }
    const ui = await $.ui.mount({
      plugin: 'term-images',
      surface: 'terminal',
      component: 'ToolResult',
      props: { tool_use_id: 'call-1', tool: DIAGRAM_TOOL, output, isErrored: false },
      viewport: { columns: 100, rows: 40 },
    })
    const picture = await ui.find({ type: 'Image', key: 'picture' })
    expect(picture?.props.source).toEqual({ file: output.png, format: 'png' })
    // Natural 53 columns; 53 * 320/840 / 2.1 rounds to 10 rows.
    expect(picture?.props.columns).toBe(53)
    expect(picture?.props.rows).toBe(10)
    expect(await ui.find({ type: 'Text', text: /Flow/ })).toBeDefined()
    expect(await ui.find({ type: 'Link' })).toBeUndefined()
    await ui.unmount()
  })

  test('in fullscreen iTerm2 the picture goes as PNG bytes, the smaller copy when there is one', async ($, on) => {
    const h = host()
    h.env = { ...h.env, ...ITERM }
    h.files.set('/tmp/t/claude-term-images/abc.png', PNG_840x320)
    const small = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
    h.files.set('/tmp/t/claude-term-images/small.png', small)
    serve(on, h)
    const output: Shown = {
      kind: 'term-images',
      title: 'Flow',
      png: '/tmp/t/claude-term-images/abc.png',
      inline: '/tmp/t/claude-term-images/small.png',
      width: 840,
      height: 320,
      scale: 2,
      display: '',
    }
    const ui = await $.ui.mount({
      plugin: 'term-images',
      surface: 'terminal',
      component: 'ToolResult',
      props: { tool_use_id: 'call-1', tool: DIAGRAM_TOOL, output, isErrored: false },
      viewport: { columns: 100, rows: 40, isFullscreen: true },
    })
    expect((await ui.find({ type: 'Image', key: 'picture' }))?.props.source).toEqual({ png: small })
    expect(await ui.find({ type: 'Link' })).toBeUndefined()
    await ui.unmount()
  })

  test('iTerm2 on the main screen gets the link alone', async ($, on) => {
    const h = host()
    h.env = { ...h.env, ...ITERM }
    h.files.set('/tmp/t/claude-term-images/abc.png', PNG_840x320)
    serve(on, h)
    const output: Shown = { kind: 'term-images', title: 'Flow', png: '/tmp/t/claude-term-images/abc.png', width: 840, height: 320, scale: 2, display: '' }
    const ui = await $.ui.mount({
      plugin: 'term-images',
      surface: 'terminal',
      component: 'ToolResult',
      props: { tool_use_id: 'call-1', tool: DIAGRAM_TOOL, output, isErrored: false },
      viewport: { columns: 100, rows: 40, isFullscreen: false },
    })
    expect(await ui.find({ type: 'Image' })).toBeUndefined()
    expect((await ui.find({ type: 'Link' }))?.props.href).toBe(`file://${output.png}`)
    await ui.unmount()
  })

  test('a forced engine in a terminal without placeholders gets the link, not stray glyphs', async ($, on) => {
    const h = host()
    h.env = { TMPDIR: '/tmp/t/', TERM_PROGRAM: 'vscode', TERM: 'xterm-256color', CLAUDE_CODE_FORCE_TERMINAL_IMAGES: '1' }
    h.files.set('/tmp/t/claude-term-images/abc.png', PNG_840x320)
    serve(on, h)
    const output: Shown = { kind: 'term-images', title: 'Flow', png: '/tmp/t/claude-term-images/abc.png', width: 840, height: 320, scale: 2, display: '' }
    const ui = await $.ui.mount({
      plugin: 'term-images',
      surface: 'terminal',
      component: 'ToolResult',
      props: { tool_use_id: 'call-1', tool: DIAGRAM_TOOL, output, isErrored: false },
      viewport: { columns: 100, rows: 40 },
    })
    expect(await ui.find({ type: 'Image' })).toBeUndefined()
    expect((await ui.find({ type: 'Link' }))?.props.href).toBe(`file://${output.png}`)
    await ui.unmount()
  })

  test('a picture whose file is gone leaves a caption, not the raw result', async ($, on) => {
    serve(on, host())
    const output: Shown = { kind: 'term-images', title: 'Flow', png: '/tmp/t/claude-term-images/gone.png', width: 840, height: 320, scale: 2, display: '' }
    const ui = await $.ui.mount({
      plugin: 'term-images',
      surface: 'terminal',
      component: 'ToolResult',
      props: { tool_use_id: 'call-1', tool: DIAGRAM_TOOL, output, isErrored: false },
      viewport: { columns: 100, rows: 40 },
    })
    expect(await ui.find({ type: 'Image' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Flow · the picture file is gone/ })).toBeDefined()
    await ui.unmount()
  })
})

describe('tool rows', () => {
  const call = (tool: string, input: unknown, state: Record<string, boolean> = {}) => ({
    plugin: 'term-images',
    surface: 'terminal' as const,
    component: 'ToolUse' as const,
    props: { tool_use_id: 'call-1', tool, input, isRunning: false, isErrored: false, isInterrupted: false, ...state },
    viewport: { columns: 100, rows: 40 },
  })
  const DIAGRAM = { source: 'a -> b\nb -> c', title: 'Flow' }

  test('a call that went well replaces the engine row with nothing', async ($, on) => {
    serve(on, host())
    for (const [tool, input] of [
      [DIAGRAM_TOOL, DIAGRAM],
      [IMAGE_TOOL, { path: '/work/a.png', title: 'A' }],
    ] as const) {
      const ui = await $.ui.mount(call(tool, input))
      expect(await ui.find({ type: 'engine' })).toBeUndefined()
      expect(await ui.find({ type: 'Text' })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('a failed or interrupted call keeps the engine row', async ($, on) => {
    serve(on, host())
    for (const state of [{ isErrored: true }, { isInterrupted: true }]) {
      const ui = await $.ui.mount(call(DIAGRAM_TOOL, DIAGRAM, state))
      expect(await ui.find({ type: 'engine' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('the expanded transcript keeps the engine row', async ($, on) => {
    serve(on, host())
    const ui = await $.ui.mount(call(IMAGE_TOOL, { path: '/work/a.png' }, { isExpanded: true }))
    expect(await ui.find({ type: 'engine' })).toBeDefined()
    await ui.unmount()
  })
})

describe('permissions', () => {
  test('an ask becomes an allow', async ($, on) => {
    on('tool.check', () => ({ decision: 'ask' }))
    const verdict = await $.tool.check({ tool: DIAGRAM_TOOL, input: {} })
    expect(verdict.decision).toBe('allow')
  })

  test('a deny from the person stands', async ($, on) => {
    on('tool.check', () => ({ decision: 'deny', reason: 'not here' }))
    const verdict = await $.tool.check({ tool: IMAGE_TOOL, input: {} })
    expect(verdict.decision).toBe('deny')
  })

  test('autoAllow off leaves the ask', { options: { autoAllow: false } }, async ($, on) => {
    on('tool.check', () => ({ decision: 'ask' }))
    const verdict = await $.tool.check({ tool: DIAGRAM_TOOL, input: {} })
    expect(verdict.decision).toBe('ask')
  })
})
