import type { EngineInterface, ImageSource, PluginOptions, Register } from 'claude-code'

import {
  COMMAND,
  D2_ENV,
  D2_PAD,
  DIAGRAM_TOOL,
  IMAGE_TOOL,
  INLINE_MAX_BYTES,
  LOCAL_ONLY,
  MANAGER_PATHS,
  RENDER_SCALE,
  TOOLS,
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
  resolvePath,
  terminalSupport,
  testPattern,
} from './lib'
import type { Drawing, Manager, Passthrough, Raster, Shown, Sizing, TerminalSupport } from './lib'

type Engine = EngineInterface
type Picture = { title: string; png: string; scale: number; source?: string; note?: string }
// A plugin tool's result is text the model reads: the picture rides as JSON.
type Answer = { result: string } | { deny: string }
// Where binaries live when the session's PATH lacks them (an app-launched
// session, a login shell that never ran): Homebrew, Linuxbrew, the system.
const BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/home/linuxbrew/.linuxbrew/bin', '/usr/bin', '/snap/bin']
const RENDER_TIMEOUT_MS = 20_000
const MAX_SOURCE_CHARS = 200_000
const UNEXPECTED = 'term-images: rendering failed unexpectedly (a renderer hung or a file could not be written); `claude --debug` has the reason.'

const DIAGRAM_DESCRIPTION = [
  'Render a D2 diagram (d2lang.com) and show it to the user as a real picture inline in their terminal',
  '(Ghostty, kitty, iTerm2 3.5+; other terminals with kitty Unicode placeholders under CLAUDE_CODE_FORCE_TERMINAL_IMAGES).',
  'Use it whenever a picture explains better than prose or ASCII art: architecture with nested containers,',
  'request and data flows, state machines, sequence diagrams (shape: sequence_diagram), class diagrams',
  '(shape: class), ER diagrams (shape: sql_table), dependency graphs, grids, with automatic layout',
  '(direction: right for wide flows). Do not repeat the same diagram as ASCII art.',
  'When the user asks for D2, or for a diagram another tool would write as Graphviz DOT, PlantUML or',
  'Mermaid, use this. Icons and images named by URL are not fetched.',
  'Rendering is local only (a local `d2`).',
  'When the tool reports a missing renderer, stop: give the user the install command it names and ask',
  'before running it. Never render the diagram any other way: no online renderers (plantuml.com, kroki.io,',
  'mermaid.ink or any other), no curl, WebFetch or scripts that send the source anywhere.',
].join(' ')

const IMAGE_DESCRIPTION = [
  'Show an existing image file to the user as a picture inline in their terminal: a chart a',
  'script produced, a screenshot, an exported diagram. PNG and SVG are shown directly; JPEG, GIF,',
  'WebP, BMP, TIFF and HEIC are converted locally when `sips` (macOS) or ImageMagick is installed.',
  '`path` is absolute or relative to the working directory.',
].join(' ')

// Positive lookups only, so a renderer installed mid-session is found on the
// next call. A reload starts it over.
const found = new Map<string, string>()
let gradient: string | undefined
let isAwaitingViewport = false
let tmuxPassthrough: Passthrough | undefined

export const register: Register = (on, options) => {
  const sizing = sizingOf(options)
  const isAutoAllowed = options.autoAllow !== false

  on('session.start', async ($, e, next) => {
    const tty = await terminal($)
    const through = await passthrough($, tty)
    if ('source' in drawingOf(tty, { passthrough: through })) {
      await registerTools($)
    } else {
      isAwaitingViewport = 'source' in drawingOf(tty, { passthrough: through, isFullscreen: true })
    }
    await $.command.register({
      name: COMMAND,
      description: 'Check inline pictures: terminal support, renderers, install command',
    })

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const isFullscreen = e.viewport?.isFullscreen
    if (isAwaitingViewport && e.surface === 'terminal' && isFullscreen !== undefined) {
      isAwaitingViewport = false
      if (isFullscreen) {
        await registerTools($)
      }
    }

    return next(e)
  })

  // Listed in the prompt, not behind ToolSearch, so the model reaches for them.
  for (const tool of TOOLS) {
    on('tool.describe', { tool }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))
  }

  // Rendering runs locally and only draws a picture, so an `ask` becomes an
  // `allow`; a deny from the person's own rules stands.
  for (const tool of TOOLS) {
    on('tool.check', { tool }, async ($, e, next) => {
      const verdict = await next(e)

      return isAutoAllowed && verdict.decision === 'ask'
        ? { decision: 'allow', reason: 'term-images renders locally and only shows a picture' }
        : verdict
    }).catch(($, e, next) => next(e))
  }

  on('tool.call', { tool: DIAGRAM_TOOL }, async ($, e) => {
    const { source, title } = e as unknown as Record<string, unknown>

    return showDiagram($, source, title)
  }).catch(() => ({ deny: UNEXPECTED }))

  on('tool.call', { tool: IMAGE_TOOL }, async ($, e) => {
    const { path, title } = e as unknown as Record<string, unknown>

    return showImage($, path, title)
  }).catch(() => ({ deny: UNEXPECTED }))

  // The picture itself, drawn under the tool's row in the transcript.
  for (const tool of TOOLS) {
    on('ui.render', { component: 'ToolResult', props: { tool } }, async ($, e, next) => {
      if (e.surface !== 'terminal' || e.props.isErrored) {
        return next(e)
      }
      const picture = asShown(e.props.output)
      if (picture === undefined) {
        return next(e)
      }
      const { Box, Image, Link, Text } = $.ui.resolve(e)
      if (!(await $.fs.exists(picture.png))) {
        return <Text dimColor>{`${picture.title} · the picture file is gone: ${picture.png}`}</Text>
      }
      const caption = (
        <Box>
          <Text dimColor>{picture.title} · </Text>
          <Link href={fileUrl(picture.png)} label={picture.png} />
        </Box>
      )
      const source = await sourceOf($, picture, e.viewport?.isFullscreen)
      if (source === undefined) {
        return caption
      }
      const { columns, rows } = fitCells(picture, e.viewport?.columns, sizing)

      return (
        <Box flexDirection="column">
          <Image
            key="picture"
            source={source}
            columns={columns}
            rows={rows}
            alt={`[${picture.title}: this terminal draws no inline pictures; open the link below]`}
          />
          <Text dimColor>{picture.title}</Text>
        </Box>
      )
    })
  }

  for (const tool of TOOLS) {
    on('ui.render', { component: 'ToolUse', props: { tool } }, ($, e, next) => {
      if (!e.props.isErrored && !e.props.isInterrupted && !e.props.isExpanded) {
        return <></>
      }
      const input = e.props.input as Record<string, unknown> | null | undefined
      if (typeof input?.source !== 'string') {
        return next(e)
      }
      const lines = input.source.split('\n').length
      const source = `‹${lines} lines of d2›`

      return next({ ...e, props: { ...e.props, input: { ...input, source } } })
    })
  }

  on('command.run', { command: COMMAND }, async ($, e) => ({ text: await doctor($, e.presentation.isFullscreen) }))

  // The doctor's report, then a test picture: seeing it is the real answer.
  on('ui.render', { component: 'CommandOutput', props: { command: COMMAND } }, async ($, e, next) => {
    if (e.surface !== 'terminal') {
      return next(e)
    }
    const { Box, Image, Markdown } = $.ui.resolve(e)
    if (!('source' in (await drawing($, e.viewport?.isFullscreen)))) {
      return <Markdown text={e.props.text} />
    }

    return (
      <Box flexDirection="column">
        <Markdown text={e.props.text} />
        <Image
          key="test-pattern"
          source={{ rgba: (gradient ??= testPattern(96, 16)), width: 96, height: 16 }}
          columns={32}
          rows={3}
          alt="[no picture: this terminal does not draw inline images]"
        />
      </Box>
    )
  })
}

async function showDiagram($: Engine, source: unknown, title: unknown): Promise<Answer> {
  if (typeof source !== 'string' || source.trim() === '') {
    return { deny: 'term-images: `source` must hold the whole diagram.' }
  }
  if (source.length > MAX_SOURCE_CHARS) {
    return { deny: `term-images: the source is over ${MAX_SOURCE_CHARS} characters; simplify the diagram.` }
  }
  const base = await outputBase($)
  const src = `${base}.d2`
  const png = `${base}.png`
  await $.fs.write(src, source)
  const error = await renderD2($, src, png)
  if (error !== undefined) {
    return { deny: error }
  }

  return shown($, { title: titleOf(title, 'd2 diagram'), png, scale: RENDER_SCALE, source: src, note: d2RemoteNote(source) })
}

async function showImage($: Engine, path: unknown, title: unknown): Promise<Answer> {
  if (typeof path !== 'string' || path.trim() === '') {
    return { deny: 'term-images: `path` must name an image file.' }
  }
  const file = resolvePath(path.trim(), await $.session.cwd(), await $.env.get('HOME'))
  if (!(await $.fs.exists(file))) {
    return { deny: `term-images: no such file: ${file}` }
  }
  const name = titleOf(title, file.split('/').pop() ?? file)
  const head = await $.fs.read(file, { as: 'bytes' }).catch(() => undefined)
  const isPng = head === undefined ? /\.png$/i.test(file) : pngSize(head.base64) !== undefined
  if (isPng) {
    return shown($, { title: name, png: file, scale: 1 }, head === undefined ? undefined : pngSize(head.base64))
  }
  const isSvg = /\.svg$/i.test(file)
  const raster = isSvg ? undefined : head === undefined ? await rasterOfFile($, file) : rasterOf(head.base64)
  if (!isSvg && raster === undefined) {
    return { deny: `term-images: ${file} is not a PNG, SVG, JPEG, GIF, WebP, BMP, TIFF or HEIC image.` }
  }
  const png = `${await outputBase($)}.png`
  const error = raster === undefined ? await renderSvg($, file, png) : await convertRaster($, file, raster, png)
  if (error !== undefined) {
    return { deny: error }
  }

  return shown($, { title: name, png, scale: isSvg ? RENDER_SCALE : 1 })
}

// For a file over the 4 MiB a read copies: `file` names its type locally.
async function rasterOfFile($: Engine, file: string): Promise<Raster | undefined> {
  const ran = await $.process.run(['file', '-b', '--mime-type', file]).catch(() => undefined)

  return ran?.exitCode === 0 ? rasterOfMime(ran.stdout) : undefined
}

async function shown($: Engine, picture: Picture, known?: { width: number; height: number }): Promise<Answer> {
  const size = known ?? (await sizeOf($, picture.png))
  if (size === undefined) {
    return { deny: `term-images: ${picture.png} is not a readable PNG.` }
  }
  const inline = await inlineCopy($, picture.png, size)
  const tty = await terminal($)
  const { note, ...stored } = picture
  const result: Shown = {
    kind: 'term-images',
    ...stored,
    ...size,
    ...(inline === undefined ? {} : { inline }),
    display: `Shown to the user inline in the terminal (${tty.name}). Refer to it; do not redraw it as text.${note ?? ''}`,
  }

  return { result: JSON.stringify(result) }
}

async function registerTools($: Engine): Promise<void> {
  await $.tool.register({
    name: 'show_diagram',
    description: DIAGRAM_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'The whole D2 diagram' },
        title: { type: 'string', description: 'A few words naming the picture, shown under it' },
      },
      required: ['source'],
    },
  })
  await $.tool.register({
    name: 'show_image',
    description: IMAGE_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The image file, absolute or relative to the working directory' },
        title: { type: 'string', description: 'A few words naming the picture, shown under it' },
      },
      required: ['path'],
    },
  })
}

async function drawing($: Engine, isFullscreen: boolean | undefined): Promise<Drawing> {
  const tty = await terminal($)

  return drawingOf(tty, { isFullscreen, passthrough: await passthrough($, tty) })
}

async function sourceOf($: Engine, picture: Shown, isFullscreen: boolean | undefined): Promise<ImageSource | undefined> {
  const how = await drawing($, isFullscreen)
  if (!('source' in how)) {
    return undefined
  }
  if (how.source === 'file') {
    return { file: picture.png, format: 'png' }
  }
  const read = await $.fs.read(picture.inline ?? picture.png, { as: 'bytes' }).catch(() => undefined)

  return read !== undefined && base64Bytes(read.base64) <= INLINE_MAX_BYTES ? { png: read.base64 } : undefined
}

async function inlineCopy($: Engine, png: string, size: { width: number; height: number }): Promise<string | undefined> {
  const stat = await $.fs.stat(png).catch(() => undefined)
  if (stat === undefined || stat.size <= INLINE_MAX_BYTES) {
    return undefined
  }
  const out = `${await outputBase($)}.png`
  for (const side of inlineSides(size.width, size.height)) {
    if (!(await shrinkPng($, png, side, out))) {
      return undefined
    }
    const written = await $.fs.stat(out).catch(() => undefined)
    if (written !== undefined && written.size <= INLINE_MAX_BYTES) {
      return out
    }
  }

  return undefined
}

async function shrinkPng($: Engine, src: string, side: number, out: string): Promise<boolean> {
  const sips = await findBinary($, 'sips', ['--help'])
  if (sips !== undefined) {
    const ran = await $.process
      .run([sips, '-Z', String(side), src, '--out', out], { timeoutMs: RENDER_TIMEOUT_MS })
      .catch(() => undefined)

    return ran?.exitCode === 0
  }
  for (const name of ['magick', 'convert']) {
    const bin = await findBinary($, name, ['-version'])
    if (bin !== undefined) {
      const ran = await $.process
        .run([bin, `png:${src}`, '-resize', `${side}x${side}>`, `png:${out}`], { timeoutMs: RENDER_TIMEOUT_MS })
        .catch(() => undefined)

      return ran?.exitCode === 0
    }
  }

  return false
}

async function passthrough($: Engine, tty: TerminalSupport): Promise<Passthrough> {
  if (!tty.isTmux) {
    return 'off'
  }
  if (tmuxPassthrough !== undefined) {
    return tmuxPassthrough
  }
  const tmux = await findBinary($, 'tmux', ['-V'])
  const option = async (name: string) =>
    tmux === undefined
      ? undefined
      : (await $.process.run([tmux, 'show-options', '-gv', name], { timeoutMs: 5_000 }).catch(() => undefined))?.stdout.trim()
  const allowed = await option('allow-passthrough')
  tmuxPassthrough =
    (allowed === 'on' || allowed === 'all') && (await option('focus-events')) === 'on' ? allowed : 'off'

  return tmuxPassthrough
}

async function renderSvg($: Engine, src: string, png: string): Promise<string | undefined> {
  const resvg = await findBinary($, 'resvg', ['--version'])
  if (resvg !== undefined) {
    const argv = [resvg, '--zoom', String(RENDER_SCALE), '--background', 'white', src, png]
    const ran = await $.process.run(argv, { timeoutMs: RENDER_TIMEOUT_MS })

    return ran.exitCode === 0 ? undefined : failure('resvg', ran.stderr || ran.stdout)
  }
  const rsvg = await findBinary($, 'rsvg-convert', ['--version'])
  if (rsvg !== undefined) {
    const argv = [rsvg, '--zoom', String(RENDER_SCALE), '--background-color', 'white', '--output', png, src]
    const ran = await $.process.run(argv, { timeoutMs: RENDER_TIMEOUT_MS })

    return ran.exitCode === 0 ? undefined : failure('rsvg-convert', ran.stderr || ran.stdout)
  }

  return missingMessage($, 'svg')
}

async function renderD2($: Engine, src: string, png: string): Promise<string | undefined> {
  const d2 = await findBinary($, 'd2', ['--version'])
  if (d2 === undefined) {
    return missingMessage($, 'd2')
  }
  const ran = await $.process.run([d2, '--pad', String(D2_PAD), src, png], { env: { ...D2_ENV }, timeoutMs: RENDER_TIMEOUT_MS })

  return ran.exitCode === 0 ? undefined : failure('D2', ran.stderr || ran.stdout)
}

// The converter is told the format `raster` names, never left to guess it.
async function convertRaster($: Engine, src: string, raster: Raster, png: string): Promise<string | undefined> {
  const sips = await findBinary($, 'sips', ['--help'])
  if (sips !== undefined) {
    const ran = await $.process.run([sips, '-s', 'format', 'png', src, '--out', png], { timeoutMs: RENDER_TIMEOUT_MS })

    return ran.exitCode === 0 ? undefined : failure('sips', ran.stderr || ran.stdout)
  }
  for (const name of ['magick', 'convert']) {
    const bin = await findBinary($, name, ['-version'])
    if (bin !== undefined) {
      const ran = await $.process.run([bin, `${raster}:${src}[0]`, `png:${png}`], { timeoutMs: RENDER_TIMEOUT_MS })

      return ran.exitCode === 0 ? undefined : failure(name, ran.stderr || ran.stdout)
    }
  }

  return `term-images: neither \`sips\` nor ImageMagick is installed to convert this ${raster} file locally. Convert it to PNG first. ${LOCAL_ONLY}`
}

async function findBinary($: Engine, name: string, probe: readonly string[]): Promise<string | undefined> {
  const known = found.get(name)
  if (known !== undefined) {
    return known
  }
  for (const candidate of [name, ...BIN_DIRS.map(dir => `${dir}/${name}`)]) {
    // Rejects when the command cannot start: not there, try the next place.
    const ran = await $.process.run([candidate, ...probe], { timeoutMs: 5_000 }).catch(() => undefined)
    if (ran !== undefined) {
      found.set(name, candidate)

      return candidate
    }
  }

  return undefined
}

async function packageManager($: Engine): Promise<Manager | undefined> {
  for (const [manager, path] of MANAGER_PATHS) {
    if (await $.fs.exists(path).catch(() => false)) {
      return manager
    }
  }

  return undefined
}

async function missingMessage($: Engine, what: 'svg' | 'd2'): Promise<string> {
  const command = installCommand(await packageManager($), {
    svg: what === 'svg',
    d2: what === 'd2',
  })
  const tool = {
    svg: 'an SVG rasterizer (`resvg` or `rsvg-convert`)',
    d2: 'D2 (`d2`)',
  }[what]

  return (
    `term-images: ${tool} is not installed, so the picture was not rendered. ` +
    `Install it with: ${command ?? 'your package manager'}\n` +
    `Suggest this command to the user and run it only if they agree; then call the tool again. ${LOCAL_ONLY}`
  )
}

async function sizeOf($: Engine, png: string): Promise<{ width: number; height: number } | undefined> {
  const read = await $.fs.read(png, { as: 'bytes' }).catch(() => undefined)
  if (read !== undefined) {
    return pngSize(read.base64)
  }
  // Over the 4 MiB a read copies: `file` prints the size on macOS and Linux.
  const ran = await $.process.run(['file', '-b', png]).catch(() => undefined)
  const match = ran?.stdout.match(/PNG image data, (\d+) x (\d+)/)

  return match ? { width: Number(match[1]), height: Number(match[2]) } : undefined
}

async function terminal($: Engine): Promise<TerminalSupport> {
  return terminalSupport({
    term: await $.env.get('TERM'),
    termProgram: await $.env.get('TERM_PROGRAM'),
    termProgramVersion: await $.env.get('TERM_PROGRAM_VERSION'),
    lcTerminal: await $.env.get('LC_TERMINAL'),
    lcTerminalVersion: await $.env.get('LC_TERMINAL_VERSION'),
    kittyWindow: await $.env.get('KITTY_WINDOW_ID'),
    ghostty: await $.env.get('GHOSTTY_RESOURCES_DIR'),
    konsole: await $.env.get('KONSOLE_VERSION'),
    terminalEmulator: await $.env.get('TERMINAL_EMULATOR'),
    tmux: await $.env.get('TMUX'),
    ssh: (await $.env.get('SSH_CONNECTION')) ?? (await $.env.get('SSH_TTY')),
    forceImages: await $.env.get('CLAUDE_CODE_FORCE_TERMINAL_IMAGES'),
  })
}

// A fresh path stem under the temp folder; the folder is made if missing.
async function outputBase($: Engine): Promise<string> {
  const tmp = ((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/+$/, '')
  const dir = `${tmp}/claude-term-images`
  await $.process.run(['mkdir', '-p', dir])

  return `${dir}/${crypto.randomUUID().slice(0, 8)}`
}

async function doctor($: Engine, isFullscreen: boolean): Promise<string> {
  const tty = await terminal($)
  const how = await drawing($, isFullscreen)
  const resvg = await findBinary($, 'resvg', ['--version'])
  const rsvg = resvg === undefined ? await findBinary($, 'rsvg-convert', ['--version']) : undefined
  const d2 = await findBinary($, 'd2', ['--version'])
  const command = installCommand(await packageManager($), {
    svg: resvg === undefined && rsvg === undefined,
    d2: d2 === undefined,
  })
  const mark = (bin: string | undefined) => (bin === undefined ? 'missing' : `ok (${bin})`)
  const support =
    'source' in how ? 'supported' : `not supported (${how.reason}); show_diagram and show_image are off in this session`
  const lines = [
    `**Terminal:** ${tty.name}: pictures ${support}`,
    `**D2** (show_diagram): ${mark(d2)}`,
    `**SVG** (show_image of .svg files): ${mark(resvg ?? rsvg)}`,
    command === undefined ? 'All renderers are installed.' : `**Install:** \`${command}\``,
    'Rendering is local only: a picture whose renderer is missing is refused, never sent anywhere; D2 runs with the network closed (icons and images by URL are not fetched).',
    'source' in how ? 'A colour gradient below means this terminal draws pictures:' : '',
  ]

  return lines.filter(Boolean).join('\n\n')
}

function titleOf(title: unknown, fallback: string): string {
  return typeof title === 'string' && title.trim() !== '' ? title.trim() : fallback
}

function failure(renderer: string, output: string): string {
  const text = output.trim().slice(0, 2_000)

  return `term-images: ${renderer} could not render it:\n${text || '(no output)'}\nFix the source and call the tool again. ${LOCAL_ONLY}`
}

function sizingOf(options: PluginOptions): Sizing {
  const num = (value: unknown, fallback: number) => (typeof value === 'number' && value > 0 ? value : fallback)

  return {
    maxColumns: num(options.maxColumns, 120),
    maxRows: num(options.maxRows, 45),
    cellAspect: num(options.cellAspect, 2.1),
  }
}
