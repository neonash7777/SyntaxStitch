import * as vscode from 'vscode';
import { ShadowStructure, type BlockType, type RepairKind, type RepairPatch, type TokenPair } from './shadowStructure';

// region State
type DocumentState = { shadow: ShadowStructure; languageId: string };
export type RepairStatistics = { total: number; byKind: Record<RepairKind, number>; unclassified: number; lastAt?: string; lastUri?: string };
type LegacyRepairStatistics = { total: number; byType?: Partial<Record<BlockType, number>>; lastAt?: string; lastUri?: string };
const states = new Map<string, DocumentState>();
const repairing = new Set<string>();
const OUTPUT_NAME = 'SyntaxStitch';
const CONFIG_SECTION = 'syntaxstitch';
const STATISTICS_KEY = 'syntaxstitch.repairStatistics';
const BYTES_PER_KIBIBYTE = 1024;
type LogLevel = 'off' | 'repairs' | 'verbose';
type PairLabelMode = 'off' | 'active' | 'all';
type SelectionSnapshot = { anchor: number; active: number }[];
type SelectionTransition = { version: number; from: SelectionSnapshot; to: SelectionSnapshot };
const selectionHistory = new WeakMap<vscode.TextEditor, SelectionTransition[]>();
type DirectDeletion = { editor: vscode.TextEditor; direction: 'left' | 'right'; offset: number; completed: Promise<void>; complete: () => void; selection?: vscode.Selection };
const directDeletions = new Map<string, DirectDeletion>();
const pendingTagCarets = new WeakMap<vscode.TextEditor, { afterOpen: number; afterClose: number; version: number; expiresAt: number }>();
type PendingTagRename = { tokenStart: number; counterpartNameStart: number; counterpartNameLength: number };
const pendingTagRenames = new Map<string, PendingTagRename>();

const snapshotSelections = (editor: vscode.TextEditor): SelectionSnapshot => editor.selections.map(selection => ({ anchor: editor.document.offsetAt(selection.anchor), active: editor.document.offsetAt(selection.active) }));
const selectionsMatch = (left: SelectionSnapshot, right: SelectionSnapshot): boolean => left.length === right.length && left.every((selection, index) => selection.anchor === right[index].anchor && selection.active === right[index].active);
const restoreSelections = (editor: vscode.TextEditor, snapshot: SelectionSnapshot): void => { editor.selections = snapshot.map(selection => new vscode.Selection(editor.document.positionAt(selection.anchor), editor.document.positionAt(selection.active))); };

class RepairCounter {
	#statistics: RepairStatistics;
	readonly #recent = new Map<string, number>();
	readonly #store: vscode.Memento;

	constructor(context: vscode.ExtensionContext) {
		this.#store = vscode.workspace.workspaceFolders?.length ? context.workspaceState : context.globalState;
		const stored = this.#store.get<RepairStatistics & LegacyRepairStatistics>(STATISTICS_KEY);
		const byKind = stored?.byKind;
		this.#statistics = { total: stored?.total ?? 0, byKind: { square: byKind?.square ?? 0, parenthesis: byKind?.parenthesis ?? 0, curly: byKind?.curly ?? 0, tag: byKind?.tag ?? stored?.byType?.tag ?? 0, quote: byKind?.quote ?? 0, indent: byKind?.indent ?? stored?.byType?.indent ?? 0 }, unclassified: stored?.unclassified ?? stored?.byType?.brace ?? 0, lastAt: stored?.lastAt, lastUri: stored?.lastUri };
	}

	get statistics(): Readonly<RepairStatistics> { return this.#statistics; }

	async record(patches: readonly RepairPatch[], uri: vscode.Uri): Promise<number> {
		const now = Date.now(), cooldown = vscode.workspace.getConfiguration(CONFIG_SECTION, uri).get('repairCountCooldownMs', 5000);
		const counted = patches.filter(patch => {
			const key = `${uri}:${patch.pairId}:${patch.side}`, previous = this.#recent.get(key) ?? 0;
			this.#recent.set(key, now);
			return now - previous >= cooldown;
		});
		if (!counted.length) { return 0; }
		const byKind = { ...this.#statistics.byKind };
		for (const patch of counted) { byKind[patch.kind]++; }
		this.#statistics = { ...this.#statistics, total: this.#statistics.total + counted.length, byKind, lastAt: new Date().toISOString(), lastUri: uri.toString() };
		await this.#store.update(STATISTICS_KEY, this.#statistics);
		return counted.length;
	}

	async reset(): Promise<void> { this.#recent.clear(); this.#statistics = { total: 0, byKind: { square: 0, parenthesis: 0, curly: 0, tag: 0, quote: 0, indent: 0 }, unclassified: 0 }; await this.#store.update(STATISTICS_KEY, this.#statistics); }
}

const keyOf = (document: vscode.TextDocument): string => document.uri.toString();
const tagNameRange = (token: string, tokenStart: number): { start: number; end: number } | undefined => {
	const match = token.match(/^<\s*\/?\s*([A-Za-z][\w:.-]*)/), name = match?.[1];
	if (!match || !name) { return undefined; }
	const start = tokenStart + match[0].lastIndexOf(name);
	return { start, end: start + name.length };
};
const tagNameAt = (text: string, tokenStart: number): { name: string; start: number; end: number } | undefined => {
	const match = text.slice(tokenStart, tokenStart + 128).match(/^<\s*\/?\s*([A-Za-z][\w:.-]*)[^<>]*>/), name = match?.[1];
	if (!match || !name) { return undefined; }
	const start = tokenStart + match[0].indexOf(name);
	return { name, start, end: start + name.length };
};
const enabledSetting = (uri?: vscode.Uri): boolean => vscode.workspace.getConfiguration(CONFIG_SECTION, uri).get('enabled', true);
const isEnabled = (document: vscode.TextDocument): boolean => {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION, document.uri), languages = config.get<string[]>('languages', []);
	const withinLimit = Buffer.byteLength(document.getText(), 'utf8') <= config.get('maxFileSizeKB', 2048) * BYTES_PER_KIBIBYTE;
	return enabledSetting(document.uri) && withinLimit && ['file', 'untitled', 'vscode-notebook-cell'].includes(document.uri.scheme) && (!languages.length || languages.includes(document.languageId));
};
const index = (document: vscode.TextDocument): void => {
	const key = keyOf(document), current = states.get(key);
	if (current?.languageId === document.languageId) { current.shadow.reindex(document.getText(), document.languageId); return; }
	states.set(key, { shadow: new ShadowStructure(document.getText(), document.languageId), languageId: document.languageId });
};
const patchRange = (document: vscode.TextDocument, patch: RepairPatch): vscode.Range => {
	const start = Math.min(patch.offset, document.getText().length), end = Math.min(start + patch.deleteLength, document.getText().length);
	return new vscode.Range(document.positionAt(start), document.positionAt(end));
};
const changedLines = (document: vscode.TextDocument, changes: readonly vscode.TextDocumentContentChangeEvent[]): Set<number> => {
	const lines = new Set<number>(), length = document.getText().length;
	for (const change of changes) {
		const start = document.positionAt(Math.min(change.rangeOffset, length)).line, end = document.positionAt(Math.min(change.rangeOffset + change.text.length, length)).line;
		for (let line = start; line <= end; line++) { lines.add(line); }
	}
	return lines;
};
const planClosingIndentRepairs = (document: vscode.TextDocument, changes: readonly vscode.TextDocumentContentChangeEvent[]): RepairPatch[] => {
	if (!vscode.workspace.getConfiguration(CONFIG_SECTION, document.uri).get('fixClosingIndentation', true)) { return []; }
	const text = document.getText(), touched = changedLines(document, changes), shadow = new ShadowStructure(text, document.languageId);
	return shadow.pairs.flatMap(pair => {
		if (pair.type !== 'brace') { return []; }
		const open = document.positionAt(pair.openIdx), close = document.positionAt(pair.closeIdx);
		if (!touched.has(close.line) || open.line === close.line) { return []; }
		const actual = document.lineAt(close.line).text.slice(0, close.character);
		if (actual.trim()) { return []; }
		const expected = document.lineAt(open.line).text.match(/^[\t ]*/)?.[0] ?? '';
		return actual === expected ? [] : [{ offset: document.offsetAt(new vscode.Position(close.line, 0)), deleteLength: actual.length, text: expected, pairId: pair.id, side: 'close' as const, blockType: 'indent' as const, kind: 'indent' as const }];
	});
};
export const repairStatusPresentation = (statistics: Readonly<RepairStatistics>, enabled: boolean): { text: string; tooltip: string; accessibilityLabel: string } => {
	const state = enabled ? 'enabled' : 'disabled', { total, byKind, unclassified } = statistics;
	const details = [`()  Parentheses: ${byKind.parenthesis}`, `[]  Square brackets: ${byKind.square}`, `{}  Curly braces: ${byKind.curly}`, `<>  Tags: ${byKind.tag}`, `""  Quotes: ${byKind.quote}`, `\\t  Indentation: ${byKind.indent}`];
	if (unclassified) { details.push(`?  Legacy unclassified: ${unclassified}`); }
	return { text: `{S} ${total}`, tooltip: `SyntaxStitch is ${state}.\n\n${total} repairs\n${details.join('\n')}\n\nClick for actions.`, accessibilityLabel: `SyntaxStitch is ${state} with ${total} repairs. Activate for actions.` };
};
const refreshStatus = (status: vscode.StatusBarItem, counter: RepairCounter): void => {
	const presentation = repairStatusPresentation(counter.statistics, enabledSetting(vscode.window.activeTextEditor?.document.uri));
	status.text = presentation.text;
	status.tooltip = presentation.tooltip;
	status.accessibilityInformation = { label: presentation.accessibilityLabel };
};
const log = (output: vscode.OutputChannel, uri: vscode.Uri | undefined, level: Exclude<LogLevel, 'off'>, record: object): void => {
	const configured = vscode.workspace.getConfiguration(CONFIG_SECTION, uri).get<LogLevel>('logLevel', 'repairs');
	if (configured === 'verbose' || configured === level) { output.appendLine(JSON.stringify(record)); }
};
// endregion

// region Pair Labels
const declarationAt = (document: vscode.TextDocument, pair: { openIdx: number; type: BlockType }): string => {
	const text = document.getText();
	if (pair.type === 'tag') { const end = text.indexOf('>', pair.openIdx); return text.slice(pair.openIdx, end < 0 ? pair.openIdx + 1 : end + 1); }
	const position = document.positionAt(pair.openIdx), line = document.lineAt(position.line).text.slice(0, position.character).trim();
	if (line) { return line; }
	for (let lineNumber = position.line - 1; lineNumber >= 0; lineNumber--) {
		const candidate = document.lineAt(lineNumber).text.trim();
		if (candidate) { return candidate; }
	}
	return 'block';
};
const declarationStart = (document: vscode.TextDocument, pair: { openIdx: number; type: BlockType }): vscode.Position => {
	const open = document.positionAt(pair.openIdx);
	if (pair.type === 'tag' || document.lineAt(open.line).text.slice(0, open.character).trim()) { return new vscode.Position(open.line, document.lineAt(open.line).firstNonWhitespaceCharacterIndex); }
	for (let line = open.line - 1; line >= 0; line--) {
		if (document.lineAt(line).text.trim()) { return new vscode.Position(line, document.lineAt(line).firstNonWhitespaceCharacterIndex); }
	}
	return open;
};
const labelPosition = (document: vscode.TextDocument, pair: { closeIdx: number; type: BlockType }): vscode.Position | undefined => {
	if (pair.type === 'indent' || pair.type === 'quote') { return undefined; }
	const text = document.getText(), tokenLength = pair.type === 'tag' ? Math.max(1, text.indexOf('>', pair.closeIdx) - pair.closeIdx + 1) : 1;
	return document.positionAt(Math.min(pair.closeIdx + tokenLength, text.length));
};
const isMultilineBoundary = (document: vscode.TextDocument, pair: { openIdx: number; closeIdx: number }): boolean => {
	const open = document.positionAt(pair.openIdx), close = document.positionAt(pair.closeIdx);
	return open.line < close.line;
};
type PairLabelTarget = { uri: string; pairId: string; openIdx: number; closeIdx: number };
const pairLabelTarget = (document: vscode.TextDocument, pair: { id: string; openIdx: number; closeIdx: number }): PairLabelTarget => ({ uri: document.uri.toString(), pairId: pair.id, openIdx: pair.openIdx, closeIdx: pair.closeIdx });
const pairCommandLink = (title: string, command: string, target: PairLabelTarget): string => `[${title}](command:${command}?${encodeURIComponent(JSON.stringify([target]))})`;
const pairActionLink = (title: string, icon: string, command: string, target: PairLabelTarget): string => `\$(${icon}) [${title}](command:${command}?${encodeURIComponent(JSON.stringify([target]))})`;
const compactDeclaration = (declaration: string, maximumLength: number): string => {
	if (declaration.length <= maximumLength) { return declaration; }
	const tag = declaration.match(/^<\/?([\w.-]+)/), named = declaration.match(/\b(class|interface|enum|struct|function|def)\s+([\w$]+)/), callable = declaration.match(/([\w$]+)$/) ?? declaration.match(/([\w$]+)\s*\([^()]*\)\s*$/);
	for (const candidate of [tag && `<${tag[1]}>`, named && `${named[1]} ${named[2]}`, callable && `${callable[1]}()`, 'block']) {
		if (candidate && candidate.length <= maximumLength) { return candidate; }
	}
	return '';
};
const pairActions = (target: PairLabelTarget, declaration: string, startLine: number, endLine: number, lineCount: number): vscode.MarkdownString => {
	const actions = new vscode.MarkdownString('', true), commands = ['syntaxstitch.togglePairFold', 'syntaxstitch.foldPairContents', 'syntaxstitch.selectPairContents', 'syntaxstitch.selectPairWithDeclaration', 'syntaxstitch.selectPairLabel', 'syntaxstitch.selectPairLabelLines'];
	actions.isTrusted = { enabledCommands: commands };
	actions.supportThemeIcons = true;
	actions.appendMarkdown(`**SyntaxStitch · lines ${startLine}–${endLine} · ${lineCount} ${lineCount === 1 ? 'line' : 'lines'}**\n\n`);
	actions.appendText(declaration).appendMarkdown('\n\n');
	actions.appendMarkdown(`${pairActionLink('Fold / unfold', 'fold', commands[0], target)}  \n${pairActionLink('Fold / unfold contents', 'fold-down', commands[1], target)}  \n↔ ${pairCommandLink('Select inner content', commands[2], target)}  \n${pairActionLink('Select declaration + block', 'symbol-method', commands[3], target)}  \n${pairActionLink('Select delimiters + content', 'symbol-array', commands[4], target)}  \n${pairActionLink('Select complete block lines', 'list-selection', commands[5], target)}`);
	return actions;
};
const pairLabelHints = (document: vscode.TextDocument, range: vscode.Range): vscode.InlayHint[] => {
	if (!isEnabled(document)) { return []; }
	const mode = vscode.workspace.getConfiguration(CONFIG_SECTION, document.uri).get<PairLabelMode>('pairLabels', 'all');
	if (mode === 'off') { return []; }
	const editor = vscode.window.visibleTextEditors.find(candidate => candidate.document === document), cursor = editor ? document.offsetAt(editor.selection.active) : -1;
	const pairs = (states.get(keyOf(document))?.shadow.pairs ?? []).filter(pair => pair.type !== 'quote' && pair.type !== 'indent');
	const visible = mode === 'all' ? pairs.filter(pair => isMultilineBoundary(document, pair)) : pairs.filter(pair => pair.openIdx <= cursor && cursor <= pair.closeIdx).sort((left, right) => left.closeIdx - left.openIdx - (right.closeIdx - right.openIdx)).slice(0, 1);
	return visible.flatMap(pair => {
		const position = labelPosition(document, pair);
		if (!position || !range.contains(position)) { return []; }
		const open = document.positionAt(pair.openIdx), close = document.positionAt(pair.closeIdx), startLine = open.line + 1, endLine = close.line + 1, lineCount = endLine - startLine + 1, target = pairLabelTarget(document, pair), declaration = declarationAt(document, pair);
		const countLabel = `${lineCount} ${lineCount === 1 ? 'Line' : 'Lines'}`, controlsLabel = ` L${startLine}↔L${endLine} ${countLabel}`, maximumLength = vscode.workspace.getConfiguration('editor', document.uri).get<number>('inlayHints.maximumLength', 43), ownerBudget = maximumLength > 0 ? Math.max(0, maximumLength - controlsLabel.length) : declaration.length;
		const owner = new vscode.InlayHintLabelPart(compactDeclaration(declaration, ownerBudget)), separator = (): vscode.InlayHintLabelPart => new vscode.InlayHintLabelPart(' '), start = new vscode.InlayHintLabelPart(`L${startLine}`), contents = new vscode.InlayHintLabelPart('↔'), end = new vscode.InlayHintLabelPart(`L${endLine}`), lineRange = new vscode.InlayHintLabelPart(countLabel), actionMenu = pairActions(target, declaration, startLine, endLine, lineCount);
		owner.tooltip = actionMenu;
		owner.command = { command: 'syntaxstitch.selectPairWithDeclaration', title: 'Select declaration and block', arguments: [target] };
		start.tooltip = `Select all of line ${startLine}`;
		start.command = { command: 'syntaxstitch.selectPairStartLine', title: `Select line ${startLine}`, arguments: [target] };
		contents.tooltip = 'Select content between the pair';
		contents.command = { command: 'syntaxstitch.selectPairContents', title: 'Select inner content', arguments: [target] };
		end.tooltip = `Select all of line ${endLine}`;
		end.command = { command: 'syntaxstitch.selectPairEndLine', title: `Select line ${endLine}`, arguments: [target] };
		lineRange.tooltip = `Select complete lines ${startLine} through ${endLine}`;
		lineRange.command = { command: 'syntaxstitch.selectPairLabelLines', title: 'Select complete block lines', arguments: [target] };
		const hint = new vscode.InlayHint(position, [owner, separator(), start, contents, end, separator(), lineRange]);
		hint.paddingLeft = true;
		return [hint];
	});
};
const tagTokenEnd = (text: string, start: number): number => {
	let quote = '';
	for (let idx = start; idx < text.length; idx++) {
		const char = text[idx];
		if (quote) { if (char === quote) { quote = ''; } continue; }
		if (char === '"' || char === "'") { quote = char; continue; }
		if (char === '>') { return idx + 1; }
	}
	return start;
};
const placePendingTagCaret = (editor: vscode.TextEditor): void => {
	const pending = pendingTagCarets.get(editor);
	if (!pending) { return; }
	if (editor.document.version !== pending.version || Date.now() > pending.expiresAt || !editor.selection.isEmpty) { pendingTagCarets.delete(editor); return; }
	if (editor.document.offsetAt(editor.selection.active) !== pending.afterClose) { return; }
	pendingTagCarets.delete(editor);
	const inside = editor.document.positionAt(pending.afterOpen);
	editor.selection = new vscode.Selection(inside, inside);
};
const captureTagCaret = (event: vscode.TextDocumentChangeEvent): void => {
	const editor = vscode.window.activeTextEditor, state = states.get(keyOf(event.document));
	if (!editor || editor.document !== event.document || event.contentChanges.length !== 1 || event.contentChanges[0].rangeLength) { return; }
	const text = event.document.getText(), change = event.contentChanges[0], insertedEnd = change.rangeOffset + change.text.length;
	const candidate = state?.shadow.pairs.find(pair => pair.type === 'tag' && pair.openIdx <= insertedEnd && pair.closeIdx >= change.rangeOffset && pair.closeIdx <= insertedEnd && tagTokenEnd(text, pair.openIdx) === pair.closeIdx);
	if (!candidate) { return; }
	pendingTagCarets.set(editor, { afterOpen: candidate.closeIdx, afterClose: tagTokenEnd(text, candidate.closeIdx), version: event.document.version, expiresAt: Date.now() + 500 });
	placePendingTagCaret(editor);
	setTimeout(() => placePendingTagCaret(editor), 0);
};
// endregion

// region Reconciliation
type ProtectedCloserIntent = { deletion: DirectDeletion; pairId: string; blockType: BlockType; stepInside: boolean };
const protectedCloserIntent = (event: vscode.TextDocumentChangeEvent, patches: readonly RepairPatch[]): ProtectedCloserIntent | undefined => {
	const change = event.contentChanges[0], deletion = directDeletions.get(keyOf(event.document)), editor = deletion?.editor;
	if (!editor || !deletion || editor.document !== event.document || event.contentChanges.length !== 1 || !change || change.text || change.rangeLength !== 1) { return undefined; }
	const expectedOffset = deletion.direction === 'left' ? change.rangeOffset + change.rangeLength : change.rangeOffset;
	if (deletion.offset !== expectedOffset) { return undefined; }
	const patch = patches.find(candidate => candidate.text && (candidate.blockType === 'brace' || candidate.blockType === 'tag') && candidate.side === 'close');
	if (patch) { directDeletions.delete(keyOf(event.document)); }
	return patch ? { deletion, pairId: patch.pairId, blockType: patch.blockType, stepInside: patch.blockType === 'brace' && ')]}'.includes(event.document.getText()[change.rangeOffset - 1] ?? '') } : undefined;
};
const reconcile = async (event: vscode.TextDocumentChangeEvent, output: vscode.OutputChannel, counter: RepairCounter, status: vscode.StatusBarItem): Promise<void> => {
	const document = event.document, key = keyOf(document);
	if (!isEnabled(document)) { states.delete(key); return; }
	if (repairing.has(key) || !event.contentChanges.length) { index(document); return; }
	const state = states.get(key);
	if (!state || state.languageId !== document.languageId) { index(document); return; }
	const pendingRename = pendingTagRenames.get(key), change = event.contentChanges.length === 1 ? event.contentChanges[0] : undefined;
	if (pendingRename && change) {
		const delta = change.text.length - change.rangeLength, counterpartNameStart = pendingRename.counterpartNameStart + (change.rangeOffset <= pendingRename.counterpartNameStart ? delta : 0), renamed = tagNameAt(document.getText(), pendingRename.tokenStart);
		if (renamed && change.rangeOffset >= pendingRename.tokenStart && change.rangeOffset <= renamed.end) {
			pendingTagRenames.delete(key);
			const edit = new vscode.WorkspaceEdit();
			edit.replace(document.uri, new vscode.Range(document.positionAt(counterpartNameStart), document.positionAt(counterpartNameStart + pendingRename.counterpartNameLength)), renamed.name);
			repairing.add(key);
			try { await vscode.workspace.applyEdit(edit); } finally { repairing.delete(key); index(document); }
			return;
		}
		pendingTagRenames.delete(key);
	}
	if (event.contentChanges.length) {
		const pair = state.shadow.pairs.find(candidate => candidate.type === 'tag' && [
			{ side: 'open' as const, token: candidate.openToken, tokenStart: candidate.openIdx, counterpart: candidate.closeToken, counterpartStart: candidate.closeIdx },
			{ side: 'close' as const, token: candidate.closeToken, tokenStart: candidate.closeIdx, counterpart: candidate.openToken, counterpartStart: candidate.openIdx },
		].some(({ token, tokenStart }) => { const name = tagNameRange(token, tokenStart); return !!name && event.contentChanges.every(candidate => name.start <= candidate.rangeOffset && candidate.rangeOffset + candidate.rangeLength <= name.end); }));
		if (pair) {
			const openName = tagNameRange(pair.openToken, pair.openIdx)!, closeName = tagNameRange(pair.closeToken, pair.closeIdx)!, editingOpen = event.contentChanges.every(candidate => openName.start <= candidate.rangeOffset && candidate.rangeOffset + candidate.rangeLength <= openName.end);
			const tokenStart = editingOpen ? pair.openIdx : pair.closeIdx, counterpart = editingOpen ? closeName : openName, counterpartStart = counterpart.start + event.contentChanges.filter(candidate => candidate.rangeOffset <= counterpart.start).reduce((offset, candidate) => offset + candidate.text.length - candidate.rangeLength, 0), renamed = tagNameAt(document.getText(), tokenStart);
			if (!renamed && change && !change.text && change.rangeOffset === (editingOpen ? openName.start : closeName.start) && change.rangeLength === (editingOpen ? openName.end - openName.start : closeName.end - closeName.start)) {
				pendingTagRenames.set(key, { tokenStart, counterpartNameStart: counterpartStart, counterpartNameLength: counterpart.end - counterpart.start });
				return;
			}
			if (renamed) {
				const edit = new vscode.WorkspaceEdit();
				edit.replace(document.uri, new vscode.Range(document.positionAt(counterpartStart), document.positionAt(counterpartStart + counterpart.end - counterpart.start)), renamed.name);
				repairing.add(key);
				try { await vscode.workspace.applyEdit(edit); } finally { repairing.delete(key); index(document); }
				return;
			}
		}
	}
	const structures = vscode.workspace.getConfiguration(CONFIG_SECTION, document.uri).get<BlockType[]>('structures', ['brace', 'tag', 'quote', 'indent']);
	const structural = state.shadow.planRepairs(event.contentChanges, document.getText()).filter(patch => structures.includes(patch.blockType));
	const plannedPatches = [...structural, ...planClosingIndentRepairs(document, event.contentChanges)].sort((left, right) => right.offset - left.offset);
	if (!plannedPatches.length) { index(document); return; }
	const closerIntent = protectedCloserIntent(event, plannedPatches), directChange = event.contentChanges[0];
	const patches = closerIntent?.blockType === 'brace' && !closerIntent.stepInside ? plannedPatches.map(patch => patch.pairId === closerIntent.pairId ? { ...patch, offset: directChange.rangeOffset, deleteLength: 0, text: patch.text.at(-1) ?? patch.text } : patch) : plannedPatches;

	const edit = new vscode.WorkspaceEdit();
	for (const patch of patches) { edit.replace(document.uri, patchRange(document, patch), patch.text); }
	repairing.add(key);
	let applied = false;
	try {
		applied = await vscode.workspace.applyEdit(edit);
		repairing.delete(key);
		const countedRepairs = applied ? await counter.record(patches, document.uri) : 0;
		if (countedRepairs) { refreshStatus(status, counter); }
		log(output, document.uri, 'repairs', { type: 'syntaxstitch/reconciled', uri: document.uri.toString(), version: document.version, applied, countedRepairs, suppressedRepeats: applied ? patches.length - countedRepairs : 0, repairs: patches });
		if (!applied) { log(output, document.uri, 'repairs', { type: 'syntaxstitch/error', uri: document.uri.toString(), reason: 'workspace-edit-rejected' }); }
	} catch (error) {
		log(output, document.uri, 'repairs', { type: 'syntaxstitch/error', uri: document.uri.toString(), reason: error instanceof Error ? error.message : String(error) });
	} finally {
		repairing.delete(key);
		index(document);
		const shadow = states.get(key)?.shadow, restored = applied && closerIntent ? shadow?.pairs.find(pair => pair.id === closerIntent.pairId) : undefined;
		if (restored && closerIntent) {
			const span = shadow?.selectionSpan(restored.closeIdx), cursor = document.positionAt(restored.closeIdx);
			const selection = closerIntent.stepInside ? new vscode.Selection(cursor, cursor) : span ? new vscode.Selection(document.positionAt(span.start), document.positionAt(span.end)) : undefined;
			if (selection) { closerIntent.deletion.selection = selection; }
		}
	}
};
// endregion

// region Lifecycle
export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel(OUTPUT_NAME, { log: true });
	const status = vscode.window.createStatusBarItem('syntaxstitch.status', vscode.StatusBarAlignment.Right, 100);
	const pairLabelsChanged = new vscode.EventEmitter<void>();
	const counter = new RepairCounter(context);
	const refreshLabels = (): void => pairLabelsChanged.fire();
	const pairLabelEditor = async (target: PairLabelTarget): Promise<vscode.TextEditor> => vscode.window.showTextDocument(vscode.Uri.parse(target.uri), { preserveFocus: false, preview: false });
	const pairAtTarget = (editor: vscode.TextEditor, target: PairLabelTarget) => {
		index(editor.document);
		const pairs = states.get(keyOf(editor.document))!.shadow.pairs;
		return pairs.find(pair => pair.id === target.pairId)
			?? pairs.find(pair => pair.openIdx === target.openIdx && pair.closeIdx === target.closeIdx)
			?? pairs.filter(pair => pair.openIdx <= target.openIdx && pair.closeIdx === target.closeIdx).sort((left, right) => right.openIdx - left.openIdx)[0];
	};
	const pairTokenEnd = (document: vscode.TextDocument, pair: TokenPair, side: 'open' | 'close'): number => {
		const offset = side === 'open' ? pair.openIdx : pair.closeIdx;
		return pair.type === 'tag' ? tagTokenEnd(document.getText(), offset) : offset + 1;
	};
	status.name = OUTPUT_NAME;
	status.command = 'syntaxstitch.showMenu';
	refreshStatus(status, counter);
	status.show();
	vscode.workspace.textDocuments.filter(isEnabled).forEach(index);
	refreshLabels();
	const structuralTab = async (): Promise<boolean> => {
		const editor = vscode.window.activeTextEditor;
		if (editor && isEnabled(editor.document) && editor.selections.length === 1 && editor.selection.isEmpty) {
			index(editor.document);
			const offset = editor.document.offsetAt(editor.selection.active), pairs = states.get(keyOf(editor.document))!.shadow.pairs;
			const tags = pairs.filter(pair => pair.type === 'tag');
			if (tags.some(pair => pair.closeIdx === offset)) {
				const next = tags.filter(pair => pair.closeIdx > offset).sort((left, right) => left.closeIdx - right.closeIdx)[0];
				if (next) { const position = editor.document.positionAt(next.closeIdx); editor.selection = new vscode.Selection(position, position); return true; }
			}
			const brace = pairs.find(pair => pair.type === 'brace' && pair.closeIdx === offset && editor.document.getText()[offset] === '}');
			if (brace) {
				const close = editor.document.positionAt(offset), open = editor.document.positionAt(brace.openIdx);
				const actual = editor.document.lineAt(close.line).text.slice(0, close.character), expected = editor.document.lineAt(open.line).text.match(/^[\t ]*/)?.[0] ?? '';
				if (actual === expected) { const position = editor.document.positionAt(offset + 1); editor.selection = new vscode.Selection(position, position); return true; }
			}
		}
		await vscode.commands.executeCommand('tab');
		return false;
	};

	context.subscriptions.push(
		output,
		status,
		pairLabelsChanged,
		vscode.languages.registerInlayHintsProvider([{ scheme: 'file' }, { scheme: 'untitled' }, { scheme: 'vscode-notebook-cell' }], { onDidChangeInlayHints: pairLabelsChanged.event, provideInlayHints: pairLabelHints }),
		vscode.workspace.onDidOpenTextDocument(document => { if (isEnabled(document)) { index(document); refreshLabels(); } }),
		vscode.workspace.onDidCloseTextDocument(document => states.delete(keyOf(document))),
		vscode.workspace.onDidChangeTextDocument(event => {
			const key = keyOf(event.document), deletion = directDeletions.get(key);
			void reconcile(event, output, counter, status).finally(() => {
				if (deletion && directDeletions.get(key) === deletion) { directDeletions.delete(key); }
				deletion?.complete();
				captureTagCaret(event);
				refreshLabels();
			});
		}),
		vscode.window.onDidChangeActiveTextEditor(() => { refreshStatus(status, counter); refreshLabels(); }),
		vscode.window.onDidChangeVisibleTextEditors(refreshLabels),
		vscode.window.onDidChangeTextEditorSelection(event => { placePendingTagCaret(event.textEditor); refreshLabels(); }),
		vscode.workspace.onDidChangeConfiguration(event => {
			if (!event.affectsConfiguration(CONFIG_SECTION)) { return; }
			states.clear();
			vscode.workspace.textDocuments.filter(isEnabled).forEach(index);
			refreshStatus(status, counter);
			refreshLabels();
		}),
		vscode.commands.registerCommand('syntaxstitch.showMenu', async () => {
			const enabled = enabledSetting(vscode.window.activeTextEditor?.document.uri);
			const selected = await vscode.window.showQuickPick([
				{ label: enabled ? '$(circle-slash) Disable SyntaxStitch' : '$(shield) Enable SyntaxStitch', command: 'syntaxstitch.toggle' },
				{ label: '$(selection) Select Matching Structure', command: 'syntaxstitch.selectMatchingStructure' },
				{ label: '$(fold-down) Select Inner Structure', command: 'syntaxstitch.selectInnerStructure' },
				{ label: '$(graph) View Repair Statistics', command: 'syntaxstitch.showStatistics' },
				{ label: '$(symbol-key) Configure Pair Labels', command: 'syntaxstitch.configurePairLabels' },
				{ label: '$(discard) Reset Repair Count', command: 'syntaxstitch.resetStatistics' },
				{ label: '$(output) Show Reconciliation Output', command: 'syntaxstitch.showOutput' },
				{ label: '$(refresh) Rebuild Shadow Index', command: 'syntaxstitch.rebuildShadowIndex' },
			], { placeHolder: `SyntaxStitch: ${counter.statistics.total} repairs recorded` });
			if (selected) { await vscode.commands.executeCommand(selected.command); }
		}),
		vscode.commands.registerCommand('syntaxstitch.toggle', async () => {
			const uri = vscode.window.activeTextEditor?.document.uri, config = vscode.workspace.getConfiguration(CONFIG_SECTION, uri), enabled = enabledSetting(uri);
			const target = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
			await config.update('enabled', !enabled, target);
			log(output, uri, 'verbose', { type: 'syntaxstitch/toggled', enabled: !enabled, scope: target === vscode.ConfigurationTarget.Workspace ? 'workspace' : 'global' });
		}),
		...(['left', 'right'] as const).map(direction => vscode.commands.registerCommand(`syntaxstitch.delete${direction === 'left' ? 'Left' : 'Right'}`, async () => {
			const editor = vscode.window.activeTextEditor, command = direction === 'left' ? 'deleteLeft' : 'deleteRight';
			if (!editor || !isEnabled(editor.document) || editor.selections.length !== 1 || !editor.selection.isEmpty) { return vscode.commands.executeCommand(command); }
			const offset = editor.document.offsetAt(editor.selection.active);
			if ((direction === 'left' && offset === 0) || (direction === 'right' && offset === editor.document.getText().length)) { return vscode.commands.executeCommand(command); }
			let complete!: () => void;
			const completed = new Promise<void>(resolve => { complete = resolve; }), deletion: DirectDeletion = { editor, direction, offset, completed, complete };
			directDeletions.set(keyOf(editor.document), deletion);
			await vscode.commands.executeCommand(command);
			await completed;
			if (deletion.selection) { editor.selection = deletion.selection; }
		})),
		vscode.commands.registerCommand('syntaxstitch.showStatistics', () => {
			const { total, byKind, unclassified, lastAt } = counter.statistics, last = lastAt ? new Date(lastAt).toLocaleString() : 'Never';
			void vscode.window.showInformationMessage(`SyntaxStitch repaired ${total} tokens: [${byKind.square}], (${byKind.parenthesis}), {${byKind.curly}}, <${byKind.tag}>, "${byKind.quote}", t${byKind.indent}${unclassified ? `, ?${unclassified} legacy` : ''}. Last repair: ${last}.`);
			return counter.statistics;
		}),
		vscode.commands.registerCommand('syntaxstitch.resetStatistics', async () => {
			await counter.reset();
			refreshStatus(status, counter);
			log(output, undefined, 'verbose', { type: 'syntaxstitch/statistics-reset' });
			void vscode.window.showInformationMessage('SyntaxStitch repair count reset.');
		}),
		vscode.commands.registerCommand('syntaxstitch.configurePairLabels', async () => {
			const uri = vscode.window.activeTextEditor?.document.uri, config = vscode.workspace.getConfiguration(CONFIG_SECTION, uri);
			const current = config.get<PairLabelMode>('pairLabels', 'all'), selected = await vscode.window.showQuickPick([
				{ label: 'Off', value: 'off' as const, description: current === 'off' ? 'Current' : undefined },
				{ label: 'Active pair', value: 'active' as const, description: current === 'active' ? 'Current' : undefined },
				{ label: 'All pairs', value: 'all' as const, description: current === 'all' ? 'Current' : undefined },
			], { placeHolder: 'Choose how closing boundaries show their opening declaration' });
			if (selected) { await config.update('pairLabels', selected.value, vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global); }
		}),
		vscode.commands.registerCommand('syntaxstitch.structuralTab', structuralTab),
		vscode.commands.registerCommand('syntaxstitch.tabToNextClosingTag', structuralTab),
		vscode.commands.registerCommand('syntaxstitch.togglePairFold', async (target: PairLabelTarget) => {
			const editor = await pairLabelEditor(target), pair = pairAtTarget(editor, target);
			if (!pair) { return false; }
			const selections = editor.selections, position = editor.document.positionAt(pair.openIdx), close = editor.document.positionAt(pair.closeIdx), touchesFoldedLines = selections.some(selection => {
				if (selection.isEmpty) { return selection.active.line > position.line && selection.active.line <= close.line; }
				return selection.start.line <= close.line && selection.end.line > position.line;
			});
			editor.selection = new vscode.Selection(position, position);
			await vscode.commands.executeCommand('editor.toggleFold');
			if (!touchesFoldedLines) { editor.selections = selections; }
			return true;
		}),
		vscode.commands.registerCommand('syntaxstitch.foldPairContents', async (target: PairLabelTarget) => {
			const editor = await pairLabelEditor(target), pair = pairAtTarget(editor, target);
			if (!pair) { return false; }
			const selections = editor.selections, openLine = editor.document.positionAt(pair.openIdx).line, closeLine = editor.document.positionAt(pair.closeIdx).line;
			const ranges = await vscode.commands.executeCommand<vscode.FoldingRange[]>('vscode.executeFoldingRangeProvider', editor.document.uri) ?? [];
			const children = ranges.filter(range => range.start > openLine && range.end < closeLine), directChildren = children.filter(child => !children.some(parent => parent !== child && parent.start < child.start && parent.end >= child.end));
			const isVisible = (line: number): boolean => editor.visibleRanges.some(range => range.contains(new vscode.Position(line, 0))), unfold = directChildren.length > 0 && directChildren.every(range => !isVisible(range.start + 1));
			if (unfold) {
				await vscode.commands.executeCommand('editor.unfold', { selectionLines: [...new Set(directChildren.map(range => range.start))] });
			} else {
				const probeLine = (child: vscode.FoldingRange): number => {
					const descendants = children.filter(range => range !== child && range.start > child.start && range.end <= child.end);
					for (let line = child.start + 1; line <= child.end; line++) { if (!descendants.some(range => line >= range.start && line <= range.end)) { return line; } }
					return child.end;
				};
				for (const child of [...children].sort((left, right) => right.start - left.start)) { await vscode.commands.executeCommand('editor.fold', { selectionLines: [probeLine(child)] }); }
			}
			editor.selections = selections;
			return true;
		}),
		vscode.commands.registerCommand('syntaxstitch.selectPairContents', async (target: PairLabelTarget) => {
			const editor = await pairLabelEditor(target), pair = pairAtTarget(editor, target);
			if (!pair) { return false; }
			editor.selection = new vscode.Selection(editor.document.positionAt(pairTokenEnd(editor.document, pair, 'open')), editor.document.positionAt(pair.closeIdx));
			editor.revealRange(editor.selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
			return true;
		}),
		vscode.commands.registerCommand('syntaxstitch.selectPairWithDeclaration', async (target: PairLabelTarget) => {
			const editor = await pairLabelEditor(target), pair = pairAtTarget(editor, target);
			if (!pair) { return false; }
			const opener = editor.document.getText()[pair.openIdx], start = opener === '(' || opener === '[' ? editor.document.positionAt(pair.openIdx) : declarationStart(editor.document, pair), end = editor.document.positionAt(pairTokenEnd(editor.document, pair, 'close'));
			editor.selection = new vscode.Selection(start, end);
			editor.revealRange(editor.selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
			return true;
		}),
		vscode.commands.registerCommand('syntaxstitch.selectPairLabel', async (target: PairLabelTarget) => {
			const editor = await pairLabelEditor(target), shadow = states.get(keyOf(editor.document))!.shadow, pair = pairAtTarget(editor, target), span = pair && shadow.selectionSpan(pair.closeIdx);
			if (!span) { return false; }
			editor.selection = new vscode.Selection(editor.document.positionAt(span.start), editor.document.positionAt(span.end));
			editor.revealRange(editor.selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
			return true;
		}),
		vscode.commands.registerCommand('syntaxstitch.selectPairLabelLines', async (target: PairLabelTarget) => {
			const editor = await pairLabelEditor(target), pair = pairAtTarget(editor, target);
			if (!pair) { return false; }
			const open = editor.document.positionAt(pair.openIdx), close = editor.document.positionAt(pair.closeIdx), start = new vscode.Position(open.line, 0), end = new vscode.Position(close.line, editor.document.lineAt(close.line).text.length);
			editor.selection = new vscode.Selection(start, end);
			editor.revealRange(editor.selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
			return true;
		}),
		vscode.commands.registerCommand('syntaxstitch.goToPairStart', async (target: PairLabelTarget) => {
			const editor = await pairLabelEditor(target), pair = pairAtTarget(editor, target);
			if (!pair) { return false; }
			const position = editor.document.positionAt(pair.openIdx);
			editor.selection = new vscode.Selection(position, position);
			editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
			return true;
		}),
		...(['Start', 'End'] as const).flatMap(side => {
			const boundary = (pair: TokenPair): number => side === 'Start' ? pair.openIdx : pair.closeIdx, tokenSide = side === 'Start' ? 'open' as const : 'close' as const;
			return [
				vscode.commands.registerCommand(`syntaxstitch.selectPair${side}Line`, async (target: PairLabelTarget) => {
					const editor = await pairLabelEditor(target), pair = pairAtTarget(editor, target);
					if (!pair) { return false; }
					const line = editor.document.positionAt(boundary(pair)).line, start = new vscode.Position(line, 0), end = new vscode.Position(line, editor.document.lineAt(line).text.length);
					editor.selection = new vscode.Selection(start, end);
					editor.revealRange(editor.selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
					return true;
				}),
				vscode.commands.registerCommand(`syntaxstitch.goAfterPair${side}`, async (target: PairLabelTarget) => {
					const editor = await pairLabelEditor(target), pair = pairAtTarget(editor, target);
					if (!pair) { return false; }
					const position = editor.document.positionAt(pairTokenEnd(editor.document, pair, tokenSide));
					editor.selection = new vscode.Selection(position, position);
					editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
					return true;
				}),
				vscode.commands.registerCommand(`syntaxstitch.selectPair${side}Token`, async (target: PairLabelTarget) => {
					const editor = await pairLabelEditor(target), pair = pairAtTarget(editor, target);
					if (!pair) { return false; }
					editor.selection = new vscode.Selection(editor.document.positionAt(boundary(pair)), editor.document.positionAt(pairTokenEnd(editor.document, pair, tokenSide)));
					editor.revealRange(editor.selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
					return true;
				}),
			];
		}),
		vscode.commands.registerCommand('syntaxstitch.goToPairEnd', async (target: PairLabelTarget) => {
			const editor = await pairLabelEditor(target), pair = pairAtTarget(editor, target);
			if (!pair) { return false; }
			const position = editor.document.positionAt(pair.closeIdx);
			editor.selection = new vscode.Selection(position, position);
			editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
			return true;
		}),
		vscode.commands.registerCommand('syntaxstitch.selectMatchingStructure', () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor || !isEnabled(editor.document)) { return 0; }
			index(editor.document);
			const shadow = states.get(keyOf(editor.document))!.shadow;
			const before = snapshotSelections(editor);
			let selected = 0;
			editor.selections = editor.selections.map(selection => {
				const start = editor.document.offsetAt(selection.start), end = editor.document.offsetAt(selection.end), span = shadow.selectionSpan(start, end);
				if (!span) { return selection; }
				selected++;
				return new vscode.Selection(editor.document.positionAt(span.start), editor.document.positionAt(span.end));
			});
			if (selected) {
				const history = selectionHistory.get(editor) ?? [], previous = history.at(-1);
				if (previous && (previous.version !== editor.document.version || !selectionsMatch(previous.to, before))) { history.length = 0; }
				history.push({ version: editor.document.version, from: before, to: snapshotSelections(editor) });
				selectionHistory.set(editor, history);
			}
			return selected;
		}),
		vscode.commands.registerCommand('syntaxstitch.selectInnerStructure', () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor || !isEnabled(editor.document)) { return 0; }
			index(editor.document);
			const current = snapshotSelections(editor), history = selectionHistory.get(editor), previous = history?.at(-1);
			if (previous && previous.version === editor.document.version && selectionsMatch(previous.to, current)) {
				history!.pop();
				restoreSelections(editor, previous.from);
				return previous.from.filter((selection, index) => selection.anchor !== current[index].anchor || selection.active !== current[index].active).length;
			}
			if (history) { history.length = 0; }
			const shadow = states.get(keyOf(editor.document))!.shadow;
			let selected = 0;
			editor.selections = editor.selections.map(selection => {
				if (selection.isEmpty) { return selection; }
				const start = editor.document.offsetAt(selection.start), end = editor.document.offsetAt(selection.end);
				const span = shadow.innerSelectionSpan(start, end, selection.active.isAfter(selection.anchor));
				if (!span) { return selection; }
				selected++;
				return new vscode.Selection(editor.document.positionAt(span.start), editor.document.positionAt(span.end));
			});
			return selected;
		}),
		vscode.commands.registerCommand('syntaxstitch.rebuildShadowIndex', () => {
			const document = vscode.window.activeTextEditor?.document;
			if (document && isEnabled(document)) { index(document); void vscode.window.showInformationMessage(`SyntaxStitch indexed ${states.get(keyOf(document))?.shadow.pairs.length ?? 0} structural pairs.`); }
		}),
		vscode.commands.registerCommand('syntaxstitch.inspectActiveDocument', () => {
			const document = vscode.window.activeTextEditor?.document;
			if (!document) { void vscode.window.showWarningMessage('SyntaxStitch: No active document.'); return; }
			const config = vscode.workspace.getConfiguration(CONFIG_SECTION, document.uri), pairs = states.get(keyOf(document))?.shadow.pairs ?? [];
			const counts = Object.fromEntries(['brace', 'tag', 'quote', 'indent'].map(type => [type, pairs.filter(pair => pair.type === type).length]));
			void vscode.window.showInformationMessage(`SyntaxStitch: ${document.languageId}, ${isEnabled(document) ? 'active' : 'inactive'}, pairs ${JSON.stringify(counts)}, structures ${config.get<string[]>('structures', []).join(', ') || 'none'}.`);
		}),
		vscode.commands.registerCommand('syntaxstitch.showOutput', () => output.show()),
	);
}

export function deactivate(): void { states.clear(); repairing.clear(); directDeletions.clear(); }
// endregion
