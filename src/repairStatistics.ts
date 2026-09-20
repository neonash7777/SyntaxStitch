import * as vscode from 'vscode';
import type { BlockType, RepairKind, RepairPatch } from './shadowStructure';
const CONFIG_SECTION = 'syntaxstitch';
const STATISTICS_KEY = 'syntaxstitch.repairStatistics';
export type RepairSource = 'direct' | 'indirect';
export const REPAIR_KINDS: readonly RepairKind[] = ['square', 'parenthesis', 'curly', 'tag', 'quote', 'indent'];
export type RepairStatistics = { total: number; byKind: Record<RepairKind, number>; bySource?: Record<RepairSource, number>; byKindSource?: Record<RepairKind, Record<RepairSource, number>>; unclassified: number; firstAt?: string; lastAt?: string; lastUri?: string; lastRepair?: string };
type LegacyRepairStatistics = { total: number; byType?: Partial<Record<BlockType, number>>; lastAt?: string; lastUri?: string };

export class RepairCounter {
	#statistics: RepairStatistics;
	readonly #recent = new Map<string, number>();
	readonly #store: vscode.Memento;

	constructor(context: vscode.ExtensionContext) {
		this.#store = vscode.workspace.workspaceFolders?.length ? context.workspaceState : context.globalState;
		const stored = this.#store.get<RepairStatistics & LegacyRepairStatistics>(STATISTICS_KEY);
		const byKind = stored?.byKind;
		const legacySource = stored?.bySource as Record<string, number> | undefined;
		const byKindValue = { square: byKind?.square ?? 0, parenthesis: byKind?.parenthesis ?? 0, curly: byKind?.curly ?? 0, tag: byKind?.tag ?? stored?.byType?.tag ?? 0, quote: byKind?.quote ?? 0, indent: byKind?.indent ?? stored?.byType?.indent ?? 0 } satisfies Record<RepairKind, number>;
		const byKindSource = Object.fromEntries(REPAIR_KINDS.map(kind => [kind, { direct: stored?.byKindSource?.[kind]?.direct ?? 0, indirect: stored?.byKindSource?.[kind]?.indirect ?? 0 }])) as Record<RepairKind, Record<RepairSource, number>>;
		this.#statistics = { total: stored?.total ?? 0, byKind: byKindValue, bySource: { direct: legacySource?.direct ?? legacySource?.user ?? 0, indirect: legacySource?.indirect ?? legacySource?.external ?? 0 }, byKindSource, unclassified: stored?.unclassified ?? stored?.byType?.brace ?? 0, firstAt: stored?.firstAt ?? stored?.lastAt, lastAt: stored?.lastAt, lastUri: stored?.lastUri, lastRepair: stored?.lastRepair };
	}

	get statistics(): Readonly<RepairStatistics> { return this.#statistics; }

	async record(patches: readonly RepairPatch[], uri: vscode.Uri, lastRepair: string, source: RepairSource): Promise<number> {
		const now = Date.now(), cooldown = vscode.workspace.getConfiguration(CONFIG_SECTION, uri).get('repairCountCooldownMs', 5000);
		const counted = patches.filter(patch => {
			const key = `${uri}:${patch.pairId}:${patch.side}`, previous = this.#recent.get(key) ?? 0;
			this.#recent.set(key, now);
			return now - previous >= cooldown;
		});
		if (!counted.length) { return 0; }
		const byKind = { ...this.#statistics.byKind };
		const bySource = { direct: 0, indirect: 0, ...this.#statistics.bySource };
		const byKindSource = Object.fromEntries(REPAIR_KINDS.map(kind => [kind, { direct: 0, indirect: 0, ...this.#statistics.byKindSource?.[kind] }])) as Record<RepairKind, Record<RepairSource, number>>;
		for (const patch of counted) { byKind[patch.kind]++; }
		bySource[source] += counted.length;
		for (const patch of counted) { byKindSource[patch.kind][source]++; }
		const firstAt = this.#statistics.firstAt ?? new Date().toISOString(), lastAt = new Date().toISOString();
		this.#statistics = { ...this.#statistics, total: this.#statistics.total + counted.length, byKind, bySource, byKindSource, firstAt, lastAt, lastUri: uri.toString(), lastRepair };
		await this.#store.update(STATISTICS_KEY, this.#statistics);
		return counted.length;
	}

	async reset(): Promise<void> { this.#recent.clear(); this.#statistics = { total: 0, byKind: { square: 0, parenthesis: 0, curly: 0, tag: 0, quote: 0, indent: 0 }, bySource: { direct: 0, indirect: 0 }, byKindSource: Object.fromEntries(REPAIR_KINDS.map(kind => [kind, { direct: 0, indirect: 0 }])) as Record<RepairKind, Record<RepairSource, number>>, unclassified: 0 }; await this.#store.update(STATISTICS_KEY, this.#statistics); }
}

