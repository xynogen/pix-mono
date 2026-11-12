---
name: pix-sudo
description: How to use `sudo_run` for root on the local machine — a command plus a plain-English reason shown as the approval title, and the boundary between local root, local shell, and remote work. Use only when a command truly needs root here.
disable-model-invocation: true
---
# sudo_run — local root

## Input

`{ "command": "apt-get install -y ripgrep", "reason": "install the ripgrep binary the project requires" }`

- `command` runs through `sh -c` as root.
- `reason` is required. It is the approval title, so write what root is for, not a restatement of the command.

## Right tool

| Job | Tool |
|---|---|
| root on this machine | `sudo_run` |
| normal local command | `bash` |
| any remote command (root included) | `ssh_run`, with `sudo: true` for remote root |

`sudo_run` never runs remote work, and a caller cannot pre-approve it.

## Approval

The user sees a dialog with the reason and the command. Unattended modes apply: `/afk` denies it, `/yolo` runs it without the prompt. A denial is a decision, not a transient error; report it instead of reshaping the same command to slip through.

## Do not

- Reach for root first. Try the user-level command, then say why root is needed.
- Prepend `sudo` inside a `bash` command. Use this tool so the approval and the reason exist.
- Split one root task into three calls. One call, one reason, grouped commands.
