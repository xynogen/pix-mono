#Requires -Version 5.1
<#
.SYNOPSIS
  Uninstall the pix-mono distro from Pi Coding Agent on native Windows.

.DESCRIPTION
  Windows counterpart of scripts/uninstall.sh. Removes every @xynogen/pix-*
  package registered in Pi, then restores Pi's built-in /model command.
  Safe to re-run - skips packages that are already absent.

.EXAMPLE
  irm https://raw.githubusercontent.com/xynogen/pix-mono/main/scripts/uninstall.ps1 | iex

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall.ps1
  # or: bun run distro:uninstall

.NOTES
  Keep the package list in sync with scripts/uninstall.sh. pix-update is
  intentionally excluded so the updater is never removed mid-flow.
#>

$__pixUninstaller = {
	Set-StrictMode -Version 2.0
	$ErrorActionPreference = "Stop"
	$ProgressPreference = "SilentlyContinue"

	# The list is intentionally NOT symmetric with install.ps1: users may have
	# installed members standalone, so sweep every known package. `pi remove`
	# on an absent package is a safe no-op.
	$CorePackages = @(
		"npm:@xynogen/pix-data"
		"npm:@xynogen/pix-core"
		"npm:@xynogen/pix-welcome"
		"npm:@xynogen/pix-footer"
		"npm:@xynogen/pix-commands"
		"npm:@xynogen/pix-nudge"
		"npm:@xynogen/pix-diagnostics"
		"npm:@xynogen/pix-display"
		"npm:@xynogen/pix-prompts"
		"npm:@xynogen/pix-skills"
		"npm:@xynogen/pix-models"
		"npm:@xynogen/pix-subagent"
	)
	$ExtensionPackages = @(
		"npm:@xynogen/pix-codemode"
		"npm:@xynogen/pix-themes"
		"npm:@xynogen/pix-mcp"
		"npm:@xynogen/pix-env"
		"npm:@xynogen/pix-optimizer"
		"npm:@xynogen/pix-9router"
		"npm:@xynogen/pix-pretty"
		"npm:@xynogen/pix-runtime"
		"npm:@xynogen/pix-bash"
		"npm:@xynogen/pix-powershell"
		"npm:@xynogen/pix-read"
		"npm:@xynogen/pix-write"
		"npm:@xynogen/pix-edit"
		"npm:@xynogen/pix-find"
		"npm:@xynogen/pix-grep"
		"npm:@xynogen/pix-ls"
		"npm:@xynogen/pix-ssh"
		"npm:@xynogen/pix-sudo"
		"npm:@xynogen/pix-todo"
		"npm:@xynogen/pix-ask"
		"npm:@xynogen/pix-toolbox"
		"npm:@xynogen/pix-graph"
		"npm:@xynogen/pix-astgrep"
		"npm:@xynogen/pix-hunk"
		"npm:@xynogen/pix-aria2"
		"npm:@xynogen/pix-proc"
		"npm:@xynogen/pix-search"
		"npm:@xynogen/pix-web"
		"npm:@xynogen/pix-voice"
		"npm:@xynogen/pix-gate"
	)

	# --- logging helpers ---------------------------------------------------------
	$useColor = -not $env:NO_COLOR
	$glyph = @{ Info = [string][char]0x203A; Ok = [string][char]0x2713; Warn = "!"; Err = [string][char]0x2716 }

	function Write-Line([string]$Prefix, [string]$Color, [string]$Text) {
		if ($useColor) { Write-Host $Prefix -ForegroundColor $Color -NoNewline } else { Write-Host $Prefix -NoNewline }
		Write-Host " $Text"
	}
	function Write-Info([string]$Text) { Write-Line $glyph.Info "Blue" $Text }
	function Write-Success([string]$Text) { Write-Line $glyph.Ok "Green" $Text }
	function Write-Warn([string]$Text) { Write-Line $glyph.Warn "Yellow" $Text }
	function Write-Err([string]$Text) { Write-Line $glyph.Err "Red" $Text }
	function Write-Section([string]$Text) {
		Write-Host ""
		if ($useColor) { Write-Host $Text -ForegroundColor White } else { Write-Host $Text }
	}
	function Write-Indented([string[]]$Lines) {
		foreach ($line in $Lines) { if ($line) { Write-Host "  $line" -ForegroundColor DarkGray } }
	}
	function Remove-Ansi([string]$Text) { return $Text -replace '\x1b\[[0-9;?]*[A-Za-z]', '' }

	function Get-PiCommand {
		foreach ($name in "pi.cmd", "pi.exe", "pi") {
			$command = Get-Command $name -CommandType Application, ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1
			if ($command) { return $command.Source }
		}
		return $null
	}

	function Invoke-Captured([string]$Exe, [string[]]$Arguments) {
		$previous = $ErrorActionPreference
		$ErrorActionPreference = "Continue"
		try {
			$output = & $Exe @Arguments 2>&1 | ForEach-Object { Remove-Ansi "$_" }
			return @{ Code = $LASTEXITCODE; Output = @($output) }
		} finally {
			$ErrorActionPreference = $previous
		}
	}

	# Registered package specs, one per `pi list` line (indented, e.g. "  npm:@x/y").
	function Get-RegisteredSpecs([string]$Pi) {
		$result = Invoke-Captured $Pi @("list")
		return @($result.Output | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^npm:' })
	}

	# --- /model restore ------------------------------------------------------------
	# pix-models strips Pi's /model entry from BUILTIN_SLASH_COMMANDS at load time
	# (packages/pix-models/src/patch-builtin.ts). Re-insert it as the first entry.
	function Get-PiPackageRoots([string]$Pi) {
		$roots = New-Object System.Collections.Generic.List[string]
		$agentDir = Join-Path $env:USERPROFILE ".pi\agent"
		# Managed install (pi.dev/install.ps1): install\current-version -> releases\<v>.
		$installRoot = Join-Path $agentDir "install"
		$versionFile = Join-Path $installRoot "current-version"
		if (Test-Path $versionFile) {
			$version = (Get-Content -Raw $versionFile).Trim()
			if ($version -match '^[0-9A-Za-z._+-]+$') {
				$roots.Add((Join-Path $installRoot "releases\$version\node_modules\@earendil-works\pi-coding-agent"))
			}
		}
		# npm / bun global installs next to the pi shim.
		if ($Pi) {
			$binDir = Split-Path $Pi -Parent
			$roots.Add((Join-Path $binDir "node_modules\@earendil-works\pi-coding-agent"))
		}
		if ($env:APPDATA) { $roots.Add((Join-Path $env:APPDATA "npm\node_modules\@earendil-works\pi-coding-agent")) }
		$roots.Add((Join-Path $env:USERPROFILE ".bun\install\global\node_modules\@earendil-works\pi-coding-agent"))
		return @($roots | Where-Object { Test-Path $_ -PathType Container } | Select-Object -Unique)
	}

	function Find-SlashCommandsFile([string]$Pi) {
		foreach ($root in Get-PiPackageRoots $Pi) {
			$candidates = @()
			$chunkDir = Join-Path $root "dist\bundle\chunks"
			if (Test-Path $chunkDir) { $candidates += @(Get-ChildItem $chunkDir -Filter *.js | ForEach-Object FullName) }
			$candidates += Join-Path $root "dist\core\slash-commands.js"
			foreach ($file in $candidates) {
				if ((Test-Path $file -PathType Leaf) -and (Select-String -Path $file -Pattern 'BUILTIN_SLASH_COMMANDS\s*=\s*\[' -Quiet)) {
					return $file
				}
			}
		}
		return $null
	}

	function Restore-BuiltinModelCommand([string]$Pi) {
		$file = Find-SlashCommandsFile $Pi
		if (-not $file) {
			Write-Warn "Could not locate Pi's slash-command source - skipping /model restore."
			return
		}
		$utf8 = New-Object System.Text.UTF8Encoding $false
		$source = [IO.File]::ReadAllText($file, $utf8)
		if ($source -match 'name\s*:\s*["'']model["'']') { return }

		Write-Info "Restoring Pi's built-in /model command..."
		$entry = '{ name: "model", description: "Select model (opens selector UI)", argumentHint: "<provider/model>" },'
		$pattern = [regex]'BUILTIN_SLASH_COMMANDS\s*=\s*\['
		$patched = $pattern.Replace($source, '$0' + $entry, 1)
		try {
			[IO.File]::WriteAllText($file, $patched, $utf8)
			Write-Success "Built-in /model command restored."
		} catch {
			Write-Warn "Could not restore /model (read-only install?): $($_.Exception.Message)"
		}
	}

	# --- main --------------------------------------------------------------------
	if ($useColor) { Write-Host "Pix uninstaller" -ForegroundColor White } else { Write-Host "Pix uninstaller" }

	$pi = Get-PiCommand
	if (-not $pi) { throw "'pi' not found on PATH - nothing to uninstall." }

	$installed = Get-RegisteredSpecs $pi
	$removed = 0

	Write-Section "Removing Pix packages"
	foreach ($spec in $CorePackages + $ExtensionPackages) {
		if ($installed -notcontains $spec) { continue }
		$label = $spec -replace '^npm:', ''
		Write-Info "Removing $label..."
		$result = Invoke-Captured $pi @("remove", $spec)
		if ($result.Code -eq 0) {
			Write-Success $label
			$removed++
		} else {
			Write-Warn "Could not remove $label."
			Write-Indented $result.Output
		}
	}

	Restore-BuiltinModelCommand $pi

	# Final state, not command wording, decides whether uninstall succeeded.
	$remaining = @(Get-RegisteredSpecs $pi | Where-Object { $_ -like 'npm:@xynogen/pix-*' })

	Write-Section "Summary"
	Write-Info "Removed: $removed $([char]0x00B7) remaining: $($remaining.Count)"
	if ($remaining.Count -gt 0) {
		Write-Err "Uninstall incomplete. Pix packages still registered:"
		Write-Indented $remaining
		throw "Uninstall incomplete."
	}
	Write-Success "No Pix packages remain. Restart pi to apply."
}

$__pixEncoding = $null
try { $__pixEncoding = [Console]::OutputEncoding; [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }
$__pixCode = 0
try {
	& $__pixUninstaller
} catch {
	Write-Host ([string][char]0x2716) -ForegroundColor Red -NoNewline
	Write-Host " $($_.Exception.Message)"
	$__pixCode = 1
} finally {
	if ($__pixEncoding) { try { [Console]::OutputEncoding = $__pixEncoding } catch { } }
}
$global:LASTEXITCODE = $__pixCode
Remove-Variable __pixUninstaller, __pixEncoding -ErrorAction SilentlyContinue
if ($PSCommandPath) { exit $__pixCode }
Remove-Variable __pixCode -ErrorAction SilentlyContinue
