// model-pins — fast model switcher over the full catalog, with pins on top.
//
//   /m            open the picker (also Alt+M)
//   /m <text>     switch straight to the one pin containing <text>; otherwise open the picker filtered
//
// In the picker:
//   enter       switch to the highlighted model
//   tab         pin / unpin the highlighted model
//   alt+up/down move a pin up/down (the first pin is the model new sessions start on)
//   esc         cancel
//
// Pins are Pi's own `enabledModels` setting in the global settings.json, so they also drive the
// built-in /model scope, Ctrl+P cycling and the startup model. Pi reads that setting at session
// start, so pin edits show up here immediately and in pi's built-ins after a restart. Patterns this
// picker can't resolve to one exact model (globs, fuzzy ids) are preserved untouched.
// The picker reads the available catalog without making a network refresh request.

import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { fuzzyFilter, getSelectPageIndex, Input, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

const SETTINGS_PATH = join(getAgentDir(), "settings.json");
const MAX_VISIBLE = 12;
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

type AnyModel = Model<Api>;
type Pin = { key: string; pattern: string; thinking?: string };

const keyOf = (model: AnyModel) => `${model.provider}/${model.id}`;

function readSettings(): Record<string, unknown> {
	try {
		const value = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new Error("Pi settings must be a JSON object");
		}
		return value;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
}

/** Split a pattern's optional `:<thinking>` suffix off, the same way pi's --models format does. */
function splitThinking(pattern: string): { base: string; thinking?: string } {
	const i = pattern.lastIndexOf(":");
	if (i > 0 && THINKING_LEVELS.has(pattern.slice(i + 1))) return { base: pattern.slice(0, i), thinking: pattern.slice(i + 1) };
	return { base: pattern };
}

/** Resolve enabledModels patterns that name exactly one model; keep the rest verbatim for saving. */
function loadPins(models: AnyModel[]) {
	const patterns = readSettings().enabledModels;
	const pins: Pin[] = [];
	const slots: Array<unknown> = [];
	if (!Array.isArray(patterns)) return { pins, slots, originalPatterns: patterns };
	const byKey = new Map(models.map((m) => [keyOf(m), m]));
	for (const pattern of patterns) {
		if (typeof pattern !== "string") {
			slots.push(pattern);
			continue;
		}
		const { base, thinking } = splitThinking(pattern);
		let key = byKey.has(base) ? base : undefined;
		if (!key && !base.includes("/")) {
			const matches = models.filter((m) => m.id === base);
			if (matches.length === 1) key = keyOf(matches[0]);
		}
		if (key && !pins.some((p) => p.key === key)) pins.push({ key, pattern, thinking });
		slots.push(key ? undefined : pattern);
	}
	return { pins, slots, originalPatterns: patterns };
}

function savePins({ pins, slots, originalPatterns }: ReturnType<typeof loadPins>): void {
	const settings = readSettings();
	if (JSON.stringify(settings.enabledModels) !== JSON.stringify(originalPatterns)) {
		throw new Error("enabledModels changed while the picker was open; reopen it and retry");
	}
	// Keep wildcard and unresolved settings in place when editing exact pins.
	let next = 0;
	const enabledModels = slots.flatMap((slot) => {
		if (slot !== undefined) return [slot];
		return next < pins.length ? [pins[next++].pattern] : [];
	});
	enabledModels.push(...pins.slice(next).map((pin) => pin.pattern));
	if (enabledModels.length > 0) settings.enabledModels = enabledModels;
	else delete settings.enabledModels;
	const tmp = `${SETTINGS_PATH}.model-pins-${randomUUID()}.tmp`;
	try {
		writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600, flag: "wx" });
		renameSync(tmp, SETTINGS_PATH);
	} finally {
		rmSync(tmp, { force: true });
	}
}

async function switchTo(pi: ExtensionAPI, ctx: ExtensionContext, model: AnyModel, pin?: Pin): Promise<void> {
	if (!(await pi.setModel(model))) {
		ctx.ui.notify(`No credentials configured for ${model.provider} — run /login`, "error");
		return;
	}
	if (pin?.thinking) pi.setThinkingLevel(pin.thinking as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
	ctx.ui.notify(`Model: ${keyOf(model)}`, "info");
}

async function openPicker(pi: ExtensionAPI, ctx: ExtensionContext, initialQuery = ""): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/m needs interactive mode", "error");
		return;
	}
	const models = ctx.modelRegistry.getAvailable();
	const state = loadPins(models);
	const current = ctx.model ? keyOf(ctx.model) : undefined;
	const byProvider = [...models].sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
	let dirty = false;

	const picked = await ctx.ui.custom<AnyModel | undefined>((tui, theme, keybindings, done) => {
		const input = new Input();
		input.setValue(initialQuery);
		let rows: AnyModel[] = [];
		let selected = 0;
		let status = "";

		const pinIndex = (m: AnyModel) => state.pins.findIndex((p) => p.key === keyOf(m));
		const searchText = (m: AnyModel) => `${keyOf(m)} ${m.name ?? ""}`;

		const recompute = (keepKey?: string) => {
			const query = input.getValue().trim();
			const pinned = state.pins.map((p) => models.find((m) => keyOf(m) === p.key)).filter((m): m is AnyModel => !!m);
			const pinnedKeys = new Set(pinned.map(keyOf));
			if (!query) {
				rows = [...pinned, ...byProvider.filter((m) => !pinnedKeys.has(keyOf(m)))];
			} else {
				// Pins whose name contains the query go first; everything else keeps fuzzy-match order.
				const needle = query.toLowerCase();
				const boosted = pinned.filter((m) => searchText(m).toLowerCase().includes(needle));
				const boostedKeys = new Set(boosted.map(keyOf));
				rows = [...boosted, ...fuzzyFilter(models, query, searchText).filter((m) => !boostedKeys.has(keyOf(m)))];
			}
			const keepAt = keepKey ? rows.findIndex((m) => keyOf(m) === keepKey) : -1;
			selected = keepAt >= 0 ? keepAt : 0;
		};

		const togglePin = (m: AnyModel) => {
			const i = pinIndex(m);
			if (i >= 0) state.pins.splice(i, 1);
			else state.pins.push({ key: keyOf(m), pattern: keyOf(m) });
			dirty = true;
			status = i >= 0 ? `Unpinned ${keyOf(m)}` : `Pinned ${keyOf(m)}`;
			recompute(keyOf(m));
		};

		const movePin = (m: AnyModel, delta: number) => {
			const i = pinIndex(m);
			const j = i + delta;
			if (i < 0 || j < 0 || j >= state.pins.length) return;
			[state.pins[i], state.pins[j]] = [state.pins[j], state.pins[i]];
			dirty = true;
			status = `Moved ${keyOf(m)} to pin #${j + 1}`;
			recompute(keyOf(m));
		};

		recompute();

		return {
			get focused() {
				return input.focused;
			},
			set focused(value: boolean) {
				input.focused = value;
			},
			invalidate() {
				input.invalidate();
			},
			render(width: number): string[] {
				const lines: string[] = [];
				lines.push(theme.fg("border", "─".repeat(width)));
				lines.push(`${theme.fg("accent", theme.bold("Switch model"))}${theme.fg("muted", `  ${state.pins.length} pinned · ${models.length} available`)}`);
				lines.push(...input.render(width));
				const start = Math.max(0, Math.min(selected - Math.floor(MAX_VISIBLE / 2), rows.length - MAX_VISIBLE));
				for (const m of rows.slice(start, start + MAX_VISIBLE)) {
					const isSel = rows[selected] === m;
					const pinned = pinIndex(m) >= 0;
					const name = m.name && m.name !== m.id ? theme.fg("muted", ` (${m.name})`) : "";
					const tags = keyOf(m) === current ? theme.fg("success", " · current") : "";
					const row = `${isSel ? theme.fg("accent", "→ ") : "  "}${pinned ? theme.fg("warning", "★ ") : "  "}${isSel ? theme.fg("accent", m.id) : m.id}${name} ${theme.fg("dim", `[${m.provider}]`)}${tags}`;
					lines.push(row);
				}
				if (rows.length === 0) lines.push(theme.fg("muted", "  no matching models"));
				lines.push(theme.fg("dim", `  (${rows.length ? selected + 1 : 0}/${rows.length})`) + (status ? `  ${theme.fg("success", status)}` : ""));
				lines.push(theme.fg("dim", "  enter switch · tab pin/unpin · alt+↑↓ reorder pins · esc close"));
				lines.push(theme.fg("border", "─".repeat(width)));
				return lines.map((line) => truncateToWidth(line, width));
			},
			handleInput(data: string): void {
				const m = rows[selected];
				const page = getSelectPageIndex(keybindings, data, selected, rows.length, MAX_VISIBLE);
				if (matchesKey(data, "alt+up")) {
					if (m) movePin(m, -1);
				} else if (matchesKey(data, "alt+down")) {
					if (m) movePin(m, 1);
				} else if (matchesKey(data, "tab")) {
					if (m) togglePin(m);
				} else if (keybindings.matches(data, "tui.select.up")) {
					if (rows.length) selected = selected === 0 ? rows.length - 1 : selected - 1;
				} else if (keybindings.matches(data, "tui.select.down")) {
					if (rows.length) selected = selected === rows.length - 1 ? 0 : selected + 1;
				} else if (page !== undefined) {
					selected = page;
				} else if (keybindings.matches(data, "tui.select.confirm")) {
					if (m) done(m);
					return;
				} else if (keybindings.matches(data, "tui.select.cancel")) {
					done(undefined);
					return;
				} else {
					input.handleInput(data);
					status = "";
					recompute();
				}
				tui.requestRender();
			},
		};
	});

	if (dirty) {
		try {
			savePins(state);
		} catch (error) {
			ctx.ui.notify(`Could not save pins: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	}
	if (picked) await switchTo(pi, ctx, picked, state.pins.find((p) => p.key === keyOf(picked)));
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("m", {
		description: "Switch model fast — pinned models on top of the full catalog (tab pins/unpins)",
		handler: async (args, ctx) => {
			const query = args.trim();
			if (query) {
				const models = ctx.modelRegistry.getAvailable();
				const { pins } = loadPins(models);
				const needle = query.toLowerCase();
				const hits = pins.filter((p) => p.key.toLowerCase().includes(needle));
				const model = hits.length === 1 ? models.find((m) => keyOf(m) === hits[0].key) : undefined;
				if (model) return switchTo(pi, ctx, model, hits[0]);
			}
			return openPicker(pi, ctx, query);
		},
	});

	pi.registerShortcut("alt+m", {
		description: "Switch model (pinned first)",
		handler: async (ctx) => openPicker(pi, ctx),
	});
}
