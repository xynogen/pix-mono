---
name: environment
description: Loads live facts about the user's machine — OS, distro, kernel, architecture, user, CPU count, and working directory — before running or suggesting platform-specific commands. Use whenever a request depends on the platform, such as installing packages, managing services, choosing file paths, downloading arch-specific binaries, or any command whose syntax differs between systems.
disable-model-invocation: true
---
# Environment

The blocks below hold live facts captured when this skill loaded. They are the ground truth. Never assume a default platform.

## OS release

!`cat /etc/os-release`

## Kernel, hostname, architecture

!`uname -srnm`

## CPU count

!`nproc`

## User

!`id -un`

## Working directory

!`pwd`

## Use the facts

If the user's request assumes a different platform, name the mismatch and offer the equivalent command. Run it only after the user confirms.

| `ID` / `ID_LIKE` | Manager | Refresh | Install |
|---|---|---|---|
| `debian`, `ubuntu` | `apt` | `apt update` | `apt install <pkg>` |
| `fedora`, `rhel`, `centos`, `rocky` | `dnf` | `dnf check-update` | `dnf install <pkg>` |
| `arch`, `manjaro` | `pacman` | (none; never `-Sy` alone) | `pacman -Syu <pkg>` |
| `opensuse`, `suse` | `zypper` | `zypper refresh` | `zypper install <pkg>` |
| `alpine` | `apk` | `apk update` | `apk add <pkg>` |
| macOS (`Darwin`) | `brew` | `brew update` | `brew install <pkg>` |

- **Architecture** — match `x86_64` or `aarch64` (`arm64`) release artifacts to the `uname` output.
- **Privilege** — system changes need root. Use a dedicated root tool if one exists (search for it); do not inline `sudo` in a shell command.
- **Parallelism** — size build jobs to the CPU count (`make -j<N>`).
- **Paths** — use the real user and home, never a hardcoded `/home/user`.

A fact that is blank, missing, or shows `[blocked: …]` (the loader blocked that command) → ask the user. Do not guess.
