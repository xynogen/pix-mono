/**
 * Plan manager overlay for `/plan` — one framed modal (pix-pretty frameModal)
 * with three views: plan list, plan detail, and delete confirm. Create and
 * edit hand off to the model through the prompt bar.
 * The modal only returns a decision; plan-mode.ts performs it visibly.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type KeybindingsManager,
	matchesKey,
	type SelectItem,
	SelectList,
	type TUI,
} from "@earendil-works/pi-tui";
import {
	frameModal,
	MIN_MODAL_HEIGHT,
	ModalPager,
	modalWidth,
	selectListTheme,
	terminalModalHeight,
} from "@xynogen/pix-pretty/modal-frame";
import type { Plan } from "./plan-mode.ts";

export type PlanModalResult =
	| { kind: "execute"; plan: Plan }
	| { kind: "delete"; plan: Plan }
	| { kind: "edit"; plan: Plan }
	| { kind: "new" }
	| { kind: "toggle" };

const LIST_ROWS = 10;
const relativeTime = new Intl.RelativeTimeFormat("en", { numeric: "always" });

export function planAge(updated_at: number | undefined, now = Date.now()): string {
	if (updated_at === undefined || !Number.isFinite(updated_at)) return "";
	const seconds = Math.max(0, Math.floor((now - updated_at) / 1000));
	if (seconds < 60) return "just now";
	if (seconds < 3600) return relativeTime.format(-Math.floor(seconds / 60), "minute");
	if (seconds < 86400) return relativeTime.format(-Math.floor(seconds / 3600), "hour");
	return relativeTime.format(-Math.floor(seconds / 86400), "day");
}

type View = "list" | "plan" | "confirm";

export class PlanModal {
	private view: View = "list";
	private plan: Plan | undefined;
	private readonly pager = new ModalPager();
	private readonly list: SelectList;
	private actions: SelectList | undefined;

	constructor(
		private readonly plans: Plan[],
		private readonly planDir: string,
		private readonly planMode: boolean,
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly kb: KeybindingsManager,
		private readonly done: (result: PlanModalResult | undefined) => void,
	) {
		const items: SelectItem[] = [
			{
				value: "new",
				label: "+ New plan",
				description: "Plan mode on + plan guide in the prompt bar",
			},
			...plans.map((p, i) => ({
				value: String(i),
				label: p.title,
				description: [
					p.updated_at === undefined ? "" : `Updated ${planAge(p.updated_at)}`,
					p.description,
				]
					.filter(Boolean)
					.join(" · "),
			})),
		];
		this.list = new SelectList(items, LIST_ROWS, selectListTheme(theme));
		this.list.onSelect = (item) => {
			const plan = plans[Number(item.value)];
			if (item.value === "new") done({ kind: "new" });
			else if (plan) this.openPlan(plan);
		};
		this.list.onCancel = () => done(undefined);
	}

	private selectedPlan(): Plan | undefined {
		return this.plans[Number(this.list.getSelectedItem()?.value)];
	}

	private edit(plan: Plan): void {
		this.done({ kind: "edit", plan });
	}

	private go(view: View): void {
		this.view = view;
		this.pager.reset();
	}

	private actionList(
		items: string[],
		onSelect: (value: string) => void,
		onCancel: () => void,
	): SelectList {
		const list = new SelectList(
			items.map((v) => ({ value: v, label: v })),
			items.length,
			selectListTheme(this.theme),
		);
		list.onSelect = (item) => onSelect(item.value);
		list.onCancel = onCancel;
		return list;
	}

	private openPlan(plan: Plan): void {
		this.plan = plan;
		this.actions = this.actionList(
			["Execute", "Edit", "Delete", "Back"],
			(v) => {
				if (v === "Execute") this.done({ kind: "execute", plan });
				else if (v === "Edit") this.edit(plan);
				else if (v === "Delete") this.confirmDelete(plan);
				else this.go("list");
			},
			() => this.go("list"),
		);
		this.go("plan");
	}

	private confirmDelete(plan: Plan): void {
		this.plan = plan;
		this.actions = this.actionList(
			["Delete", "Cancel"],
			(v) => (v === "Delete" ? this.done({ kind: "delete", plan }) : this.openPlan(plan)),
			() => this.openPlan(plan),
		);
		this.go("confirm");
	}

	handleInput(data: string): void {
		if (this.view === "list") this.handleListInput(data);
		else if (!this.pager.handleInput(data, this.kb, true)) this.actions?.handleInput(data);
		this.tui.requestRender();
	}

	private handleListInput(data: string): void {
		const plan = this.selectedPlan();
		if (matchesKey(data, "t")) this.done({ kind: "toggle" });
		else if (plan && matchesKey(data, "d")) this.confirmDelete(plan);
		else if (plan && matchesKey(data, "e")) this.edit(plan);
		else this.list.handleInput(data);
	}

	render(width: number): string[] {
		const t = this.theme;
		const mw = modalWidth(width);
		const inner = mw - 4;
		const title = (s: string) => t.fg("accent", t.bold(s));
		const hint = (s: string) => t.fg("muted", s);
		const rule = t.fg("muted", "─".repeat(inner));
		let header: string[];
		let body: string[];
		let footer: string[];

		if (this.view === "list") {
			header = [
				title("Plans"),
				hint(
					`${this.plans.length} saved · ${this.planDir} · plan mode ${this.planMode ? "on" : "off"}`,
				),
			];
			body = this.list.render(inner);
			footer = [
				rule,
				hint("↑↓ choose • enter open • e edit • d delete • t toggle mode • esc close"),
			];
		} else {
			const plan = this.plan as Plan;
			const confirm = this.view === "confirm";
			header = [
				confirm ? t.fg("warning", t.bold(`Delete ${plan.file}?`)) : title(plan.title),
				...(plan.description ? [t.fg("dim", plan.description)] : []),
				hint(`${this.planDir}/${plan.file}`),
				...(plan.updated_at === undefined ? [] : [hint(`Updated ${planAge(plan.updated_at)}`)]),
			];
			body = plan.body.split("\n");
			footer = [
				rule,
				...(this.actions?.render(inner) ?? []),
				hint("↑↓ choose • ←→/PgUp/PgDn scroll • enter select • esc back"),
			];
		}

		const result = frameModal({
			width: mw,
			maxHeight: terminalModalHeight(this.tui.terminal?.rows),
			minHeight: MIN_MODAL_HEIGHT,
			header,
			body,
			footer,
			bodyOffset: this.pager.bodyOffset,
			color: (s) => t.fg("accent", s),
			bg: (s) => t.bg("customMessageBg", s),
			fg: (s) => t.fg("text", s),
			overflowLine: ({ page, totalPages }) => hint(`←→/PgUp/PgDn scroll • ${page}/${totalPages}`),
		});
		this.pager.sync(result);
		return result.lines;
	}

	invalidate(): void {}
}
