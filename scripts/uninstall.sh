#!/bin/sh
#
# Uninstall the pix-mono distro from Pi Coding Agent.
#
# Removes every @xynogen/pix-* package that the install script registers.
# Safe to re-run — skips packages that are already absent.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/xynogen/pix-mono/main/scripts/uninstall.sh | sh
#   # or, from a local checkout:
#   sh scripts/uninstall.sh   # or: bun run distro:uninstall
set -eu

# NOTE: this list is intentionally NOT symmetric with install.sh.
#
# install.sh installs only `pix-core` (npm pulls the member tree; the
# aggregator boots them in-process), so it lists a single CORE package. But
# uninstall MUST enumerate every package individually: a user may have
# `pi install`'d members standalone (e.g. just pix-bash + pix-read, never the
# meta), so we cannot assume the meta-tree shape and must sweep all known
# packages. `pi remove` on an absent package is a safe no-op ("No matching
# package found", exit 0), so the full sweep is fully idempotent.

# CORE module — pix-core meta extension, its sub-packages, and the shared
# pix-data model data layer they read from.
#
# pix-update is intentionally EXCLUDED: it must survive an uninstall so the
# updater is never removed mid-flow. It is refreshed only via
# `pi update --extensions`, never via this uninstall+reinstall sweep.
CORE_PACKAGES="
npm:@xynogen/pix-data
npm:@xynogen/pix-core
npm:@xynogen/pix-welcome
npm:@xynogen/pix-footer
npm:@xynogen/pix-commands
npm:@xynogen/pix-nudge
npm:@xynogen/pix-diagnostics
npm:@xynogen/pix-display
npm:@xynogen/pix-prompts
npm:@xynogen/pix-skills
npm:@xynogen/pix-models
npm:@xynogen/pix-subagent
"

# EXTENSION module — standalone extension + tool packages.
EXTENSION_PACKAGES="
npm:@xynogen/pix-themes
npm:@xynogen/pix-mcp
npm:@xynogen/pix-env
npm:@xynogen/pix-optimizer
npm:@xynogen/pix-9router
npm:@xynogen/pix-pretty
npm:@xynogen/pix-runtime
npm:@xynogen/pix-bash
npm:@xynogen/pix-read
npm:@xynogen/pix-write
npm:@xynogen/pix-edit
npm:@xynogen/pix-find
npm:@xynogen/pix-grep
npm:@xynogen/pix-ls
npm:@xynogen/pix-ssh
npm:@xynogen/pix-sudo
npm:@xynogen/pix-todo
npm:@xynogen/pix-ask
npm:@xynogen/pix-toolbox
npm:@xynogen/pix-graph
npm:@xynogen/pix-gate
"

info() { printf '\033[0;34m›\033[0m %s\n' "$*"; }
success() { printf '\033[0;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[0;33m!\033[0m %s\n' "$*" >&2; }
error() { printf '\033[0;31m✖\033[0m %s\n' "$*" >&2; }

if ! command -v pi >/dev/null 2>&1; then
	error "'pi' not found on PATH — nothing to uninstall."
	exit 1
fi

# Restore Pi's built-in /model slash command.
#
# pix-models strips Pi's `/model` entry from compiled slash-commands.js at load
# time (see packages/pix-models/src/patch-builtin.ts). Removing the package
# leaves that edit in place, so re-insert the current Pi form as the first item
# in BUILTIN_SLASH_COMMANDS. This is intentionally independent of the removed
# entry's historical shape and is idempotent when `/model` already exists.
restore_builtin_model_command() {
	# Locate slash-commands.js via the running pi binary.
	pi_bin=$(command -v pi 2>/dev/null) || true
	pi_real=$(realpath "$pi_bin" 2>/dev/null) || true
	slash_cmd_file=""
	if [ -n "$pi_real" ]; then
		candidate=$(dirname "$pi_real")/core/slash-commands.js
		[ -f "$candidate" ] && slash_cmd_file="$candidate"
	fi
	# Fallback: well-known global install locations.
	if [ -z "$slash_cmd_file" ]; then
		for root in \
			"$HOME/.bun/install/global/node_modules" \
			"$HOME/.npm-global/lib/node_modules" \
			"/usr/local/lib/node_modules" \
			"/usr/lib/node_modules"; do
			candidate="$root/@earendil-works/pi-coding-agent/dist/core/slash-commands.js"
			if [ -f "$candidate" ]; then
				slash_cmd_file="$candidate"
				break
			fi
		done
	fi

	if [ -z "$slash_cmd_file" ]; then
		warn "Could not locate slash-commands.js — skipping /model restore."
		return 0
	fi

	# Already present — nothing to do.
	if grep -qF '{ name: "model"' "$slash_cmd_file" 2>/dev/null; then
		return 0
	fi

	info "Restoring Pi's built-in /model command..."
	# Insert the current Pi /model form as the first built-in entry. Use a temp
	# file to avoid sed -i portability issues (macOS vs Linux).
	model_line='  { name: "model", description: "Select model (opens selector UI)", argumentHint: "<provider/model>" },'
	tmp=$(mktemp) || {
		warn "mktemp failed — skipping /model restore."
		return 0
	}
	if sed "s|export const BUILTIN_SLASH_COMMANDS = \[|export const BUILTIN_SLASH_COMMANDS = [\n${model_line}|" \
		"$slash_cmd_file" >"$tmp" 2>/dev/null && mv "$tmp" "$slash_cmd_file" 2>/dev/null; then
		success "Built-in /model command restored."
	else
		rm -f "$tmp"
		warn "Could not restore /model (read-only install?)."
	fi
}

# Snapshot installed packages once, then skip any not in the list.
INSTALLED=$(pi list 2>&1)

remove_pi_pkg() {
	spec="$1"
	if ! printf '%s' "$INSTALLED" | grep -qF "$spec"; then
		info "Not installed, skipping: $spec"
		return 0
	fi
	info "Removing pi pkg: $spec"
	out=$(pi remove "$spec" 2>&1) || true
	if printf '%s' "$out" | grep -qiF 'removed'; then
		success "Removed: $spec"
	else
		warn "Could not confirm removal of: $spec"
	fi
}

# Remove all packages sequentially to avoid npm lock conflicts.
info "Uninstalling Pix core + extension modules..."
for spec in $CORE_PACKAGES $EXTENSION_PACKAGES; do
	remove_pi_pkg "$spec"
done

restore_builtin_model_command

success "pix-mono uninstalled. Restart pi to apply."
