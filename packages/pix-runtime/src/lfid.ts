/**
 * LFID — LLM-friendly IDs (`agent-happy-walrus-42`).
 *
 * Raw UUID fragments (`3f2a1b9c-4d5e`, `abc123`) waste parent-model tokens and
 * invite typos when the model must type them back (steer/stop/resume). An LFID
 * is `[prefix]-[adjective]-[noun]-[NN]`: pronounceable, copyable, and
 * self-evidently an ID in a transcript. Two random words + two digits give
 * 100×100×100 = 1M combinations per prefix — plenty for a live agent set, and
 * the owning registry (e.g. pix-subagent's AgentManager) maps LFID → record.
 *
 * `ponytail:` 2-digit suffix caps the namespace at 1M per prefix. If live sets
 * ever approach that, widen the suffix or add a third word here.
 */

import { randomInt } from "node:crypto";

/** `agent-<adj>-<noun>-<NN>` shape. Prefix is caller-owned (`agent`, `job`, …). */
export const LFID_RE = /^[a-z][a-z0-9]*-[a-z]+-[a-z]+-\d{2}$/;

// Small curated lists: common words, no ambiguous pairs, no profanity.
// Sized at 100 × 100 so two digits complete a 1M namespace per prefix.
const ADJECTIVES = (
	"agate amber azure birch bold brave bright brisk calm cedar cinder clever cloudy coral crisp dawn drift dusk eager elm " +
	"ember fair fern fleet flint fresh frost garnet glad golden grand green grove happy hazy heath iris ivory jade juniper " +
	"keen kind lagoon larch light linden lively lotus lucid lunar maple meadow merry misty moss nectar nimble nimbus noble north " +
	"ocean olive opal pearl pine plain plum proud quartz quick quiet rapid reef ridge river rocky round royal rusty sable " +
	"sage sandy sedge sharp shiny silent silver sleek small smart smooth solid sorrel spring steady stone sunny swift tango teal"
).split(" ");

const NOUNS = (
	"adder albatross anchovy badger beagle bear beaver boar bobcat cobra condor cougar coyote crane cricket deer dove drake duck eagle " +
	"falcon ferret finch fisher fox frog gannet gazelle gecko goose gopher grouse gull hamster hare hawk heron hyena ibis impala " +
	"indigo jackal jaguar jay kelp kestrel koala kudu lark lemur llama lynx magpie manatee marmot marten meerkat mink mole mongoose " +
	"moose narwhal newt numbats ocelot okapi oriole osprey otter owl ox oyster panda pangolin parrot pelican penguin pigeon pika platypus " +
	"porpoise possum puffin python quail quokka rabbit raven rhea robin sable salmon saola seal shark shrew skunk sloth snail sparrow"
).split(" ");

export interface LfidOptions {
	/** Namespace prefix, e.g. `"agent"`. Defaults to `"agent"`. */
	prefix?: string;
	/** RNG override for tests/determinism. Must return an int in [0, max). */
	rand?: (max: number) => number;
}

/** Generate one LFID, e.g. `agent-happy-walrus-42`. */
export function generateLfid(opts: LfidOptions = {}): string {
	const prefix = opts.prefix ?? "agent";
	const rand = opts.rand ?? randomInt;
	const pick = (xs: string[]): string => xs[rand(xs.length)] as string;
	const n = String(rand(100)).padStart(2, "0");
	return `${prefix}-${pick(ADJECTIVES)}-${pick(NOUNS)}-${n}`;
}

/** Loose check: is this string LFID-shaped (any prefix)? */
export function isLfid(s: string): boolean {
	return LFID_RE.test(s);
}

/** Parse an LFID into its parts; undefined when the shape doesn't match. */
export function parseLfid(
	s: string,
): { prefix: string; adjective: string; noun: string; num: string } | undefined {
	const m = LFID_RE.exec(s);
	if (!m) return undefined;
	const [prefix, adjective, noun, num] = s.split("-");
	return {
		prefix: prefix as string,
		adjective: adjective as string,
		noun: noun as string,
		num: num as string,
	};
}

/**
 * Generate an LFID not already present in `taken`. Retries a bounded number of
 * times, then throws — a full or near-full namespace is a caller bug, not a
 * loop-candidate. Collisions across live sets are essentially impossible long
 * before this bound (1M combinations), so 64 tries is generous.
 */
export function uniqueLfid(taken: (id: string) => boolean, opts: LfidOptions = {}): string {
	for (let i = 0; i < 64; i++) {
		const id = generateLfid(opts);
		if (!taken(id)) return id;
	}
	throw new Error("lfid: namespace exhausted (too many live IDs for prefix)");
}
