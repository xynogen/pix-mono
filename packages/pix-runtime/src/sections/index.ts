export { type CollapseConfig, collapseSection } from "./collapse.ts";
export {
	type GateConfig,
	type GateRuleConfig,
	type GateSeverity,
	gateSection,
} from "./gate.ts";
export { type IoConfig, ioSection } from "./io.ts";
export {
	type CavemanLevel,
	type OptimizerConfig,
	optimizerSection,
	type PonytailLevel,
	type Toggle,
} from "./optimizer.ts";
export {
	type DiffConfig,
	type IconMode,
	type LsStyle,
	type PrettyConfig,
	prettySection,
} from "./pretty.ts";

import { collapseSection } from "./collapse.ts";
import { gateSection } from "./gate.ts";
import { ioSection } from "./io.ts";
import { optimizerSection } from "./optimizer.ts";
import { prettySection } from "./pretty.ts";

/** All built-in sections, in stable registration order. */
export const builtinSections = [
	collapseSection,
	prettySection,
	ioSection,
	optimizerSection,
	gateSection,
] as const;
