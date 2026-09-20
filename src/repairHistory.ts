import * as vscode from 'vscode';
import type { RepairPatch, TokenPair } from './shadowStructure';

const reasons: Record<string, string> = {
	'remove-empty-pair': 'The pair contains only whitespace, so both boundaries can be removed together.',
	'remove-orphan': 'The surviving boundary no longer has a matching partner.',
	'remove-tag-counterpart': 'Deleting a complete tag unwraps its contents and removes the other tag.',
	'unwrap-grouping': 'Deleting standalone grouping parentheses preserves the inner expression.',
	'compact-closer': 'The required closing boundary is preserved while removing one trailing line break.',
	'restore-opener': 'The surviving closing boundary still owns content.',
	'restore-closer': 'The surviving opening boundary still owns content.',
	'restore-partial-tag': 'A partially deleted tag would leave its partner unmatched.',
	'remove-unmatched-closer': 'The edit introduced a closing boundary without a matching opener.',
	'align-closing-indent': 'The closing boundary should align with its opening line.',
	'unwrap-selected-tag': 'Removing a complete tag unwraps its content.',
	'remove-provider-duplicate-tag': 'A provider inserted a duplicate closing tag.'
};
export type RecentRepair = { uri: vscode.Uri; line: number; time: string; action: string; reason: string; version: number };

/** Session-only metadata: never retain source snippets or write history to disk. */
export class RepairHistory {
	readonly entries: RecentRepair[] = [];

	record(document: vscode.TextDocument, patches: readonly RepairPatch[], pairs: readonly TokenPair[]): void {
		for (const patch of patches) {
			const owner = pairs.find(pair => pair.id === patch.pairId);
			const action = patch.kind === 'indent' ? 'Adjusted indentation' : `${patch.text ? (patch.deleteLength ? 'Replaced' : 'Restored') : 'Removed'} ${patch.kind} boundary`;
			this.entries.unshift({ uri: document.uri, line: document.positionAt(patch.offset).line, version: document.version, time: new Date().toLocaleTimeString(), action: `${action} · ${owner?.languageId ?? document.languageId}`, reason: reasons[patch.rule] ?? `Applied structural rule: ${patch.rule.replace(/-/g, ' ')}.` });
		}
		this.entries.splice(100);
	}

	clear(): void { this.entries.length = 0; }

	async show(): Promise<void> {
		if (!this.entries.length) { void vscode.window.showInformationMessage('No repairs recorded in this session.'); return; }
		const selected = await vscode.window.showQuickPick(this.entries.map(entry => ({ label: entry.action, description: `${vscode.workspace.asRelativePath(entry.uri)}:${entry.line + 1} · ${entry.time}`, detail: entry.reason, entry })), { title: 'Recent Repairs', placeHolder: 'Choose a repair to visit its recorded line (locations may shift after edits)', matchOnDescription: true, matchOnDetail: true });
		if (!selected) { return; }
		try {
			const editor = await vscode.window.showTextDocument(selected.entry.uri);
			const position = new vscode.Position(Math.min(selected.entry.line, editor.document.lineCount - 1), 0);
			editor.selection = new vscode.Selection(position, position);
			editor.revealRange(editor.selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
		} catch { void vscode.window.showInformationMessage('The repaired document is no longer available.'); }
	}
}
