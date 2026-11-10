/**
 * Bun test preload: point every home/agent-dir lookup at a throwaway folder
 * before any test module loads, so no test can read or write the real
 * `~/.pi/agent` (Windows `os.homedir()` follows USERPROFILE, not HOME).
 * Tests that set their own HOME/agent dir still override this.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "pix-test-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");

// User settings in the shell must not change test results. CI has none of these,
// so a developer machine must match it. Tests that need one set it themselves.
for (const key of [
	"NINEROUTER_URL",
	"NINEROUTER_KEY",
	"ROUTER_API_BASE",
	"ROUTER_API_KEY",
	"PRETTY_ICONS",
])
	delete process.env[key];
