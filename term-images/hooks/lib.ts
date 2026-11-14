// Pure helpers: nothing here touches `$`, so the tests import them directly.

export const PLUGIN = 'term-images'
export const DIAGRAM_TOOL = `mcp__${PLUGIN}__show_diagram`
export const IMAGE_TOOL = `mcp__${PLUGIN}__show_image`
export const TOOLS = [DIAGRAM_TOOL, IMAGE_TOOL] as const
export const COMMAND = PLUGIN

// Renderers draw at twice the nominal resolution so text stays sharp on
// HiDPI screens; `scale` undoes it when the picture is fitted to cells.
export const RENDER_SCALE = 2

/**
 * D2's environment: it fetches icons and images named by URL while it
 * renders, so every proxy variable points at a closed local port and the
 * fetch fails at once; such a picture is drawn as a placeholder.
 */
const NO_NETWORK = 'http://127.0.0.1:9'
export const D2_ENV: Readonly<Record<string, string>> = {
  HTTP_PROXY: NO_NETWORK,
  HTTPS_PROXY: NO_NETWORK,
  ALL_PROXY: NO_NETWORK,
  http_proxy: NO_NETWORK,
  https_proxy: NO_NETWORK,
  all_proxy: NO_NETWORK,
  NO_PROXY: '',
  no_proxy: '',
}
// D2 draws a PNG at twice its SVG size; the pad is in SVG pixels.
export const D2_PAD = 40

/** Appended to every refusal, so a missing renderer never leads elsewhere. */
export const LOCAL_ONLY =
  'term-images renders locally only. Do not render it any other way: never send the source or the file to an online ' +
  'renderer or converter (plantuml.com, kroki.io, mermaid.ink or any other), with curl, WebFetch or a script.'
// A nominal 1x pixel width of one terminal cell, for the natural size.
const CELL_PX = 8

/** What a successful call stores as its result; the render hook draws from it. */
export type Shown = {
  kind: 'term-images'
  title: string
  png: string
  width: number
  height: number
  scale: number
  source?: string
  inline?: string
  display: string
}

export type Sizing = { maxColumns: number; maxRows: number; cellAspect: number }

export type Cells = { columns: number; rows: number }

/**
 * Reads the stored result back, whichever shape the transcript kept it in:
 * the object itself, its JSON text, or text content blocks holding it.
 */
export function asShown(output: unknown): Shown | undefined {
  const value = unwrap(output)
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const v = value as Record<string, unknown>
  const isShown =
    v.kind === 'term-images' &&
    typeof v.png === 'string' &&
    typeof v.title === 'string' &&
    typeof v.width === 'number' &&
    typeof v.height === 'number' &&
    typeof v.scale === 'number'

  return isShown ? (v as Shown) : undefined
}

function unwrap(output: unknown): unknown {
  if (typeof output === 'string') {
    try {
      return JSON.parse(output)
    } catch {
      return undefined
    }
  }
  if (Array.isArray(output)) {
    for (const block of output) {
      const b = block as { type?: unknown; text?: unknown } | null
      if (b?.type === 'text' && typeof b.text === 'string') {
        return unwrap(b.text)
      }
    }
    return undefined
  }
  return output
}

/** Width and height from a PNG's IHDR chunk; `base64` needs its first 24 bytes. */
export function pngSize(base64: string): { width: number; height: number } | undefined {
  if (base64.length < 32) {
    return undefined
  }
  const bin = atob(base64.slice(0, 32))
  if (bin.charCodeAt(0) !== 0x89 || bin.slice(1, 4) !== 'PNG' || bin.slice(12, 16) !== 'IHDR') {
    return undefined
  }
  const u32 = (at: number) =>
    bin.charCodeAt(at) * 0x1000000 +
    (bin.charCodeAt(at + 1) << 16) +
    (bin.charCodeAt(at + 2) << 8) +
    bin.charCodeAt(at + 3)
  const width = u32(16)
  const height = u32(20)

  return width > 0 && height > 0 ? { width, height } : undefined
}

/**
 * The box of cells a picture is drawn over: its natural size, shrunk to the
 * viewport and the configured caps, keeping the aspect ratio.
 */
export function fitCells(
  picture: { width: number; height: number; scale: number },
  viewportColumns: number | undefined,
  sizing: Sizing,
): Cells {
  const aspect = sizing.cellAspect > 0 ? sizing.cellAspect : 2.1
  const ratio = picture.height / picture.width
  const room = clamp(Math.min((viewportColumns ?? 100) - 4, sizing.maxColumns), 1, 255)
  const natural = Math.ceil(picture.width / Math.max(picture.scale, 0.1) / CELL_PX)
  let columns = clamp(Math.min(room, natural), 1, 255)
  let rows = Math.max(1, Math.round((columns * ratio) / aspect))
  const maxRows = clamp(sizing.maxRows, 1, 255)
  if (rows > maxRows) {
    rows = maxRows
    columns = clamp(Math.round((rows * aspect) / ratio), 1, 255)
  }

  return { columns, rows }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.floor(n)))
}

export type Manager = 'brew' | 'apt' | 'dnf' | 'pacman' | 'zypper' | 'apk'

/** Where to look for each package manager, first hit wins. */
export const MANAGER_PATHS: ReadonlyArray<readonly [Manager, string]> = [
  ['brew', '/opt/homebrew/bin/brew'],
  ['brew', '/usr/local/bin/brew'],
  ['apt', '/usr/bin/apt-get'],
  ['dnf', '/usr/bin/dnf'],
  ['pacman', '/usr/bin/pacman'],
  ['zypper', '/usr/bin/zypper'],
  ['apk', '/sbin/apk'],
  ['brew', '/home/linuxbrew/.linuxbrew/bin/brew'],
]

// D2 is packaged for Homebrew and Arch; elsewhere its own script installs it.
const D2_SCRIPT = 'curl -fsSL https://d2lang.com/install.sh | sh -s --'
const PACKAGES: Record<Manager, { prefix: string; svg: string; d2?: string }> = {
  brew: { prefix: 'brew install', svg: 'resvg', d2: 'd2' },
  apt: { prefix: 'sudo apt install', svg: 'librsvg2-bin' },
  dnf: { prefix: 'sudo dnf install', svg: 'librsvg2-tools' },
  pacman: { prefix: 'sudo pacman -S', svg: 'resvg', d2: 'd2' },
  zypper: { prefix: 'sudo zypper install', svg: 'rsvg-convert' },
  apk: { prefix: 'sudo apk add', svg: 'rsvg-convert' },
}

export type Missing = { svg: boolean; d2?: boolean }

/** The one command that installs what is missing, or undefined when nothing is. */
export function installCommand(manager: Manager | undefined, missing: Missing): string | undefined {
  if (!missing.svg && !missing.d2) {
    return undefined
  }
  if (manager === undefined) {
    const parts = [
      missing.svg ? 'resvg (https://github.com/linebender/resvg) or librsvg (rsvg-convert)' : '',
      missing.d2 ? 'D2 (https://d2lang.com/tour/install)' : '',
    ]

    return `install ${parts.filter(Boolean).join(' and ')}`
  }
  const p = PACKAGES[manager]
  const names = [missing.svg ? p.svg : '', missing.d2 ? (p.d2 ?? '') : ''].filter(Boolean)
  const commands = [names.length > 0 ? `${p.prefix} ${names.join(' ')}` : '', missing.d2 && p.d2 === undefined ? D2_SCRIPT : '']

  return commands.filter(Boolean).join(' && ')
}

/**
 * D2 draws an icon or image named by URL as a placeholder here, with no
 * word about it, so the answer says why.
 */
export function d2RemoteNote(source: string): string {
  return /^\s*(icon|src)\s*:\s*["']?https?:\/\//m.test(source) || /[{;]\s*(icon|src)\s*:\s*["']?https?:\/\//.test(source)
    ? ' Icons and images named by URL were not fetched (rendering is local only) and show as placeholders: name local image files, or leave them out.'
    : ''
}

/** Raster formats the converters are allowed to read, by their own coder name. */
export type Raster = 'jpeg' | 'gif' | 'webp' | 'bmp' | 'tiff' | 'heic'

/**
 * The raster format from a file's first bytes, or undefined for anything
 * else. The converter is then told this format, so ImageMagick never guesses
 * one of its scripting formats (MVG, MSL, SVG, URL) that can fetch from the
 * network.
 */
export function rasterOf(base64: string): Raster | undefined {
  let bin: string
  try {
    // 24 characters are 18 whole bytes, enough for every signature below.
    bin = atob(base64.slice(0, 24))
  } catch {
    return undefined
  }
  if (bin.startsWith('\xff\xd8\xff')) {
    return 'jpeg'
  }
  if (bin.startsWith('GIF87a') || bin.startsWith('GIF89a')) {
    return 'gif'
  }
  if (bin.startsWith('RIFF') && bin.slice(8, 12) === 'WEBP') {
    return 'webp'
  }
  if (bin.startsWith('BM')) {
    return 'bmp'
  }
  if (bin.startsWith('II*\x00') || bin.startsWith('MM\x00*')) {
    return 'tiff'
  }
  if (bin.slice(4, 8) === 'ftyp' && ['heic', 'heix', 'mif1', 'msf1', 'hevc'].includes(bin.slice(8, 12))) {
    return 'heic'
  }

  return undefined
}

/** The raster format from `file --mime-type`, for files too big to read. */
export function rasterOfMime(mime: string): Raster | undefined {
  const byMime: Record<string, Raster> = {
    'image/jpeg': 'jpeg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/bmp': 'bmp',
    'image/x-ms-bmp': 'bmp',
    'image/tiff': 'tiff',
    'image/heic': 'heic',
    'image/heif': 'heic',
  }

  return byMime[mime.trim()]
}

export type TerminalEnv = {
  term?: string
  termProgram?: string
  termProgramVersion?: string
  lcTerminal?: string
  lcTerminalVersion?: string
  kittyWindow?: string
  ghostty?: string
  konsole?: string
  terminalEmulator?: string
  tmux?: string
  ssh?: string
  forceImages?: string
}

export type Graphics = 'kitty' | 'iterm2'

export type TerminalSupport = {
  name: string
  graphics?: Graphics
  readsFiles?: boolean
  isTmux: boolean
  isRemote: boolean
  hint?: string
}

export type Passthrough = 'on' | 'all' | 'off'

export type Conditions = { isFullscreen?: boolean; passthrough?: Passthrough }

export type Drawing = { source: 'file' | 'bytes' } | { reason: string }

export const INLINE_MAX_BYTES = 2 * 1024 * 1024

const NO_PLACEHOLDERS: Record<string, string> = {
  Apple_Terminal: 'Terminal.app',
  vscode: 'the VS Code terminal (xterm.js)',
  Hyper: 'Hyper (xterm.js)',
  Tabby: 'Tabby (xterm.js)',
  WezTerm: 'WezTerm',
  WarpTerminal: 'Warp',
}

export function terminalSupport(env: TerminalEnv): TerminalSupport {
  const program = env.termProgram ?? ''
  const term = env.term ?? ''
  const isTmux = env.tmux !== undefined
  const isRemote = env.ssh !== undefined
  const isKitty = env.kittyWindow !== undefined || term === 'xterm-kitty'
  const isGhostty = env.ghostty !== undefined || program === 'ghostty' || term === 'xterm-ghostty'
  const isIterm = program === 'iTerm.app' || env.lcTerminal === 'iTerm2'
  const version = program === 'iTerm.app' ? env.termProgramVersion : env.lcTerminalVersion
  const lacking = NO_PLACEHOLDERS[program] ?? (env.konsole !== undefined ? 'Konsole' : undefined) ??
    (env.terminalEmulator === 'JetBrains-JediTerm' ? 'the JetBrains terminal' : undefined) ??
    (term === 'alacritty' ? 'Alacritty' : undefined)
  const own = isKitty
    ? 'kitty'
    : isGhostty
      ? 'Ghostty'
      : isIterm
        ? `iTerm2${version ? ` ${version}` : ''}`
        : (lacking ?? (program || term || 'unknown terminal'))
  const name = [own, isTmux ? 'via tmux' : '', isRemote ? 'over ssh' : ''].filter(Boolean).join(' ')
  const base = { name, isTmux, isRemote }
  const isForced = env.forceImages !== undefined && !['', '0', 'false'].includes(env.forceImages)
  if (isKitty || isGhostty) {
    return { ...base, graphics: 'kitty', readsFiles: true }
  }
  if (isIterm && isForced) {
    return isAtLeast(version, 3, 6)
      ? { ...base, graphics: 'kitty' }
      : { ...base, hint: 'CLAUDE_CODE_FORCE_TERMINAL_IMAGES makes Claude Code draw kitty placeholders, which iTerm2 draws from 3.6 on' }
  }
  if (isIterm) {
    return isAtLeast(version, 3, 5)
      ? { ...base, graphics: 'iterm2' }
      : { ...base, hint: 'iTerm2 draws pictures from version 3.5 on' }
  }
  if (lacking !== undefined) {
    return { ...base, hint: `${lacking} draws no kitty Unicode placeholders, which Claude Code places pictures with` }
  }
  if (isForced) {
    return { ...base, graphics: 'kitty' }
  }

  return {
    ...base,
    hint:
      'Claude Code draws pictures in kitty, Ghostty and iTerm2 3.5+; for another terminal that draws kitty Unicode placeholders ' +
      '(st with the graphics patch, AbsoluteTelnet) set CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1',
  }
}

export function drawingOf(tty: TerminalSupport, conditions: Conditions): Drawing {
  if (tty.graphics === undefined) {
    return { reason: tty.hint ?? 'this terminal draws no pictures' }
  }
  if (tty.isTmux && conditions.passthrough !== 'on' && conditions.passthrough !== 'all') {
    return { reason: 'inside tmux pictures need `set -g allow-passthrough on` and `set -g focus-events on`' }
  }
  if (tty.isTmux && tty.graphics === 'iterm2' && conditions.passthrough === 'all') {
    return { reason: 'iTerm2 pictures in tmux need `set -g allow-passthrough on`, not `all`' }
  }
  if (tty.graphics === 'iterm2' && conditions.isFullscreen !== true) {
    return { reason: 'iTerm2 draws pictures only under the fullscreen renderer: run `/tui fullscreen`' }
  }

  return { source: tty.readsFiles === true && !tty.isTmux && !tty.isRemote ? 'file' : 'bytes' }
}

function isAtLeast(version: string | undefined, major: number, minor: number): boolean {
  const match = version?.match(/^(\d+)\.(\d+)/)
  if (!match) {
    return false
  }
  const [have, sub] = [Number(match[1]), Number(match[2])]

  return have > major || (have === major && sub >= minor)
}

export function inlineSides(width: number, height: number): number[] {
  const longest = Math.max(width, height)

  return [2048, 1536, 1024, 768, 512].filter(side => side < longest)
}

export function base64Bytes(base64: string): number {
  const pad = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0

  return (base64.length / 4) * 3 - pad
}

/** A colour gradient as RGBA pixels, base64: the doctor's test picture. */
export function testPattern(width: number, height: number): string {
  let bin = ''
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t = x / Math.max(1, width - 1)
      const r = Math.round(255 * (1 - t))
      const g = Math.round(255 * Math.sin(Math.PI * t))
      const b = Math.round(255 * t)
      const fade = 1 - (0.5 * y) / Math.max(1, height - 1)
      bin += String.fromCharCode(Math.round(r * fade), Math.round(g * fade), Math.round(b * fade), 255)
    }
  }

  return btoa(bin)
}

/** Joins a possibly relative path onto a directory; `~/` goes to home. */
export function resolvePath(path: string, cwd: string, home: string | undefined): string {
  if (path.startsWith('~/') && home !== undefined) {
    return `${home.replace(/\/+$/, '')}/${path.slice(2)}`
  }
  if (path.startsWith('/')) {
    return path
  }

  return `${cwd.replace(/\/+$/, '')}/${path.replace(/^\.\//, '')}`
}

/** A `file:` URL for an absolute path, each segment percent-encoded. */
export function fileUrl(path: string): string {
  return `file://${path.split('/').map(encodeURIComponent).join('/')}`
}
