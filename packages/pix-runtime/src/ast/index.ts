/**
 * pix-runtime/ast — shared ast-grep parsing: the lazy napi loader, the file → language map,
 * and consent-gated `@ast-grep/lang-*` grammar loading. UI-free; the install prompt lives in
 * `@xynogen/pix-pretty/grammar-consent`.
 */
export {
	ALL_LANGUAGES,
	type AnyLanguage,
	isBundled,
	LANGUAGES,
	type Language,
	languageForFile,
	loadEngine,
	parse,
	parseDynamic,
	type SgEdit,
	type SgNode,
} from "./engine.ts";
export {
	type ConsentFn,
	ensureLanguage,
	type GrammarResult,
	grammarCacheDir,
	installGrammar,
	type ParseOutcome,
	packageForLanguage,
	parseWithGrammar,
} from "./grammars.ts";
