#!/bin/sh
#
# Install the pix-mono distro into Pi Coding Agent.
#
# Self-contained + POSIX sh: installs Pi itself (via Bun), then installs
# every @xynogen/pix-* package from npm. Safe to re-run.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/xynogen/pix-mono/main/scripts/install.sh | sh
#   # or, from a local checkout:
#   sh scripts/install.sh
#
# Prerequisites: Bun (https://bun.sh).
set -eu

# The distro installs as two modules:
#
#   CORE_PACKAGE       — pix-core, the meta/aggregator extension. Its
#                        package.json lists every bundled member as an npm
#                        `dependency` — the core UI/UX extensions (pix-welcome,
#                        pix-footer, pix-models, pix-update, pix-commands
#                        (including /btw), pix-nudge, pix-diagnostics,
#                        pix-prompts, pix-skills),
#                        the standard tool suite (pix-read, pix-write, pix-edit,
#                        pix-find, pix-grep, pix-ls, pix-bash, pix-todo,
#                        pix-ask), plus pix-optimizer and pix-gate — and pulls
#                        pix-data/pix-pretty transitively. A single
#                        `pi install` fetches the whole tree;
#                        pix-core/src/extension.ts imports each member's factory
#                        and boots them in-process. Pi only needs the ONE
#                        extension registered — installing bundled members
#                        separately is redundant. So: install pix-core alone.
#   THEME_PACKAGE      — pix-themes: the theme pack (Tokyo Night Storm +
#                        One Dark Pro). Not bundled by pix-core but installed
#                        unconditionally (it carries the distro's default look,
#                        pix-tokyo-night, not an opt-in capability).
#   OPTIN_PIX_PACKAGES  — standalone @xynogen/pix-* extensions NOT bundled by
#                        pix-core, each carrying a setup cost or sensitive
#                        capability (external MCP servers, API key, root
#                        execution, power-user UI).
#   OPTIN_COMMUNITY_PACKAGES — third-party packages (not part of the pix
#                        distro) offered as optional extras.
#                        Both opt-in lists default to NO when the installer
#                        cannot prompt (non-interactive `curl | sh`), keeping
#                        the default distro lean.
CORE_PACKAGE="npm:@xynogen/pix-core"
THEME_PACKAGE="npm:@xynogen/pix-themes"

# Recommended community packages — installed unless declined.
# Format: "<spec>|<description>"
RECOMMENDED_PACKAGES="
npm:pi-lens|LSP code intelligence — jump-to-definition, references, hover, and proactive diagnostics. (Recommended)
"

# Opt-in Pix extensions — each carries a setup cost or sensitive capability.
# Format: "<spec>|<why it's opt-in>"
OPTIN_PIX_PACKAGES="
npm:@xynogen/pix-mcp|Token-efficient MCP gateway — external servers can execute commands or access sensitive services, so configure and enable it explicitly.
npm:@xynogen/pix-9router|9Router LLM provider + fetch/search tools — needs a 9Router API key, so only useful if you route through 9Router.
npm:@xynogen/pix-env|Secret broker — reads local .env values and injects approved references into tool calls, so enable it explicitly.
npm:@xynogen/pix-ssh|ssh_run — remote command execution with optional root access, so enable this privileged capability explicitly.
npm:@xynogen/pix-sudo|sudo_run — root execution via a PAM password overlay; a privileged capability you opt into explicitly (blocked in non-interactive mode).
npm:@xynogen/pix-toolbox|/toolbox — fuzzy-search picker to enable/disable tools at runtime; a power-user utility, not needed for normal use.
npm:@xynogen/pix-graph|Native-TS code knowledge graph (build/query via CLI); a standalone tool you invoke on demand, not part of the always-on distro.
"

# Opt-in community extensions — third-party packages, not part of the pix distro.
# Format: "<spec>|<why it's opt-in>"
OPTIN_COMMUNITY_PACKAGES="
npm:@agnishc/edb-context-viewer|Context viewer — inspect the system prompt and full LLM context in scrollable overlay popups; a debug/introspection utility.
"

# --- minimal logging helpers (no external lib dependency) ------------------
info() { printf '\033[0;34m›\033[0m %s\n' "$*"; }
success() { printf '\033[0;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[0;33m!\033[0m %s\n' "$*" >&2; }
error() { printf '\033[0;31m✖\033[0m %s\n' "$*" >&2; }

command_exists() { command -v "$1" >/dev/null 2>&1; }

# Prompt a yes/no question on the controlling terminal. Returns 0 for yes.
#
# When piped (`curl ... | sh`) stdin is the script body, not a keyboard, so we
# read from /dev/tty. If we can't reach a usable terminal (CI, fully
# non-interactive), default to NO so opt-in packages are skipped, never
# installed by surprise. $1 = question, $2 = reason shown before the prompt.
ask_yes_no() {
	question="$1"
	reason="$2"

	# Pick a readable input source: current stdin if it's a tty, else /dev/tty.
	# A bare `-e /dev/tty` test is not enough — in sandboxes the node exists but
	# open() fails (ENXIO), so probe by actually opening it.
	if [ -t 0 ]; then
		tty_in=0
	elif { : </dev/tty; } 2>/dev/null; then
		tty_in=tty
	else
		warn "Non-interactive shell — skipping: $question"
		return 1
	fi

	printf '\033[0;34m›\033[0m %s\n' "$reason"
	printf '\033[0;34m›\033[0m %s [y/N] ' "$question"
	if [ "$tty_in" = tty ]; then
		read -r answer </dev/tty || answer=""
	else
		read -r answer || answer=""
	fi
	case "$answer" in
	[Yy] | [Yy][Ee][Ss]) return 0 ;;
	*) return 1 ;;
	esac
}

# --- 1. install / update Pi -------------------------------------------------
info "Setting up Pi Coding Agent..."

if command_exists bun; then
	info "Installing @earendil-works/pi-coding-agent globally (bun)..."
	if bun add -g --ignore-scripts @earendil-works/pi-coding-agent; then
		success "Pi Coding Agent installed/updated."
	else
		error "Failed to install @earendil-works/pi-coding-agent via bun."
		exit 1
	fi
elif command_exists npm; then
	warn "Bun not found — falling back to npm."
	info "Installing @earendil-works/pi-coding-agent globally (npm)..."
	if npm install -g --ignore-scripts @earendil-works/pi-coding-agent; then
		success "Pi Coding Agent installed/updated."
	else
		error "Failed to install @earendil-works/pi-coding-agent via npm."
		exit 1
	fi
else
	error "Neither Bun (https://bun.sh) nor npm (https://nodejs.org) is installed."
	exit 1
fi

if ! command_exists pi; then
	error "'pi' not found on PATH after install. Ensure the global bin dir is on PATH."
	exit 1
fi

# --- 2. install the pix distro ----------------------------------------------
# `pi install` is idempotent and reports its result on stdout. We must NOT
# pre-guard with `pi list | grep`: `pi list` emits a TTY-dependent listing —
# piped (no TTY) it omits the extension packages entirely, so the grep would
# always miss and re-install everything on every run. Call `pi install`
# unconditionally and classify by its output instead ("Installed" covers both
# a fresh install and an already-present package).
install_pi_pkg() {
	spec="$1"
	info "Installing pi pkg: $spec"
	out=$(pi install "$spec" 2>&1) || true
	if printf '%s' "$out" | grep -qiF 'installed'; then
		success "Pi pkg installed: $spec"
		return 0
	else
		error "Failed to install pi pkg: $spec"
		return 1
	fi
}

# Parse a "<spec>|<reason>" entry.
entry_spec() { printf '%s' "${1%%|*}"; }
entry_reason() { printf '%s' "${1#*|}"; }

# pix-core and pix-themes both install into the same node_modules tree —
# `pi install` runs npm under the hood, so they must run sequentially.
info "Installing Pix core + theme modules..."
install_pi_pkg "$CORE_PACKAGE"
install_pi_pkg "$THEME_PACKAGE"

# Recommended community packages — installed unless declined.
printf '\n'
printf '\033[0;34m›\033[0m \033[1mRecommended community packages\033[0m (enhances Pi with LSP capabilities):\n'
OLD_IFS=$IFS
IFS='
'
for entry in $RECOMMENDED_PACKAGES; do
	IFS=$OLD_IFS
	[ -z "$entry" ] && continue
	spec=$(entry_spec "$entry")
	reason=$(entry_reason "$entry")
	if ask_yes_no "Install ${spec#npm:}?" "$reason"; then
		install_pi_pkg "$spec"
	else
		info "Skipped: $spec"
	fi
	IFS='
'
done
IFS=$OLD_IFS

# Opt-in pix extensions — each carries a setup cost or sensitive capability.
printf '\n'
printf '\033[0;34m›\033[0m \033[1mOptional Pix extensions\033[0m (need extra setup or grant sensitive capabilities):\n'
OLD_IFS=$IFS
IFS='
'
for entry in $OPTIN_PIX_PACKAGES; do
	IFS=$OLD_IFS
	[ -z "$entry" ] && continue
	spec=$(entry_spec "$entry")
	reason=$(entry_reason "$entry")
	if ask_yes_no "Install ${spec#npm:@xynogen/}?" "$reason"; then
		install_pi_pkg "$spec"
	else
		info "Skipped: $spec"
	fi
	IFS='
'
done
IFS=$OLD_IFS

# Opt-in community extensions — third-party packages.
printf '\n'
printf '\033[0;34m›\033[0m \033[1mOptional community extensions\033[0m (third-party packages, not part of pix):\n'
OLD_IFS=$IFS
IFS='
'
for entry in $OPTIN_COMMUNITY_PACKAGES; do
	IFS=$OLD_IFS
	[ -z "$entry" ] && continue
	spec=$(entry_spec "$entry")
	reason=$(entry_reason "$entry")
	if ask_yes_no "Install ${spec#npm:}?" "$reason"; then
		install_pi_pkg "$spec"
	else
		info "Skipped: $spec"
	fi
	IFS='
'
done
IFS=$OLD_IFS

mkdir -p "${XDG_CACHE_HOME:-$HOME/.cache}/pi/fff"

# --- 4. done ----------------------------------------------------------------
# Note: the built-in /model command is removed by pix-core at extension load
# (self-healing across Pi upgrades) — no install-time patch needed here.
info "Authentication Setup:"
warn "Run 'pi' then '/login' to use a subscription (Claude/ChatGPT/Copilot)."
success "pix-mono setup complete!"
