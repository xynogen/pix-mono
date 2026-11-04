<p align="center">
  <img src="https://raw.githubusercontent.com/xynogen/pix-mono/main/.github/assets/pix-logo.svg" alt="Pix" width="152" height="80">
</p>

# pix-aria2

Pi tool for direct, resumable downloads through a private [aria2](https://aria2.github.io/) RPC daemon. It gives the agent short `dl-*` handles for controlling transfers and shows active progress in the TUI.

The extension starts `aria2c` only when first used, binds RPC to `127.0.0.1`, authenticates it with a random per-session secret, and stops it when the Pi session shuts down.

## Requirements

This package requires:

- [Pi Coding Agent](https://github.com/earendil-works/pi)
- `aria2c`. pix finds it in this order: `~/.pi/agent/binary.json` → `~/.pi/agent/bin` → `PATH`.

On **Windows**, pix downloads the official `aria2/aria2` release into
`~/.pi/agent/bin` on first use, with a visible status. On Linux and macOS,
install aria2 with your package manager. For example:

```bash
# Fedora
sudo dnf install aria2

# Debian or Ubuntu
sudo apt install aria2

# macOS
brew install aria2
```

## Tool

The `download` tool supports five actions:

| Action | Required input | Result |
|---|---|---|
| `add` | `url` | Starts a transfer and returns a short `dl-*` handle |
| `list` | None | Lists active transfers with file name, percentage, bytes, speed, and ETA |
| `pause` | `handle` | Pauses a tracked transfer |
| `resume` | `handle` | Resumes a paused transfer and restores live progress polling |
| `rm` | `handle` | Removes the transfer from aria2 without deleting downloaded or partial files |

`add` also accepts `dir` to override the destination directory. The current working directory is used by default.

Example calls:

```ts
download({
  action: "add",
  url: "https://example.com/archive.iso",
  dir: "/tmp/downloads",
});

download({ action: "list" });
download({ action: "pause", handle: "dl-sleek-pika-63" });
download({ action: "resume", handle: "dl-sleek-pika-63" });
download({ action: "rm", handle: "dl-sleek-pika-63" });
```

## Supported downloads

aria2 downloads bytes and does not restrict file extensions. Current protocol support is:

| Input | Support |
|---|---|
| Direct HTTP and HTTPS URLs | Yes |
| FTP URLs | Yes |
| Magnet links and BitTorrent | Basic aria2 support |
| ISO, archive, package, image, document, audio, and video files | Yes, when supplied as direct URLs |
| Interrupted partial files | Yes, through aria2 continuation files |
| Segmented multi-connection downloads | Yes, managed by aria2 |

This package does not extract media URLs from web pages. YouTube, Twitch, HLS playlists, DASH manifests, DRM media, authentication cookies, custom request headers, transcoding, and playback are outside current scope. Use `yt-dlp`, `ffmpeg`, or another dedicated tool for those workflows.

## Runtime behavior

Each loaded extension instance owns one private aria2 daemon. The daemon uses:

- loopback-only RPC on a random port;
- a random 128-bit RPC secret;
- continuation enabled with `--continue=true`;
- overwrite and automatic file renaming disabled;
- one-second polling while downloads are active.

If RPC never comes up, the extension kills the half-started process. If the daemon crashes, the next call starts a new one.

Tool results use compact status rows in collapsed mode and framed details when expanded. Active transfers also appear in a live widget with handle, file name, completion, transferred size, speed, and ETA.

## Session limits

Download handles and daemon connection details are held in memory. They work across tool calls and pause/resume operations within the same running Pi process.

Quitting or fully restarting Pi stops the private daemon and discards handle mappings. Partial files remain on disk and can still be continued by aria2, but automatic cross-process reconnection is not implemented. Shared daemons, persistent handles, torrent file selection, per-download limits, and authenticated request configuration remain outside current scope.

## Development

Run focused package checks from the repository root:

```bash
bun test packages/pix-aria2
bun run check
bun run typecheck
```

`bun run typecheck` checks the full monorepo, not only this package.

## Install

```bash
pi install npm:@xynogen/pix-aria2
```

> Standalone and opt-in. [`@xynogen/pix-core`](https://www.npmjs.com/package/@xynogen/pix-core) does not bundle it. It needs the external `aria2c` binary and starts a local daemon.

## Full distro

This package is part of [Pix](https://github.com/xynogen/pix-mono). The installer sets up Pi and the full distro. See [Install](https://github.com/xynogen/pix-mono#install) for the notes for each OS.

```bash
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/xynogen/pix-mono/main/scripts/install.sh | sh
```

```powershell
# Windows
irm https://raw.githubusercontent.com/xynogen/pix-mono/main/scripts/install.ps1 | iex
```

## License

MIT. See [LICENSE](LICENSE).
