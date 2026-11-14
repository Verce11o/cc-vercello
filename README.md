# cc-vercello

<img width="2688" height="664" alt="CleanShot 2026-11-14 at 18 42 46@2x" src="https://github.com/user-attachments/assets/994082db-3ab5-4fe0-8ebf-0298d657272a" />


A [Claude Code](https://code.claude.com) plugin marketplace with a mod that draws real pictures in the terminal.

| Plugin | What it does |
|---|---|
| [`term-images`](term-images/README.md) | Lets Claude render D2 diagrams locally and show them, and image files, as pictures inline in the terminal. |

It draws through kitty Unicode placeholders in **Ghostty** and **kitty**, and in **iTerm2** 3.6+ with `CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1`; without that variable iTerm2 3.5+ draws its own inline images under the fullscreen renderer (`/tui fullscreen`). In terminals that cannot draw pictures inline its tools are off. Tested with Claude Code 2.1.323 on macOS in Ghostty, iTerm2 3.7.7 and Warp (off there).

## Setup with an agent

Paste this prompt into Claude Code (or any coding agent that can run shell commands and edit files on your machine):

````text
Set up the cc-vercello Claude Code plugin on this machine. Do the steps in order and report what you did.

1. Add the marketplace and install the plugin with the Claude Code CLI:
   claude plugin marketplace add Verce11o/cc-vercello
   claude plugin install term-images@cc-vercello
   If a command says the marketplace or the plugin is already installed, keep going.

2. Find out which terminal I use: run `echo "$TERM_PROGRAM / $TERM"`.
   - If it is Ghostty (`ghostty` / `xterm-ghostty`) or kitty (`xterm-kitty`), add `"CLAUDE_CODE_FORCE_TERMINAL_IMAGES": "1"` to the `env` object of ~/.claude/settings.json. Read the file first and merge: keep every existing key, create `env` if it is missing, and do not overwrite the file. Show me the resulting `env` block.
   - If it is iTerm2 (`iTerm.app`), check its version with `echo $TERM_PROGRAM_VERSION`. From 3.6 on, add the same variable: iTerm2 then draws pictures on the main screen too. On 3.5, do not add it, and tell me to run `/tui fullscreen` in Claude Code if I do not use it yet.
   - If it is st with the kitty graphics patch, or Claude Code runs over ssh from AbsoluteTelnet, add the same variable.
   - For any other terminal (Terminal.app, VS Code, WezTerm, Konsole, Warp), do not add it: they draw no kitty Unicode placeholders, so pictures would come out as garbage.

3. term-images draws pictures with local programs that the plugin does not install itself. Check them:
   - D2, needed for D2 diagrams: `command -v d2`
   - `resvg` or `rsvg-convert`, needed to show SVG files: `command -v resvg rsvg-convert`. One of the two is enough.
   Without a renderer, term-images refuses that kind of picture and the other keeps working. If anything is missing, tell me what each missing program is for and offer to install it so that term-images works fully. Install commands:
   - macOS (Homebrew): `brew install resvg d2`
   - Debian, Ubuntu: `sudo apt install librsvg2-bin`, and D2 with `curl -fsSL https://d2lang.com/install.sh | sh -s --`
   - Fedora: `sudo dnf install librsvg2-tools`, and D2 with `curl -fsSL https://d2lang.com/install.sh | sh -s --`
   - Arch: `sudo pacman -S resvg d2`
   - Other systems: https://github.com/Verce11o/cc-vercello/blob/main/term-images/README.md
   Install only the missing programs, and only after I say yes. Then run the checks again and report the result.

4. Tell me to open a new Claude Code session, because settings and plugins load at session start. In that session `/term-images` shows which renderers were found and draws a gradient: if the gradient shows, pictures work.

Do not change anything else in my settings.
````

If you prefer to do it by hand, the same steps are below.

## Manual install

In a Claude Code session:

```
/plugin marketplace add Verce11o/cc-vercello
/plugin install term-images@cc-vercello
```

Or with the CLI:

```
claude plugin marketplace add Verce11o/cc-vercello
claude plugin install term-images@cc-vercello
```

Then open a new session.

### Ghostty and kitty: one setting

If a diagram shows as a caption instead of the picture, Claude Code decided the terminal cannot draw inline pictures. In Ghostty and kitty fix it by adding this to the `env` block of `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_FORCE_TERMINAL_IMAGES": "1"
  }
}
```

The variable is undocumented and applies to every session and every mod. Set it only if you run Claude Code in Ghostty, kitty, iTerm2 3.6+ or another terminal that draws kitty Unicode placeholders.

## Layout

```
.claude-plugin/marketplace.json   the marketplace
term-images/                      plugin
```

The plugin has its own tests: `claude plugin validate term-images` and `claude plugin test term-images`.
