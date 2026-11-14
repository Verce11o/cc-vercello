# term-images

A Claude Code mod that lets Claude show real pictures inline in the terminal: diagrams it draws in D2, and image files such as charts a script produced. Ask "explain the order flow with a diagram" and the rendered PNG appears under the tool call instead of ASCII art.

## How it works

The mod registers two tools for the model. `show_diagram` takes the D2 source of a diagram and renders it locally to a PNG, and `show_image` takes a path to an existing PNG or SVG (JPEG, GIF, WebP, BMP, TIFF and HEIC are converted with `sips` on macOS or ImageMagick). The picture is drawn by the engine's `Image` element in one of two ways. Kitty Unicode placeholders (the kitty graphics protocol's `U=1` placements) work in kitty and Ghostty, which Claude Code recognises by itself, and in any other terminal that draws such placeholders once `CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1` is set: iTerm2 3.6 or later, st with the graphics patch, AbsoluteTelnet over ssh. Without that variable iTerm2 3.5 or later gets its own inline images, under the fullscreen renderer only (`/tui fullscreen`); there the mod waits for the screen to report the fullscreen layout before it registers the tools. A local kitty or Ghostty reads the PNG file itself; everywhere else, over ssh included, the mod hands over the PNG's bytes. The engine takes at most 2 MiB of bytes, so a larger PNG gets a smaller copy (`sips` on macOS, ImageMagick elsewhere) for that. Inside tmux pictures go as bytes too and need `set -g allow-passthrough on` and `set -g focus-events on`. Terminals that draw no kitty Unicode placeholders (Terminal.app, the VS Code terminal and other xterm.js ones, WezTerm, Konsole, Warp, the JetBrains terminal, Alacritty) get no tools, even with the variable set, so Claude does not reach for pictures there, and a picture from an earlier session shows as a caption with a link to the file.

Rendered files go to `$TMPDIR/claude-term-images/` (`/tmp/claude-term-images/` on Linux), the `.d2` source beside each PNG.

Both tools run without a permission prompt, since they only render locally and draw a picture; an explicit deny rule in your settings still wins, and the `autoAllow` option turns this off.

## Local only

Nothing the mod does reaches the network: it calls no network API of the engine (`claude plugin validate .` lists every engine call, and a test asserts that no tool call fetches anything), and every renderer it starts is a local program. When the renderer a picture needs is missing, it is refused with the install command for your system, and the refusal tells Claude not to render the diagram any other way, in particular not through an online renderer such as plantuml.com or kroki.io. The other tool keeps working.

Two renderers could reach the network on their own, and the mod closes both. D2 fetches icons and images named by URL while it renders, so the mod runs it with every proxy variable (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`) pointed at a closed local port: the fetch fails at once, D2 draws a placeholder in the icon's place, and the tool's answer tells Claude why. ImageMagick detects formats by content, and some of its formats (MVG, MSL) are scripts that can fetch URLs, so the mod reads the file's signature, refuses anything that is not JPEG, GIF, WebP, BMP, TIFF or HEIC, and passes the format to ImageMagick explicitly (`jpeg:photo.jpg`).

The mod does not police other tools: a `curl` to an online renderer from Bash is outside it.

## Renderers

`d2` renders `show_diagram`: one binary with its layout engines and fonts inside, which writes the PNG itself in tens of milliseconds; it covers architecture with nested containers, sequence, class and ER diagrams. `resvg` renders the SVG files `show_image` is given, with `rsvg-convert` (librsvg) as a fallback. When a renderer is missing the tool fails with the install command for your system and Claude offers to run it.

| System | Command |
|---|---|
| macOS (Homebrew) | `brew install resvg d2` |
| Debian, Ubuntu | `sudo apt install librsvg2-bin` |
| Fedora | `sudo dnf install librsvg2-tools` |
| Arch | `sudo pacman -S resvg d2` |
| openSUSE | `sudo zypper install rsvg-convert` |
| Alpine | `sudo apk add rsvg-convert` |

Where the system has no `d2` package (every row but Homebrew and Arch), D2's own script installs it: `curl -fsSL https://d2lang.com/install.sh | sh -s --`.

Binaries are looked up on `PATH` and then in `/opt/homebrew/bin`, `/usr/local/bin`, `/home/linuxbrew/.linuxbrew/bin`, `/usr/bin` and `/snap/bin`, so a session started outside a login shell still finds them.

## The /term-images command

`/term-images` reports the terminal's support (and why the tools are off where they are), which renderers are found, the install command for what is missing, and draws a small colour gradient: if the gradient shows, pictures work in this terminal.

## Options

Set in `/config` or in `settings.json` under `pluginConfigs["term-images"].options`. `maxColumns` (default 120) and `maxRows` (default 45) cap the picture's box in cells; a picture is never drawn wider than its natural size or the terminal. `cellAspect` (default 2.1) is a cell's height divided by its width: the engine scales the picture to fill its box, so raise it if pictures look stretched vertically, lower it if they look squashed. `autoAllow` (default true) skips the permission prompt.

## Loading it

For one session: `claude --plugin-dir <path to this folder>`. For every session, add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`. To install it from GitHub, run `/plugin install term-images --marketplace Verce11o/cc-vercello`.

## Development

`claude plugin validate .` checks the manifest and the hooks module; `claude plugin test .` runs `tests/`, which mock the renderers, the file system and the environment.
