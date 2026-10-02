#Requires -Version 5.1
<#
.SYNOPSIS
  Install the pix-mono distro into Pi Coding Agent on native Windows.

.DESCRIPTION
  Windows counterpart of scripts/install.sh. Installs or updates Pi through
  Pi's official Windows installer (https://pi.dev/install.ps1), then installs
  @xynogen/pix-core, @xynogen/pix-themes, and any opt-in packages you accept.
  Safe to re-run.

  Works in Windows PowerShell 5.1 and PowerShell 7+.

.EXAMPLE
  irm https://raw.githubusercontent.com/xynogen/pix-mono/main/scripts/install.ps1 | iex

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1
  # or: bun run distro:install

.NOTES
  Keep the package lists in sync with scripts/install.sh.
  NO_COLOR=1 disables colored output. Without an interactive console every
  opt-in prompt defaults to NO.
#>

$__pixInstaller = {
	Set-StrictMode -Version 2.0
	$ErrorActionPreference = "Stop"
	$ProgressPreference = "SilentlyContinue"

	# The distro installs as two modules (see scripts/install.sh for details):
	#   pix-core   - aggregator; npm pulls every bundled member transitively.
	#   pix-themes - default theme pack; installed unconditionally.
	$CorePackage = "npm:@xynogen/pix-core"
	$ThemePackage = "npm:@xynogen/pix-themes"

	# Recommended community packages - installed unless declined.
	# Do not recommend pi-lens: pix-diagnostics registers the same tools.
	$RecommendedPackages = @()

	# Opt-in Pix extensions - each carries a setup cost or sensitive capability.
	$OptInPixPackages = @(
		@{ Spec = "npm:@xynogen/pix-codemode"; Reason = "Native codemode with highlighted scripts and Pix result frames; replaces the built-in renderer, so enable it explicitly." }
		@{ Spec = "npm:@xynogen/pix-mcp"; Reason = "Token-efficient MCP gateway - external servers can execute commands or access sensitive services, so configure and enable it explicitly." }
		@{ Spec = "npm:@xynogen/pix-web"; Reason = "Provider-neutral fetch and search tools - supports Exa, Tavily, You.com, Brave, SearXNG, 9Router, and basic HTTP." }
		@{ Spec = "npm:@xynogen/pix-9router"; Reason = "9Router LLM provider - needs a 9Router API key." }
		@{ Spec = "npm:@xynogen/pix-voice"; Reason = "Provider-neutral push-to-talk dictation plus the transcribe and speak tools - each provider needs its own API key." }
		@{ Spec = "npm:@xynogen/pix-env"; Reason = "Secret broker - reads local .env values and injects approved references into tool calls, so enable it explicitly." }
		@{ Spec = "npm:@xynogen/pix-ssh"; Reason = "ssh_run - remote command execution with optional root access, so enable this privileged capability explicitly." }
		@{ Spec = "npm:@xynogen/pix-sudo"; Reason = "sudo_run - root execution via a PAM password overlay; a privileged capability you opt into explicitly (blocked in non-interactive mode)." }
		@{ Spec = "npm:@xynogen/pix-toolbox"; Reason = "/toolbox - fuzzy-search picker to enable/disable tools at runtime; a power-user utility, not needed for normal use." }
		@{ Spec = "npm:@xynogen/pix-graph"; Reason = "Native-TS code knowledge graph (build/query via CLI); a standalone tool you invoke on demand, not part of the always-on distro." }
		@{ Spec = "npm:@xynogen/pix-astgrep"; Reason = "ast_grep_search / read_symbol / symbol_search - structural code search and symbol reads via the @ast-grep/napi native addon, so enable it explicitly." }
		@{ Spec = "npm:@xynogen/pix-hunk"; Reason = "Live Hunk diff-review bridge - requires the external Hunk CLI and an active review session, so enable it explicitly." }
		@{ Spec = "npm:@xynogen/pix-search"; Reason = "Smarter @ file search (fuzzy + git-recency ranking) that overrides Pi's built-in autocomplete, so opt in when you want that ranking." }
		@{ Spec = "npm:@xynogen/pix-aria2"; Reason = "Fast resumable downloads via an auto-managed aria2 daemon - requires the external aria2c binary, so enable it explicitly." }
		@{ Spec = "npm:@xynogen/pix-proc"; Reason = "proc tool - run and manage long-lived processes (npm run dev, vite, python) that outlive a turn; spawns background processes, so enable it explicitly." }
	)

	# Opt-in community extensions - third-party packages, not part of the pix distro.
	$OptInCommunityPackages = @(
		@{ Spec = "npm:@agnishc/edb-context-viewer"; Reason = "Context viewer - inspect the system prompt and full LLM context in scrollable overlay popups; a debug/introspection utility." }
	)

	# Windows compatibility. Unsupported packages are not offered, but each one
	# is reported with a reason and a manual install command.
	$WindowsUnsupported = @{
		"npm:@xynogen/pix-sudo" = "needs sudo and a PAM ticket, which native Windows does not provide."
	}
	# Partially supported packages are offered with a visible caveat.
	$WindowsCaveats = @{
		"npm:@xynogen/pix-voice" = "Windows: transcribe works; speak plays with the built-in MediaPlayer; push-to-talk records through ffmpeg (DirectShow)."
		"npm:@xynogen/pix-ssh"   = "Windows: needs an ssh with ControlMaster support first on PATH (Git for Windows ssh works; the built-in Windows OpenSSH does not). Password login also needs sshpass."
	}

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

	# --- environment helpers -----------------------------------------------------
	function Test-Interactive {
		try { return [Environment]::UserInteractive -and -not [Console]::IsInputRedirected } catch { return $false }
	}

	# Pull PATH changes made by child installers into this process.
	function Update-SessionPath {
		$parts = @()
		foreach ($scope in "Machine", "User") {
			$value = [Environment]::GetEnvironmentVariable("Path", $scope)
			if ($value) { $parts += $value -split ";" }
		}
		$parts += $env:Path -split ";"
		$managedBin = Join-Path $env:USERPROFILE ".pi\agent\bin"
		if (Test-Path $managedBin) { $parts = @($managedBin) + $parts }
		$seen = @{}
		$unique = New-Object System.Collections.Generic.List[string]
		foreach ($part in $parts) {
			if (-not $part) { continue }
			$key = $part.TrimEnd("\").ToLowerInvariant()
			if ($seen.ContainsKey($key)) { continue }
			$seen[$key] = $true
			$unique.Add($part)
		}
		$env:Path = $unique -join ";"
	}

	# Prefer pi.cmd: pi.ps1 is blocked under Restricted/AllSigned policies.
	function Get-PiCommand {
		foreach ($name in "pi.cmd", "pi.exe", "pi") {
			$command = Get-Command $name -CommandType Application, ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1
			if ($command) { return $command.Source }
		}
		return $null
	}

	# Run a native command, capturing stdout+stderr as plain strings. Windows
	# PowerShell 5.1 turns redirected native stderr into terminating errors
	# under ErrorActionPreference=Stop, so relax it for the call.
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

	# Run a native command attached to this console (live output, real TTY for
	# prompts). Output never enters the PowerShell pipeline, so it cannot leak
	# into a function's return value.
	function Invoke-Attached([string]$Exe, [string[]]$Arguments) {
		$quoted = @($Arguments | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } })
		$process = Start-Process -FilePath $Exe -ArgumentList $quoted -NoNewWindow -PassThru
		$null = $process.Handle # required for ExitCode with -NoNewWindow
		$process.WaitForExit()
		return $process.ExitCode
	}

	# Resolve Bash the way Pi does on native Windows (docs/windows.md).
	function Find-PiBash {
		$settingsPath = Join-Path $env:USERPROFILE ".pi\agent\settings.json"
		if (Test-Path $settingsPath) {
			try {
				$settings = Get-Content -Raw $settingsPath | ConvertFrom-Json
				if ($settings.PSObject.Properties.Name -contains "shellPath" -and $settings.shellPath) {
					if (Test-Path $settings.shellPath -PathType Leaf) { return [string]$settings.shellPath }
					return $null
				}
			} catch { }
		}
		foreach ($root in $env:ProgramFiles, ${env:ProgramFiles(x86)}) {
			if ($root) {
				$candidate = Join-Path $root "Git\bin\bash.exe"
				if (Test-Path $candidate -PathType Leaf) { return $candidate }
			}
		}
		$onPath = Get-Command bash.exe -ErrorAction SilentlyContinue | Select-Object -First 1
		if ($onPath) { return $onPath.Source }
		return $null
	}

	# Ask a yes/no question; defaults to NO without an interactive console.
	function Confirm-Install([string]$Label, [string]$Reason) {
		if (-not (Test-Interactive)) {
			Write-Warn "Non-interactive shell - skipping: $Label"
			return $false
		}
		Write-Host ""
		Write-Host $Label -ForegroundColor White
		Write-Host $Reason -ForegroundColor DarkGray
		if ($useColor) { Write-Host "$($glyph.Info) Install? [y/N] " -ForegroundColor Blue -NoNewline } else { Write-Host "$($glyph.Info) Install? [y/N] " -NoNewline }
		$answer = Read-Host
		return $answer -match '^(y|yes)$'
	}

	# --- 1. install / update Pi --------------------------------------------------
	function Install-Pi {
		Write-Section "1/5  Pi Coding Agent"
		$pi = Get-PiCommand
		if ($pi) {
			Write-Info "Pi found at $pi - updating Pi (pi update)..."
			$code = Invoke-Attached $pi @("update")
			if ($code -ne 0) { throw "pi update failed (exit $code)." }
			Write-Success "Pi Coding Agent installed/updated."
		} else {
			[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
			$installer = Join-Path ([IO.Path]::GetTempPath()) "pi-install-$PID.ps1"
			Write-Info "Downloading Pi's official installer (https://pi.dev/install.ps1)..."
			Invoke-WebRequest -Uri "https://pi.dev/install.ps1" -OutFile $installer -UseBasicParsing
			try {
				# Run in a child process: the official installer calls `exit`,
				# which would close the user's shell under `irm | iex`.
				$shell = (Get-Process -Id $PID).Path
				Write-Info "Running Pi's installer..."
				$code = Invoke-Attached $shell @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $installer)
				if ($code -ne 0) { throw "Pi's installer failed (exit $code)." }
			} finally {
				Remove-Item $installer -Force -ErrorAction SilentlyContinue
			}
			Update-SessionPath
			$pi = Get-PiCommand
			if (-not $pi) { throw "'pi' not found on PATH after install. Restart your terminal and re-run this installer." }
			Write-Success "Pi Coding Agent installed."
		}

		$bash = Find-PiBash
		if ($bash) {
			Write-Info "Pi shell: $bash"
		} else {
			Write-Warn "No Bash found for Pi's bash tool. Install Git for Windows (winget install --id Git.Git -e) or set shellPath in ~/.pi/agent/settings.json."
		}
		return $pi
	}

	# --- 2. install packages -----------------------------------------------------
	# `pi install` is idempotent; classify by its output like install.sh does.
	function Install-PiPackage([string]$Pi, [string]$Spec) {
		$label = $Spec -replace '^npm:', ''
		Write-Info "Installing $label..."
		$result = Invoke-Captured $Pi @("install", $Spec)
		$text = $result.Output -join "`n"
		if ($result.Code -eq 0 -and $text -match 'installed') {
			Write-Success $label
			return $true
		}
		Write-Err "Could not install $label."
		Write-Indented $result.Output
		return $false
	}

	# $StripPrefix is removed from the spec to build the prompt label.
	function Install-OptInList([string]$Pi, [object[]]$Entries, [string]$StripPrefix) {
		if ($Entries.Count -eq 0) {
			Write-Info "None."
			return
		}
		foreach ($entry in $Entries) {
			$spec = $entry.Spec
			$label = $spec -replace "^$([regex]::Escape($StripPrefix))", ''
			if ($WindowsUnsupported.ContainsKey($spec)) {
				Write-Warn "Not offered on Windows: $label - $($WindowsUnsupported[$spec])"
				Write-Indented @("Install anyway: pi install $spec")
				continue
			}
			$reason = $entry.Reason
			if ($WindowsCaveats.ContainsKey($spec)) { $reason = "$reason`n$($WindowsCaveats[$spec])" }
			if (Confirm-Install "Install ${label}?" $reason) {
				[void](Install-PiPackage $Pi $spec)
			} else {
				Write-Info "Skipped: $spec"
			}
		}
	}

	# --- main --------------------------------------------------------------------
	if ($useColor) { Write-Host "Pix installer" -ForegroundColor White } else { Write-Host "Pix installer" }

	$pi = Install-Pi

	# pix-core and pix-themes share one node_modules tree - install sequentially.
	Write-Section "2/5  Pix core + themes"
	$coreOk = Install-PiPackage $pi $CorePackage
	[void](Install-PiPackage $pi $ThemePackage)

	Write-Section "3/5  Recommended code intelligence"
	Install-OptInList $pi $RecommendedPackages "npm:"

	Write-Section "4/5  Optional Pix extensions"
	Install-OptInList $pi $OptInPixPackages "npm:@xynogen/"

	Write-Section "5/5  Optional community extensions"
	Install-OptInList $pi $OptInCommunityPackages "npm:"

	# Mirror pix-pretty's FFF state dir: $XDG_CACHE_HOME\pi\fff or $HOME\.cache\pi\fff.
	$homeDir = if ($env:HOME) { $env:HOME } else { $env:USERPROFILE }
	$cacheHome = if ($env:XDG_CACHE_HOME) { $env:XDG_CACHE_HOME } else { Join-Path $homeDir ".cache" }
	New-Item -ItemType Directory -Force -Path (Join-Path $cacheHome "pi\fff") | Out-Null

	Write-Section "Setup complete"
	if (-not $coreOk) { throw "pix-core did not install - Pix is not active. See the output above." }
	Write-Success "Pix is installed."
	Write-Info "Next: run 'pi'. Use '/login' to connect Claude, ChatGPT, or Copilot."
	Write-Info "If 'pi' is not found, open a new terminal so PATH changes apply."
}

# Scope isolation: under `irm | iex` everything above runs inside a script
# block, so helpers do not leak into the caller's session and failures never
# call `exit` on the caller's shell.
$__pixEncoding = $null
try { $__pixEncoding = [Console]::OutputEncoding; [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }
$__pixCode = 0
try {
	& $__pixInstaller
} catch {
	Write-Host ([string][char]0x2716) -ForegroundColor Red -NoNewline
	Write-Host " $($_.Exception.Message)"
	$__pixCode = 1
} finally {
	if ($__pixEncoding) { try { [Console]::OutputEncoding = $__pixEncoding } catch { } }
}
$global:LASTEXITCODE = $__pixCode
Remove-Variable __pixInstaller, __pixEncoding -ErrorAction SilentlyContinue
if ($PSCommandPath) { exit $__pixCode }
Remove-Variable __pixCode -ErrorAction SilentlyContinue
