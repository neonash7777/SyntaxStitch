import * as vscode from 'vscode';
import { parseTagAt, markupTags } from './markup';
import { PendingEdits } from './pendingEdits';
import { numberedIds, decodeAttribute } from './uniqueIds';
import { RepairCounter, type RepairSource } from './repairStatistics';
export type { RepairStatistics } from './repairStatistics';
import { planComponentEdit } from './mirroredEdits';
import type { StructuralSelectionSpan, StructuralSelectionLevel, StructuralSelectionMode } from './selectionTypes';
import { EditScope, type MirroringScope } from './editScope';
import { RepairHistory } from './repairHistory';
import { openPractice } from './practice';
import { repairStatusPresentation, animatedRepairStatusText, statisticsHtml, STATUS_ACTIVITY_PREFIX } from './statisticsUi';
export { repairStatusPresentation, animatedRepairStatusText } from './statisticsUi';
import { ShadowStructure, type BlockType, type RepairPatch, type SelectionSpan, type TokenPair } from './shadowStructure';

// region State
type DocumentState = { shadow: ShadowStructure; languageId: string; version: number };
type StructureSetting = BlockType | 'square' | 'parenthesis' | 'curly';
const states = new Map<string, DocumentState>();
const repairing = new Set<string>();
const pausedDocuments = new Set<string>();
const skippedEdits = new Set<string>();
const editScopes = new WeakMap<vscode.TextEditor, EditScope>();
const repairHistory = new RepairHistory();
let nestedStatus: vscode.StatusBarItem;
let targetDecoration: vscode.TextEditorDecorationType;
let statisticsPanel: vscode.WebviewPanel | undefined;
const OUTPUT_NAME = 'SyntaxStitch';
const CONFIG_SECTION = 'syntaxstitch';
const BYTES_PER_KIBIBYTE = 1024;
type LogLevel = 'off' | 'repairs' | 'verbose';
type PairLabelMode = 'off' | 'active' | 'all';
type SelectionSnapshot = { anchor: number; active: number }[];
type SelectionTransition = { version: number; from: SelectionSnapshot; to: SelectionSnapshot };
const selectionHistory = new WeakMap<vscode.TextEditor, SelectionTransition[]>();
const lastSelections = new WeakMap<vscode.TextEditor, SelectionSnapshot>();
const structuralSelectionModes = new WeakMap<vscode.TextEditor, StructuralSelectionMode>();
let structuralSelectionDecoration: vscode.TextEditorDecorationType;
let structuralSelectionFocusedDecoration: vscode.TextEditorDecorationType;
let structuralSelectionInactiveDecoration: vscode.TextEditorDecorationType;
let structuralSelectionFocusedInactiveDecoration: vscode.TextEditorDecorationType;
let structuralSelectionComponentDecoration: vscode.TextEditorDecorationType;
type DirectDeletion = { editor: vscode.TextEditor; direction: 'left' | 'right'; offset: number; completed: Promise<void>; complete: () => void; selection?: vscode.Selection };
const directDeletions = new Map<string, DirectDeletion>();
const pendingTagCarets = new WeakMap<vscode.TextEditor, { afterOpen: number; afterClose: number; version: number; expiresAt: number }>();
type PendingTagRename = { tokenStart: number; counterpartNameStart: number; counterpartNameLength: number };
const pendingTagRenames = new Map<string, PendingTagRename>();
const pendingEdits = new PendingEdits();
const pendingFeedback = new Map<string, { count: number }>();
const pendingReconciliations = new Map<string, Promise<void>>();
const observedDocumentVersions = new Map<string, number>();
const savingDocuments = new Set<string>();
const SAVE_DRAIN_TIMEOUT_MS = 1000;
const selectionSessions = new Map<vscode.TextEditor, object>();
const documentHasOpenEditor = (document: vscode.TextDocument): boolean => !document.isClosed && vscode.window.tabGroups.all.some(group => group.tabs.some(tab => {
	const input = tab.input;
	return input instanceof vscode.TabInputText ? input.uri.toString() === document.uri.toString()
		: input instanceof vscode.TabInputTextDiff && input.modified.toString() === document.uri.toString();
}));

const snapshotSelections = (editor: vscode.TextEditor): SelectionSnapshot => editor.selections.map(selection => ({ anchor: editor.document.offsetAt(selection.anchor), active: editor.document.offsetAt(selection.active) }));
const selectionsMatch = (left: SelectionSnapshot, right: SelectionSnapshot): boolean => left.length === right.length && left.every((selection, index) => selection.anchor === right[index].anchor && selection.active === right[index].active);
const restoreSelections = (editor: vscode.TextEditor, snapshot: SelectionSnapshot): void => { editor.selections = snapshot.map(selection => new vscode.Selection(editor.document.positionAt(selection.anchor), editor.document.positionAt(selection.active))); };
const balanceForwardSelection = (editor: vscode.TextEditor, previous: SelectionSnapshot | undefined, current: SelectionSnapshot): void => {
	if (!isEnabled(editor.document) || skippedEdits.has(keyOf(editor.document)) || !previous || previous.length !== 1 || current.length !== 1) { return; }
	const before = previous[0], after = current[0];
	if (before.anchor !== after.anchor || before.active + 1 !== after.active || before.active <= before.anchor) { return; }
	index(editor.document);
	const shadow = states.get(keyOf(editor.document))?.shadow, start = after.anchor, end = after.active;
	const pair = shadow?.pairs.find(candidate => candidate.type === 'brace' && candidate.closeIdx === end - 1 && candidate.closeToken.length === 1 && (
		(candidate.openIdx === start - 1 && candidate.openToken.length === 1) ||
		(shadow.pairs.some(inner => inner.type === 'brace' && inner.openIdx === before.anchor && inner.closeIdx + inner.closeToken.length === before.active) && candidate.openIdx < before.anchor)
	));
	if (!pair) { return; }
	editor.selection = new vscode.Selection(editor.document.positionAt(pair.openIdx), editor.document.positionAt(end));
};
const renderStructuralSelectionMode = (editor: vscode.TextEditor, mode: StructuralSelectionMode | undefined): void => {
	if (!mode) { editor.setDecorations(targetDecoration, []); editor.setDecorations(structuralSelectionDecoration, []); editor.setDecorations(structuralSelectionComponentDecoration, []); editor.setDecorations(structuralSelectionFocusedDecoration, []); editor.setDecorations(structuralSelectionInactiveDecoration, []); editor.setDecorations(structuralSelectionFocusedInactiveDecoration, []); return; }
	const ancestorSpans = mode.ancestors?.flatMap(level => level.spans) ?? [], structuralSpans = [...ancestorSpans, ...mode.spans], ranges = structuralSpans.filter(span => span.active && span.highlighted !== false && span.role === 'structure' && span.start < span.end).map(span => new vscode.Range(editor.document.positionAt(span.start), editor.document.positionAt(span.end))), components = mode.spans.filter(span => span.active && span.highlighted !== false && span.role !== 'structure' && span.start < span.end).map(span => new vscode.Range(editor.document.positionAt(span.start), editor.document.positionAt(span.end))), inactive = [...ancestorSpans.filter(span => span.active && span.highlighted === false && span.start < span.end), ...mode.spans.filter((span, index) => span.active && span.highlighted === false && index !== mode.focused && span.start < span.end)].map(span => new vscode.Range(editor.document.positionAt(span.start), editor.document.positionAt(span.end))), focused = mode.spans[mode.focused], focusedInactive = focused && focused.highlighted === false && focused.start < focused.end ? [new vscode.Range(editor.document.positionAt(focused.start), editor.document.positionAt(focused.end))] : [];
	editor.setDecorations(structuralSelectionDecoration, ranges);
	editor.setDecorations(structuralSelectionComponentDecoration, components);
	editor.setDecorations(structuralSelectionInactiveDecoration, inactive);
	editor.setDecorations(structuralSelectionFocusedDecoration, focused && focused.active ? [new vscode.Range(editor.document.positionAt(focused.start), editor.document.positionAt(focused.end))] : []);
	editor.setDecorations(structuralSelectionFocusedInactiveDecoration, focusedInactive);
};
const applyStructuralSelectionMode = (editor: vscode.TextEditor, mode: StructuralSelectionMode): void => {
	structuralSelectionModes.set(editor, mode);
	void vscode.commands.executeCommand('setContext', 'syntaxstitch.structuralSelectionMode', true);
	void vscode.commands.executeCommand('setContext', 'syntaxstitch.structuralSelectionTyping', !!mode.typing);
	const focused = mode.spans[mode.focused];
	if (focused && !mode.typing) { const position = editor.document.positionAt(focused.start); editor.selection = focused.active && focused.highlighted !== false ? new vscode.Selection(position, editor.document.positionAt(focused.end)) : new vscode.Selection(position, position); }
	renderStructuralSelectionMode(editor, mode);
	refreshNestedPreview(editor);
};
const levelOf = (mode: StructuralSelectionMode): StructuralSelectionLevel => ({ scope: { ...mode.scope }, spans: mode.spans.map(span => ({ ...span })), focused: mode.focused, stage: mode.stage });
const restoreStructuralLevel = (mode: StructuralSelectionMode, level: StructuralSelectionLevel, ancestors: StructuralSelectionLevel[]): StructuralSelectionMode => ({ ...mode, scope: level.scope, spans: level.spans.map(span => ({ ...span })), focused: level.focused, stage: level.stage, ancestors });
const drillIntoStructuralSelection = (editor: vscode.TextEditor): boolean => {
	const mode = structuralSelectionModes.get(editor), focused = mode?.spans[mode.focused];
	if (!mode || !focused) { return false; }
	if (mode.typing) { applyStructuralSelectionMode(editor, { ...mode, typing: false }); return true; }
	index(editor.document);
	const shadow = states.get(keyOf(editor.document))!.shadow, children = shadow.pairs.filter(pair => (pair.type === 'brace' || pair.type === 'tag') && focused.start < pair.openIdx && pair.closeIdx + pair.closeToken.length <= focused.end).map(pair => ({ start: pair.openIdx, end: pair.closeIdx + pair.closeToken.length, active: true, role: 'structure' as const }));
	// A leaf component cannot provide a deeper level; let Enter restore its parent.
	if (!children.length && (focused.role !== 'structure' || (mode.spans.length === 1 && mode.scope.start === focused.start && mode.scope.end === focused.end))) { return false; }
	const content = children.length ? children : focused.end > focused.start ? [{ start: focused.start, end: focused.end, active: true, role: 'structure' as const }] : [];
	if (!content.length) { return false; }
	applyStructuralSelectionMode(editor, { ...mode, ancestors: [...(mode.ancestors ?? []), levelOf(mode)], scope: { start: focused.start, end: focused.end }, spans: content, focused: 0, stage: 'structure' });
	return true;
};
const climbStructuralSelection = (editor: vscode.TextEditor): boolean => {
	const mode = structuralSelectionModes.get(editor);
	if (!mode) { return false; }
	if (mode.typing) { applyStructuralSelectionMode(editor, { ...mode, typing: false }); return true; }
	if (mode.stage === 'structure') {
		const ancestor = mode.ancestors?.at(-1);
		if (ancestor) {
			const focused = mode.spans.length === ancestor.spans.length ? mode.focused : ancestor.focused;
			applyStructuralSelectionMode(editor, restoreStructuralLevel(mode, { ...ancestor, focused }, mode.ancestors?.slice(0, -1) ?? []));
			return true;
		}
	}
	if (mode.stage === 'components') {
		const ancestor = mode.ancestors?.at(-1);
		if (ancestor) { applyStructuralSelectionMode(editor, restoreStructuralLevel(mode, ancestor, mode.ancestors?.slice(0, -1) ?? [])); return true; }
		const focused = mode.spans[mode.focused], parent = focused && states.get(keyOf(editor.document))!.shadow.pairs.filter(pair => (pair.type === 'brace' || pair.type === 'tag') && pair.openIdx <= focused.start && pair.closeIdx + pair.closeToken.length >= focused.end).sort((left, right) => right.openIdx - left.openIdx)[0], inner = parent ? [{ start: parent.openIdx + parent.openToken.length, end: parent.closeIdx, active: true, role: 'structure' as const }] : [];
		if (inner.length) { applyStructuralSelectionMode(editor, { ...mode, spans: inner, focused: 0, stage: 'inner' }); return true; }
	}
	if (mode.stage === 'inner') {
		const ancestor = mode.ancestors?.at(-1);
		if (ancestor) { applyStructuralSelectionMode(editor, restoreStructuralLevel(mode, ancestor, mode.ancestors?.slice(0, -1) ?? [])); return true; }
		const focused = mode.spans[mode.focused], parent = focused && states.get(keyOf(editor.document))!.shadow.pairs.find(pair => pair.openIdx < focused.start && pair.closeIdx + pair.closeToken.length >= focused.end), structural = parent ? [{ start: parent.openIdx, end: parent.closeIdx + parent.closeToken.length, active: true, role: 'structure' as const }] : [];
		if (structural.length) { applyStructuralSelectionMode(editor, { ...mode, spans: structural, focused: 0, stage: 'structure' }); return true; }
	}
	const ancestor = mode.ancestors?.at(-1);
	if (!ancestor) { return true; }
	applyStructuralSelectionMode(editor, restoreStructuralLevel(mode, ancestor, mode.ancestors?.slice(0, -1) ?? []));
	return true;
};
const returnToPeerInnerSelection = (editor: vscode.TextEditor): boolean => {
	const mode = structuralSelectionModes.get(editor), ancestor = mode?.ancestors?.at(-1);
	if (!mode || !ancestor) { return false; }
	applyStructuralSelectionMode(editor, restoreStructuralLevel(mode, ancestor, mode.ancestors?.slice(0, -1) ?? []));
	return enterNextStructuralStage(editor);
};
const activateStructuralSelection = (editor: vscode.TextEditor): boolean => {
	const mode = structuralSelectionModes.get(editor);
	if (!mode) { return false; }
	if (mode.typing) { applyStructuralSelectionMode(editor, { ...mode, typing: false }); return true; }
	if (mode.stage === 'structure' && !mode.ancestors?.length) { return enterNextStructuralStage(editor); }
	if (mode.stage === 'components' && mode.spans[mode.focused]?.role === 'structure') { return returnToPeerInnerSelection(editor); }
	if (mode.stage === 'inner' && mode.ancestors?.length) { return climbStructuralSelection(editor); }
	if (drillIntoStructuralSelection(editor)) { return true; }
	if (climbStructuralSelection(editor)) { return true; }
	if (mode.spans.length > 1) { applyStructuralSelectionMode(editor, { ...mode, focused: (mode.focused + 1) % mode.spans.length }); return true; }
	return exitStructuralSelectionMode(editor);
};
const cycleStructuralPeerSelection = (editor: vscode.TextEditor, direction: 1 | -1): boolean => {
	const mode = structuralSelectionModes.get(editor);
	if (!mode) { return false; }
	if (mode.typing) { applyStructuralSelectionMode(editor, { ...mode, typing: false }); return true; }
	if (mode.stage !== 'structure' || mode.spans.length < 2) { return false; }
	applyStructuralSelectionMode(editor, { ...mode, focused: (mode.focused + direction + mode.spans.length) % mode.spans.length });
	return true;
};
const cycleDerivedNestedPeerSelection = (editor: vscode.TextEditor, direction: 1 | -1): boolean => {
	const mode = structuralSelectionModes.get(editor), focused = mode?.spans[mode.focused];
	if (!mode || !focused || mode.stage !== 'structure' || mode.spans.length !== 1) { return false; }
	index(editor.document);
	const shadow = states.get(keyOf(editor.document))!.shadow, text = editor.document.getText(), current = shadow.pairs.find(pair => pair.type === 'tag' && pair.openIdx === focused.start && pair.closeIdx + pair.closeToken.length === focused.end);
	if (!current) { return false; }
	const parent = shadow.pairs.filter(pair => pair.type === 'tag' && pair.openIdx < current.openIdx && current.closeIdx + current.closeToken.length < pair.closeIdx + pair.closeToken.length).sort((left, right) => right.openIdx - left.openIdx)[0], container = parent && shadow.pairs.filter(pair => pair.type === 'tag' && pair.openIdx < parent.openIdx && parent.closeIdx + parent.closeToken.length < pair.closeIdx + pair.closeToken.length).sort((left, right) => right.openIdx - left.openIdx)[0];
	if (!parent || !container) { return false; }
	const directChild = (owner: TokenPair, name: string): TokenPair | undefined => {
		const candidates = shadow.pairs.filter(pair => pair.type === 'tag' && owner.openIdx < pair.openIdx && pair.closeIdx + pair.closeToken.length < owner.closeIdx + owner.closeToken.length);
		return candidates.filter(candidate => !candidates.some(ancestor => ancestor !== candidate && ancestor.openIdx < candidate.openIdx && candidate.closeIdx + candidate.closeToken.length < ancestor.closeIdx + ancestor.closeToken.length)).find(candidate => tagNameAt(text, candidate.openIdx)?.name === name);
	};
	const parentName = tagNameAt(text, parent.openIdx)?.name, childName = tagNameAt(text, current.openIdx)?.name, containerName = tagNameAt(text, container.openIdx)?.name;
	if (!parentName || !childName || !containerName) { return false; }
	const peers = shadow.pairs.filter(pair => pair.type === 'tag' && tagNameAt(text, pair.openIdx)?.name === containerName).flatMap(owner => {
		const peerParent = directChild(owner, parentName), peerChild = peerParent && directChild(peerParent, childName);
		return peerChild ? [{ start: peerChild.openIdx, end: peerChild.closeIdx + peerChild.closeToken.length, active: true, role: 'structure' as const }] : [];
	});
	const currentIndex = peers.findIndex(span => span.start === current.openIdx && span.end === current.closeIdx + current.closeToken.length);
	if (peers.length < 2 || currentIndex < 0) { return false; }
	applyStructuralSelectionMode(editor, { ...mode, spans: peers, focused: (currentIndex + direction + peers.length) % peers.length });
	return true;
};
const cycleInnerContentSelection = (editor: vscode.TextEditor, direction: 1 | -1): boolean => {
	const mode = structuralSelectionModes.get(editor);
	if (!mode || mode.typing || mode.stage !== 'inner') { return false; }
	const ancestor = mode.ancestors?.at(-1);
	if (!ancestor || !ancestor.spans.length) { return false; }
	const nextFocused = (ancestor.focused + direction + ancestor.spans.length) % ancestor.spans.length;
	applyStructuralSelectionMode(editor, { ...restoreStructuralLevel(mode, ancestor, mode.ancestors?.slice(0, -1) ?? []), focused: nextFocused });
	return enterNextStructuralStage(editor);
};
const fallbackSiblingCycleAncestor = (editor: vscode.TextEditor, focused: StructuralSelectionSpan): StructuralSelectionLevel | undefined => {
	index(editor.document);
	const shadow = states.get(keyOf(editor.document))?.shadow, text = editor.document.getText();
	if (!shadow) { return undefined; }
	const parent = shadow.pairs.filter(pair => (pair.type === 'brace' || pair.type === 'tag') && pair.openIdx < focused.start && pair.closeIdx + pair.closeToken.length >= focused.end).sort((left, right) => right.openIdx - left.openIdx)[0];
	if (!parent || parent.type !== 'tag') { return undefined; }
	const name = tagNameAt(text, parent.openIdx)?.name;
	if (!name) { return undefined; }
	const spans = shadow.pairs.filter(pair => pair.type === 'tag' && tagNameAt(text, pair.openIdx)?.name === name).map(pair => ({ start: pair.openIdx, end: pair.closeIdx + pair.closeToken.length, active: true, role: 'structure' as const })).sort((left, right) => left.start - right.start);
	if (spans.length < 2) { return undefined; }
	const current = spans.findIndex(span => span.start === parent.openIdx && span.end === parent.closeIdx + parent.closeToken.length);
	return { scope: { start: parent.openIdx, end: parent.closeIdx + parent.closeToken.length }, spans, focused: current >= 0 ? current : 0, stage: 'structure' };
};
const exitStructuralSelectionMode = (editor: vscode.TextEditor): boolean => {
	if (!structuralSelectionModes.has(editor)) { return false; }
	if (structuralSelectionModes.get(editor)?.typing) { applyStructuralSelectionMode(editor, { ...structuralSelectionModes.get(editor)!, typing: false }); return true; }
	structuralSelectionModes.delete(editor);
	renderStructuralSelectionMode(editor, undefined);
	refreshNestedPreview(editor);
	void vscode.commands.executeCommand('setContext', 'syntaxstitch.structuralSelectionMode', false);
	void vscode.commands.executeCommand('setContext', 'syntaxstitch.structuralSelectionTyping', false);
	return true;
};
const expandStructuralSelectionMode = (editor: vscode.TextEditor, direction: 1 | -1): boolean => {
	const mode = structuralSelectionModes.get(editor);
	if (!mode) { return false; }
	const focused = mode.spans[mode.focused];
	if (direction < 0 && focused?.role === 'structure') {
		index(editor.document);
		const text = editor.document.getText(), shadow = states.get(keyOf(editor.document))!.shadow, owner = shadow.pairs.find(pair => pair.type === 'tag' && pair.openIdx === focused.start && pair.closeIdx + pair.closeToken.length === focused.end);
		if (owner) {
			const components = tagComponents(editor, { start: owner.openIdx, end: owner.closeIdx + owner.closeToken.length, active: true, role: 'structure' }), property = components.filter(component => component.role === 'property').at(-1);
			if (property) {
				const propertyIndex = components.indexOf(property), value = components.slice(propertyIndex + 1).find(component => component.role === 'value'), end = value ? value.end + ((text[value.start - 1] === '"' || text[value.start - 1] === "'") && text[value.end] === text[value.start - 1] ? 1 : 0) : property.end;
				applyStructuralSelectionMode(editor, { ...mode, spans: [{ start: property.start, end, active: true, role: 'attribute', attributeName: text.slice(property.start, property.end).toLowerCase() }], focused: 0, stage: 'components' });
				return true;
			}
		}
	}
	if (direction < 0 && focused?.role === 'value') {
		index(editor.document);
		const text = editor.document.getText(), shadow = states.get(keyOf(editor.document))!.shadow, owner = shadow.pairs.filter(pair => pair.type === 'tag' && pair.openIdx <= focused.start && focused.end <= pair.closeIdx + pair.closeToken.length).sort((left, right) => right.openIdx - left.openIdx)[0];
		if (owner) {
			const components = tagComponents(editor, { start: owner.openIdx, end: owner.closeIdx + owner.closeToken.length, active: true, role: 'structure' }), valueIndex = components.findIndex(component => component.role === 'value' && component.start === focused.start && component.end === focused.end), property = components.slice(0, valueIndex).filter(component => component.role === 'property').at(-1);
			if (property) {
				const end = focused.end + ((text[focused.start - 1] === '"' || text[focused.start - 1] === "'") && text[focused.end] === text[focused.start - 1] ? 1 : 0);
				applyStructuralSelectionMode(editor, { ...mode, spans: mode.spans.map((span, index) => index === mode.focused ? { ...span, start: property.start, end, role: 'attribute', attributeName: text.slice(property.start, property.end).toLowerCase() } : span) });
				return true;
			}
		}
	}
	if (direction > 0 && focused?.role === 'property') {
		index(editor.document);
		const text = editor.document.getText(), shadow = states.get(keyOf(editor.document))!.shadow, owner = shadow.pairs.filter(pair => pair.type === 'tag' && pair.openIdx <= focused.start && focused.end <= pair.closeIdx + pair.closeToken.length).sort((left, right) => right.openIdx - left.openIdx)[0];
		if (owner) {
			const components = tagComponents(editor, { start: owner.openIdx, end: owner.closeIdx + owner.closeToken.length, active: true, role: 'structure' }), propertyIndex = components.findIndex(component => component.role === 'property' && component.start === focused.start && component.end === focused.end), value = propertyIndex >= 0 ? components.slice(propertyIndex + 1).find(component => component.role === 'value') : undefined, end = value ? value.end + ((text[value.start - 1] === '"' || text[value.start - 1] === "'") && text[value.end] === text[value.start - 1] ? 1 : 0) : focused.end;
			applyStructuralSelectionMode(editor, { ...mode, spans: mode.spans.map((span, index) => index === mode.focused ? { ...span, end, role: 'attribute', attributeName: text.slice(focused.start, focused.end).toLowerCase() } : span) });
			return true;
		}
	}
	if (focused?.role === 'attribute' && focused.attributeName) {
		index(editor.document);
		const text = editor.document.getText(), shadow = states.get(keyOf(editor.document))!.shadow, owner = shadow.pairs.filter(pair => pair.type === 'tag' && pair.openIdx <= focused.start && focused.end <= pair.closeIdx + pair.closeToken.length).sort((left, right) => right.openIdx - left.openIdx)[0];
		if (owner) {
			const components = tagComponents(editor, { start: owner.openIdx, end: owner.closeIdx + owner.closeToken.length, active: true, role: 'structure' }), properties = components.filter(component => component.role === 'property'), currentIndex = properties.findIndex(property => text.slice(property.start, property.end).toLowerCase() === focused.attributeName), targetProperty = properties[currentIndex + direction];
			if (!targetProperty) { return true; }
			const targetName = text.slice(targetProperty.start, targetProperty.end).toLowerCase(), clauses = shadow.pairs.filter(pair => pair.type === 'tag' && tagNameAt(text, pair.openIdx)?.name === tagNameAt(text, owner.openIdx)?.name).flatMap(pair => {
				const peerComponents = tagComponents(editor, { start: pair.openIdx, end: pair.closeIdx + pair.closeToken.length, active: true, role: 'structure' }), propertyIndex = peerComponents.findIndex(property => property.role === 'property' && text.slice(property.start, property.end).toLowerCase() === targetName);
				if (propertyIndex < 0) { return []; }
				const property = peerComponents[propertyIndex], value = peerComponents.slice(propertyIndex + 1).find(component => component.role === 'value'), end = value ? value.end + ((text[value.start - 1] === '"' || text[value.start - 1] === "'") && text[value.end] === text[value.start - 1] ? 1 : 0) : property.end;
				return [{ start: property.start, end, active: true, role: 'attribute' as const, attributeName: targetName }];
			});
			const uniqueClauses = clauses.filter(clause => !mode.spans.some(span => span.start === clause.start && span.end === clause.end)), currentClause = clauses.find(clause => clause.start === targetProperty.start);
			if (!currentClause) { return true; }
			const spans = direction > 0 ? [...mode.spans, ...uniqueClauses] : [...uniqueClauses, ...mode.spans];
			const focusedIndex = direction > 0 ? spans.findIndex(span => span.start === currentClause.start && span.end === currentClause.end) : spans.findIndex(span => span.start === focused.start && span.end === focused.end);
			applyStructuralSelectionMode(editor, { ...mode, spans, focused: focusedIndex < 0 ? mode.focused : focusedIndex });
			return true;
		}
	}
	index(editor.document);
	const spans = states.get(keyOf(editor.document))!.shadow.innerSelectionSpans(mode.scope.start, mode.scope.end), candidates = spans.filter(span => !mode.spans.some(current => current.start === span.start && current.end === span.end));
	if (!candidates.length) { return true; }
	const next = direction > 0 ? candidates.find(span => span.start >= mode.spans.at(-1)!.start) ?? candidates[0] : [...candidates].reverse().find(span => span.end <= mode.spans[0].end) ?? candidates.at(-1)!;
	const nextSpan = { ...next, active: true, role: 'structure' as const };
	applyStructuralSelectionMode(editor, { ...mode, spans: direction > 0 ? [...mode.spans, nextSpan] : [nextSpan, ...mode.spans], focused: direction > 0 ? mode.spans.length : 0 });
	return true;
};
const enterStructuralSelectionMode = (editor: vscode.TextEditor): boolean => {
	if (!editor || editor.selections.length !== 1 || editor.selection.isEmpty) { return false; }
	index(editor.document);
	const start = editor.document.offsetAt(editor.selection.start), end = editor.document.offsetAt(editor.selection.end), shadow = states.get(keyOf(editor.document))!.shadow, candidates = shadow.pairs
		.filter(pair => (pair.type === 'brace' || pair.type === 'tag') && start <= pair.openIdx && pair.closeIdx + pair.closeToken.length <= end), selected = candidates
		.filter(pair => !candidates.some(parent => parent !== pair && parent.openIdx <= pair.openIdx && pair.closeIdx + pair.closeToken.length <= parent.closeIdx + parent.closeToken.length))
		.map(pair => ({ start: pair.openIdx, end: pair.closeIdx + pair.closeToken.length, active: true, role: 'structure' as const }));
	if (!selected.length) { return false; }
	const enclosing = shadow.pairs.filter(pair => pair.openIdx < start && pair.closeIdx + pair.closeToken.length > end).sort((a, b) => b.openIdx - a.openIdx)[0];
	pendingEdits.cancel(keyOf(editor.document));
	selectionSessions.set(editor, {});
	editScopes.set(editor, new EditScope({ start, end }, enclosing ? { start: enclosing.openIdx, end: enclosing.closeIdx + enclosing.closeToken.length } : { start, end }, vscode.workspace.getConfiguration(CONFIG_SECTION, editor.document.uri).get<MirroringScope>('mirroringScope', 'selection')));
	applyStructuralSelectionMode(editor, { scope: { start, end }, spans: selected, focused: 0, stage: 'structure', ancestors: [] });
	return true;
};
const cssComponents = (editor: vscode.TextEditor, span: StructuralSelectionSpan): StructuralSelectionSpan[] => {
	const text = editor.document.getText().slice(span.start, span.end), components: StructuralSelectionSpan[] = [];
	for (const match of text.matchAll(/([\w-]+)\s*:\s*([^;{}]+)(;|$)/g)) {
		const propertyStart = span.start + match.index! + match[0].indexOf(match[1]);
		const valueStart = span.start + match.index! + match[0].indexOf(match[2]);
		components.push({ start: propertyStart, end: propertyStart + match[1].length, active: true, role: 'property' }, { start: valueStart, end: valueStart + match[2].trim().length, active: true, role: 'value' });
		let partOffset = valueStart;
		for (const part of match[2].trim().split(/\s+/)) { partOffset = editor.document.getText().indexOf(part, partOffset); components.push({ start: partOffset, end: partOffset + part.length, active: true, role: 'value-part' }); partOffset += part.length; }
	}
	return components;
};
const tagComponents = (editor: vscode.TextEditor, span: StructuralSelectionSpan): StructuralSelectionSpan[] => {
	const tag = parseTagAt(editor.document.getText(), span.start, span.end);
	if (!tag || tag.closing) { return []; }
	return tag.attributes.flatMap(attribute => {
		const key: StructuralSelectionSpan = { ...attribute.key, active: true, role: 'property', attributeName: attribute.name };
		return attribute.value ? [key, { ...attribute.value, active: true, role: 'value' as const, attributeName: attribute.name }] : [key];
	});
};
const structuralComponents = (editor: vscode.TextEditor, spans: StructuralSelectionSpan[]): StructuralSelectionSpan[] => spans.flatMap(span => {
	if (span.role !== 'structure') { return []; }
	const text = editor.document.getText().slice(span.start, span.end).trimStart();
	return text.startsWith('<') ? tagComponents(editor, span) : cssComponents(editor, span);
});
const cyclePeerComponentSelection = (editor: vscode.TextEditor, direction: 1 | -1): boolean => {
	const mode = structuralSelectionModes.get(editor), focused = mode?.spans[mode.focused], ancestor = mode?.ancestors?.at(-1);
	if (!mode || !focused || !ancestor || mode.stage !== 'components' || (focused.role !== 'property' && focused.role !== 'value' && focused.role !== 'attribute')) { return false; }
	index(editor.document);
	const shadow = states.get(keyOf(editor.document))!.shadow, text = editor.document.getText(), current = shadow.pairs.filter(pair => pair.type === 'tag' && pair.openIdx <= focused.start && focused.end <= pair.closeIdx + pair.closeToken.length).sort((left, right) => right.openIdx - left.openIdx)[0], currentIndex = ancestor.spans.findIndex(span => current && span.start <= current.openIdx && current.closeIdx + current.closeToken.length <= span.end);
	if (!current || currentIndex < 0) { return false; }
	const currentName = tagNameAt(text, current.openIdx)?.name;
	if (!currentName) { return false; }
	const peerTag = (span: StructuralSelectionSpan): TokenPair | undefined => {
		const exact = shadow.pairs.find(pair => pair.type === 'tag' && pair.openIdx === span.start && pair.closeIdx + pair.closeToken.length === span.end);
		if (exact && tagNameAt(text, exact.openIdx)?.name === currentName) { return exact; }
		const candidates = shadow.pairs.filter(pair => pair.type === 'tag' && span.start < pair.openIdx && pair.closeIdx + pair.closeToken.length < span.end);
		return candidates.filter(candidate => !candidates.some(parent => parent !== candidate && parent.openIdx < candidate.openIdx && candidate.closeIdx + candidate.closeToken.length < parent.closeIdx + parent.closeToken.length)).find(candidate => tagNameAt(text, candidate.openIdx)?.name === currentName);
	};
	const currentComponents = tagComponents(editor, { start: current.openIdx, end: current.closeIdx + current.closeToken.length, active: true, role: 'structure' }), currentComponentIndex = currentComponents.findIndex(component => component.role === focused.role && component.start === focused.start && component.end === focused.end), property = focused.role === 'attribute' ? currentComponents.find(component => component.role === 'property' && text.slice(component.start, component.end).toLowerCase() === focused.attributeName) : currentComponents.slice(0, currentComponentIndex + 1).filter(component => component.role === 'property').at(-1);
	if (!property) { return false; }
	const key = text.slice(property.start, property.end).toLowerCase(), valueText = focused.role === 'value' ? text.slice(focused.start, focused.end) : undefined;
	for (let step = 1; step < ancestor.spans.length; step++) {
		const peerIndex = (currentIndex + direction * step + ancestor.spans.length) % ancestor.spans.length, peer = peerTag(ancestor.spans[peerIndex]);
		if (!peer) { continue; }
		const peerComponents = tagComponents(editor, { start: peer.openIdx, end: peer.closeIdx + peer.closeToken.length, active: true, role: 'structure' }), peerPropertyIndex = peerComponents.findIndex(component => component.role === 'property' && text.slice(component.start, component.end).toLowerCase() === key), peerValue = peerComponents.slice(peerPropertyIndex + 1).find(component => component.role === 'value'), peerComponent = focused.role === 'property' ? peerComponents[peerPropertyIndex] : focused.role === 'attribute' && peerPropertyIndex >= 0 ? { start: peerComponents[peerPropertyIndex].start, end: peerValue ? peerValue.end + ((text[peerValue.start - 1] === '"' || text[peerValue.start - 1] === "'") && text[peerValue.end] === text[peerValue.start - 1] ? 1 : 0) : peerComponents[peerPropertyIndex].end, active: true, role: 'attribute' as const, attributeName: key } : peerValue;
		if (!peerComponent || (valueText !== undefined && text.slice(peerComponent.start, peerComponent.end) !== valueText)) { continue; }
		const spans = focused.role === 'attribute' ? [...peerComponents, peerComponent] : peerComponents;
		applyStructuralSelectionMode(editor, { ...mode, spans, focused: spans.indexOf(peerComponent), ancestors: [...(mode.ancestors ?? []).slice(0, -1), { ...ancestor, focused: peerIndex }] });
		return true;
	}
	return false;
};
const cycleDerivedComponentPeerSelection = (editor: vscode.TextEditor, direction: 1 | -1): boolean => {
	const mode = structuralSelectionModes.get(editor), focused = mode?.spans[mode.focused];
	if (!mode || !focused || mode.stage !== 'components' || (focused.role !== 'property' && focused.role !== 'value' && focused.role !== 'attribute')) { return false; }
	index(editor.document);
	const shadow = states.get(keyOf(editor.document))!.shadow, text = editor.document.getText(), current = shadow.pairs.filter(pair => pair.type === 'tag' && pair.openIdx <= focused.start && focused.end <= pair.closeIdx + pair.closeToken.length).sort((left, right) => right.openIdx - left.openIdx)[0];
	if (!current) { return false; }
	const currentName = tagNameAt(text, current.openIdx)?.name, parent = shadow.pairs.filter(pair => pair.type === 'tag' && pair.openIdx < current.openIdx && current.closeIdx + current.closeToken.length < pair.closeIdx + pair.closeToken.length).sort((left, right) => right.openIdx - left.openIdx)[0], parentName = parent && tagNameAt(text, parent.openIdx)?.name;
	if (!currentName) { return false; }
	const peers = shadow.pairs.filter(pair => pair.type === 'tag' && tagNameAt(text, pair.openIdx)?.name === currentName).filter(pair => {
		const candidateParent = shadow.pairs.filter(parentPair => parentPair.type === 'tag' && parentPair.openIdx < pair.openIdx && pair.closeIdx + pair.closeToken.length < parentPair.closeIdx + parentPair.closeToken.length).sort((left, right) => right.openIdx - left.openIdx)[0];
		return tagNameAt(text, candidateParent?.openIdx ?? -1)?.name === parentName;
	}).sort((left, right) => left.openIdx - right.openIdx), currentIndex = peers.findIndex(peer => peer.openIdx === current.openIdx && peer.closeIdx === current.closeIdx);
	if (currentIndex < 0) { return false; }
	const currentComponents = tagComponents(editor, { start: current.openIdx, end: current.closeIdx + current.closeToken.length, active: true, role: 'structure' }), componentIndex = currentComponents.findIndex(component => component.role === focused.role && component.start === focused.start && component.end === focused.end), property = focused.role === 'attribute' ? currentComponents.find(component => component.role === 'property' && text.slice(component.start, component.end).toLowerCase() === focused.attributeName) : currentComponents.slice(0, componentIndex + 1).filter(component => component.role === 'property').at(-1);
	if (!property) { return false; }
	const key = text.slice(property.start, property.end).toLowerCase(), valueText = focused.role === 'value' ? text.slice(focused.start, focused.end) : undefined;
	for (let step = 1; step < peers.length; step++) {
		const peer = peers[(currentIndex + direction * step + peers.length) % peers.length], components = tagComponents(editor, { start: peer.openIdx, end: peer.closeIdx + peer.closeToken.length, active: true, role: 'structure' }), propertyIndex = components.findIndex(component => component.role === 'property' && text.slice(component.start, component.end).toLowerCase() === key), value = components.slice(propertyIndex + 1).find(candidate => candidate.role === 'value'), component = focused.role === 'property' ? components[propertyIndex] : focused.role === 'attribute' && propertyIndex >= 0 ? { start: components[propertyIndex].start, end: value ? value.end + ((text[value.start - 1] === '"' || text[value.start - 1] === "'") && text[value.end] === text[value.start - 1] ? 1 : 0) : components[propertyIndex].end, active: true, role: 'attribute' as const, attributeName: key } : value;
		if (!component || (valueText !== undefined && text.slice(component.start, component.end) !== valueText)) { continue; }
		const spans = focused.role === 'attribute' ? [...components, component] : components;
		applyStructuralSelectionMode(editor, { ...mode, spans, focused: spans.indexOf(component) });
		return true;
	}
	return false;
};
const cycleSiblingComponentSlotSelection = (editor: vscode.TextEditor, direction: 1 | -1): boolean => {
	const mode = structuralSelectionModes.get(editor), focused = mode?.spans[mode.focused], ancestor = mode?.ancestors?.at(-1);
	if (!mode || !focused || !ancestor || mode.stage !== 'components' || (focused.role !== 'property' && focused.role !== 'value')) { return false; }
	index(editor.document);
	const shadow = states.get(keyOf(editor.document))!.shadow, current = shadow.pairs.filter(pair => pair.type === 'tag' && pair.openIdx <= focused.start && focused.end <= pair.closeIdx + pair.closeToken.length).sort((left, right) => right.openIdx - left.openIdx)[0], currentIndex = ancestor.spans.findIndex(span => current && span.start <= current.openIdx && current.closeIdx + current.closeToken.length <= span.end);
	if (!current || currentIndex < 0) { return false; }
	const currentComponents = tagComponents(editor, { start: current.openIdx, end: current.closeIdx + current.closeToken.length, active: true, role: 'structure' }), slot = currentComponents.filter(component => component.role === focused.role).findIndex(component => component.start === focused.start && component.end === focused.end);
	if (slot < 0) { return false; }
	for (let step = 1; step < ancestor.spans.length; step++) {
		const peerIndex = (currentIndex + direction * step + ancestor.spans.length) % ancestor.spans.length, peerSpan = ancestor.spans[peerIndex], peer = shadow.pairs.find(pair => pair.type === 'tag' && pair.openIdx === peerSpan.start && pair.closeIdx + pair.closeToken.length === peerSpan.end);
		if (!peer) { continue; }
		const components = tagComponents(editor, { start: peer.openIdx, end: peer.closeIdx + peer.closeToken.length, active: true, role: 'structure' }), component = components.filter(candidate => candidate.role === focused.role)[slot];
		if (!component) { continue; }
		applyStructuralSelectionMode(editor, { ...mode, spans: components, focused: components.indexOf(component), ancestors: [...(mode.ancestors ?? []).slice(0, -1), { ...ancestor, focused: peerIndex }] });
		return true;
	}
	return false;
};
const descendFromComponentSelection = (editor: vscode.TextEditor): boolean => {
	const mode = structuralSelectionModes.get(editor), focused = mode?.spans[mode.focused];
	if (!mode || !focused || mode.stage !== 'components') { return false; }
	index(editor.document);
	const shadow = states.get(keyOf(editor.document))!.shadow, owner = shadow.pairs.filter(pair => pair.type === 'tag' && pair.openIdx <= focused.start && focused.end <= pair.closeIdx + pair.closeToken.length).sort((left, right) => right.openIdx - left.openIdx)[0];
	if (!owner) { return false; }
	const children = shadow.pairs.filter(pair => (pair.type === 'brace' || pair.type === 'tag') && owner.openIdx < pair.openIdx && pair.closeIdx + pair.closeToken.length < owner.closeIdx + owner.closeToken.length);
	const directChildren = children.filter(child => !children.some(parent => parent !== child && parent.openIdx < child.openIdx && child.closeIdx + child.closeToken.length < parent.closeIdx + parent.closeToken.length)).map(pair => ({ start: pair.openIdx, end: pair.closeIdx + pair.closeToken.length, active: true, role: 'structure' as const }));
	if (!directChildren.length) { return false; }
	applyStructuralSelectionMode(editor, { ...mode, ancestors: [...(mode.ancestors ?? []), levelOf(mode)], scope: { start: owner.openIdx, end: owner.closeIdx + owner.closeToken.length }, spans: directChildren, focused: 0, stage: 'structure' });
	return true;
};
const reverseComponentToAncestor = (editor: vscode.TextEditor): boolean => {
	const mode = structuralSelectionModes.get(editor), focused = mode?.spans[mode.focused], ancestor = mode?.ancestors?.at(-1);
	const firstProperty = mode?.spans.findIndex(span => span.role === 'property') ?? -1;
	if (!mode || !focused || !ancestor || mode.stage !== 'components' || focused.role !== 'property' || mode.focused !== firstProperty || ancestor.stage !== 'components' || !ancestor.spans.length) { return false; }
	applyStructuralSelectionMode(editor, restoreStructuralLevel(mode, { ...ancestor, focused: ancestor.spans.length - 1 }, mode.ancestors?.slice(0, -1) ?? []));
	return true;
};
const matchingPeerChildSpans = (shadow: ShadowStructure, text: string, parentSpans: readonly StructuralSelectionSpan[], focused: StructuralSelectionSpan): StructuralSelectionSpan[] => {
	const parent = shadow.pairs.find(pair => pair.type === 'tag' && pair.openIdx === focused.start && pair.closeIdx + pair.closeToken.length === focused.end), parentName = parent && tagNameAt(text, parent.openIdx)?.name;
	if (!parentName) { return []; }
	const peers = parentSpans.filter(span => span.active && span.highlighted !== false).map(span => shadow.pairs.find(pair => pair.type === 'tag' && pair.openIdx === span.start && pair.closeIdx + pair.closeToken.length === span.end)).filter((pair): pair is TokenPair => !!pair && tagNameAt(text, pair.openIdx)?.name === parentName);
	return peers.flatMap(peer => {
		const candidates = shadow.pairs.filter(candidate => (candidate.type === 'brace' || candidate.type === 'tag') && peer.openIdx < candidate.openIdx && candidate.closeIdx + candidate.closeToken.length < peer.closeIdx + peer.closeToken.length);
		return candidates.filter(candidate => !candidates.some(parentCandidate => parentCandidate !== candidate && parentCandidate.openIdx < candidate.openIdx && candidate.closeIdx + candidate.closeToken.length < parentCandidate.closeIdx + parentCandidate.closeToken.length)).map(candidate => ({ start: candidate.openIdx, end: candidate.closeIdx + candidate.closeToken.length, active: true, role: 'structure' as const }));
	});
};
const enterNextStructuralStage = (editor: vscode.TextEditor, preferComponents = true): boolean => {
	const mode = structuralSelectionModes.get(editor);
	if (!mode) { return false; }
	index(editor.document);
	const shadow = states.get(keyOf(editor.document))!.shadow, text = editor.document.getText(), activeSpans = mode.spans.filter(span => span.active);
	if (mode.stage === 'structure') {
		const focused = mode.spans[mode.focused], children = focused?.active ? matchingPeerChildSpans(shadow, text, mode.spans, focused) : [];
		const components = focused ? structuralComponents(editor, [focused]) : [];
		if (preferComponents && children.length && components.length) {
			const focusedComponent = Math.max(0, components.findIndex(component => component.role === 'property'));
			applyStructuralSelectionMode(editor, { ...mode, spans: components, focused: focusedComponent, stage: 'components' });
			return true;
		}
		if (children.length) {
			const focusedChild = focused ? children.findIndex(span => focused.start < span.start && span.end < focused.end) : -1;
			const ancestors = mode.spans.length > 1 ? [...(mode.ancestors ?? []), levelOf(mode)] : mode.ancestors;
			applyStructuralSelectionMode(editor, { ...mode, ancestors, scope: focused ? { start: focused.start, end: focused.end } : mode.scope, spans: children, focused: focusedChild < 0 ? 0 : focusedChild, stage: 'structure' });
			return true;
		}
		const inner: StructuralSelectionSpan[] = [];
		if (!inner.length) {
			const parent = focused && shadow.pairs.find(pair => pair.openIdx === focused.start && pair.closeIdx + pair.closeToken.length === focused.end);
			if (parent) { inner.push({ start: parent.openIdx + parent.openToken.length, end: parent.closeIdx, active: true, role: 'structure' }); }
		}
		if (!inner.length && mode.spans.length > 1) { applyStructuralSelectionMode(editor, { ...mode, focused: (mode.focused + 1) % mode.spans.length }); return true; }
		if (!inner.length) { return false; }
		const focusedInner = focused ? inner.findIndex(span => focused.start <= span.start && span.end <= focused.end) : -1;
		const ancestors = mode.spans.length > 1 ? [...(mode.ancestors ?? []), levelOf(mode)] : mode.ancestors;
		applyStructuralSelectionMode(editor, { ...mode, ancestors, scope: focused ? { start: focused.start, end: focused.end } : mode.scope, spans: inner, focused: focusedInner < 0 ? 0 : focusedInner, stage: 'inner' });
		return true;
	}
	if (mode.stage === 'inner') {
		const selectedOffset = editor.document.offsetAt(editor.selection.active), selectedParent = shadow.pairs.filter(pair => pair.type === 'tag' && pair.openIdx < selectedOffset && selectedOffset <= pair.closeIdx).sort((left, right) => right.openIdx - left.openIdx)[0], selectedInner = selectedParent && shadow.innerSelectionSpans(selectedParent.openIdx, selectedParent.closeIdx + selectedParent.closeToken.length).find(span => span.start <= selectedOffset && selectedOffset <= span.end), focusedSpan = selectedInner ? { ...selectedInner, active: true, role: 'structure' as const } : mode.spans[mode.focused], parent = focusedSpan && shadow.pairs.filter(pair => pair.openIdx < focusedSpan.start && pair.closeIdx + pair.closeToken.length >= focusedSpan.end).sort((left, right) => right.openIdx - left.openIdx)[0], parentSpans = parent ? [{ start: parent.openIdx, end: parent.closeIdx + parent.closeToken.length, active: true, role: 'structure' as const }] : [], components = focusedSpan ? [focusedSpan, ...structuralComponents(editor, parentSpans)] : [];
		if (!components.length) {
			if (mode.ancestors?.length) { return cycleInnerContentSelection(editor, 1); }
			if (focusedSpan) {
				const fallback = fallbackSiblingCycleAncestor(editor, focusedSpan);
				if (fallback) {
					applyStructuralSelectionMode(editor, { ...mode, ancestors: [...(mode.ancestors ?? []), fallback] });
					return cycleInnerContentSelection(editor, 1);
				}
			}
			return false;
		}
		const focused = Math.max(0, components.findIndex(component => component.role === 'property'));
		applyStructuralSelectionMode(editor, { ...mode, spans: components, focused: focused < 0 ? 0 : focused, stage: 'components' });
		return true;
	}
	if (mode.stage === 'components') {
		if (mode.spans.length > 1) {
			applyStructuralSelectionMode(editor, { ...mode, focused: (mode.focused + 1) % mode.spans.length });
			return true;
		}
		const before = snapshotSelections(editor);
		if (!climbStructuralSelection(editor)) { return false; }
		return selectionsMatch(before, snapshotSelections(editor)) ? climbStructuralSelection(editor) : true;
	}
	return true;
};
const changeStructuralStage = (editor: vscode.TextEditor, direction: 1 | -1): boolean => {
	const mode = structuralSelectionModes.get(editor);
	if (!mode) { return false; }
	if (mode.typing) { applyStructuralSelectionMode(editor, { ...mode, typing: false }); return true; }
	if (direction > 0) { return enterNextStructuralStage(editor); }
	if (mode.stage === 'components') {
		if (mode.spans.length > 1) {
			applyStructuralSelectionMode(editor, { ...mode, focused: (mode.focused - 1 + mode.spans.length) % mode.spans.length });
			return true;
		}
		const focused = mode.spans[mode.focused], parent = focused && states.get(keyOf(editor.document))!.shadow.pairs.find(pair => (pair.type === 'brace' || pair.type === 'tag') && pair.openIdx <= focused.start && pair.closeIdx + pair.closeToken.length >= focused.end), inner = parent ? [{ start: parent.openIdx + parent.openToken.length, end: parent.closeIdx, active: true, role: 'structure' as const }] : [];
		if (inner.length) { applyStructuralSelectionMode(editor, { ...mode, spans: inner, focused: 0, stage: 'inner' }); return true; }
		return false;
	}
	if (mode.stage === 'inner') {
		const focused = mode.spans[mode.focused], parent = focused && states.get(keyOf(editor.document))!.shadow.pairs.find(pair => pair.openIdx < focused.start && pair.closeIdx + pair.closeToken.length >= focused.end), structural = parent ? [{ start: parent.openIdx, end: parent.closeIdx + parent.closeToken.length, active: true, role: 'structure' as const }] : [];
		applyStructuralSelectionMode(editor, { ...mode, spans: structural, focused: 0, stage: 'structure' });
		return true;
	}
	if (mode.stage === 'structure') {
		const focused = mode.spans[mode.focused], components = focused ? structuralComponents(editor, [focused]) : [];
		if (components.length) { applyStructuralSelectionMode(editor, { ...mode, spans: components, focused: components.length - 1, stage: 'components' }); }
		return true;
	}
	return true;
};
const rebaseStructuralSelectionMode = (editor: vscode.TextEditor, change: vscode.TextDocumentContentChangeEvent, internal = false): void => {
	const mode = structuralSelectionModes.get(editor);
	if (!mode) { return; }
	editScopes.get(editor)?.rebase(change.rangeOffset, change.rangeLength, change.text.length);
	const delta = change.text.length - change.rangeLength, oldEnd = change.rangeOffset + change.rangeLength;
	const focused = mode.spans[mode.focused], typedInsideFocused = !internal && !!focused && change.text.length > 0 && (change.rangeOffset >= focused.start && oldEnd <= focused.end);
	if (typedInsideFocused && !mode.typing) {
		structuralSelectionModes.set(editor, { ...mode, typing: true });
		void vscode.commands.executeCommand('setContext', 'syntaxstitch.structuralSelectionTyping', true);
	}
	const spans = mode.spans.map((span, index) => {
		if (index === mode.focused && change.text.length > 0 && change.rangeOffset === span.end && change.rangeLength === 0) { return { ...span, end: span.end + change.text.length }; }
		if (span.start >= oldEnd) { return { ...span, start: span.start + delta, end: span.end + delta }; }
		if (span.end <= change.rangeOffset) { return span; }
		if (index === mode.focused && !change.text && span.start >= change.rangeOffset && span.end <= oldEnd) { return { ...span, start: change.rangeOffset, end: change.rangeOffset }; }
		return { ...span, end: Math.max(span.start, span.end + delta) };
	});
	const rebaseSpan = (span: SelectionSpan): SelectionSpan => span.start >= oldEnd ? { start: span.start + delta, end: span.end + delta } : span.end <= change.rangeOffset ? span : { start: span.start, end: Math.max(span.start, span.end + delta) };
	const rebaseStructuralSpan = (span: StructuralSelectionSpan): StructuralSelectionSpan => ({ ...span, ...rebaseSpan(span) });
	const ancestors = mode.ancestors?.map(level => ({ ...level, scope: rebaseSpan(level.scope), spans: level.spans.map(rebaseStructuralSpan) }));
	applyStructuralSelectionMode(editor, { ...mode, scope: rebaseSpan(mode.scope), spans, ancestors, typing: typedInsideFocused || mode.typing });
	if (typedInsideFocused) {
		const caret = editor.document.positionAt(change.rangeOffset + change.text.length);
		editor.selection = new vscode.Selection(caret, caret);
	}
};
const inEditScope = (editor: vscode.TextEditor, pair: TokenPair): boolean => editScopes.get(editor)?.contains(pair.openIdx, pair.closeIdx + pair.closeToken.length) ?? false;
const clearSelectionSession = (editor: vscode.TextEditor): void => {
	selectionSessions.delete(editor);
	pendingTagCarets.delete(editor);
	selectionHistory.delete(editor);
	lastSelections.delete(editor);
	structuralSelectionModes.delete(editor);
	editScopes.delete(editor);
	renderStructuralSelectionMode(editor, undefined);
	refreshNestedPreview(editor);
	if (editor === vscode.window.activeTextEditor) {
		void vscode.commands.executeCommand('setContext', 'syntaxstitch.structuralSelectionMode', false);
		void vscode.commands.executeCommand('setContext', 'syntaxstitch.structuralSelectionTyping', false);
	}
};
const cancelAutomaticEdits = (editor: vscode.TextEditor): void => {
	const key = keyOf(editor.document);
	pendingTagRenames.delete(key);
	pendingEdits.cancel(key);
	for (const candidate of [...selectionSessions.keys()]) { if (candidate.document === editor.document) { clearSelectionSession(candidate); } }
};
/** Preview and execution share this target resolver, including disabled peers. */
const componentEditPlan = (editor: vscode.TextEditor): { source: SelectionSpan; targets: SelectionSpan[] } | undefined => {
	const mode = structuralSelectionModes.get(editor), shadow = states.get(keyOf(editor.document))?.shadow;
	if (!mode || !shadow) { return; }
	const text = editor.document.getText();
	return planComponentEdit({ text, pairs: shadow.pairs, mode,
		contains: pair => inEditScope(editor, pair),
		tagName: pair => tagNameAt(text, pair.openIdx)?.name,
		componentsOf: pair => tagComponents(editor, { start: pair.openIdx, end: pair.closeIdx + pair.closeToken.length, active: true, role: 'structure' })
	});
};
const mirroredTargets = (editor: vscode.TextEditor): SelectionSpan[] => {
	if (!isEnabled(editor.document)) { return []; }
	const component = componentEditPlan(editor);
	if (component) { return component.targets; }
	const mode = structuralSelectionModes.get(editor), focused = mode?.spans[mode.focused], shadow = states.get(keyOf(editor.document))?.shadow;
	if (!mode || !focused || !shadow || mode.stage !== 'inner') { return []; }
	const parent = shadow.pairs.filter(pair => pair.type === 'tag' && pair.openIdx < focused.start && pair.closeIdx >= focused.end).sort((a, b) => b.openIdx - a.openIdx)[0];
	const ancestor = mode.ancestors?.at(-1), text = editor.document.getText();
	if (!parent || !ancestor) { return []; }
	return ancestor.spans.filter(span => span.active && span.highlighted !== false).flatMap(span => {
		const pair = shadow.pairs.find(pair => pair.type === 'tag' && pair.openIdx === span.start && pair.closeIdx + pair.closeToken.length === span.end);
		if (!pair || !inEditScope(editor, pair) || tagNameAt(text, pair.openIdx)?.name !== tagNameAt(text, parent.openIdx)?.name) { return []; }
		const inner = shadow.innerSelectionSpans(pair.openIdx, pair.closeIdx + pair.closeToken.length);
		return inner.length === 1 ? inner : [];
	});
};
const refreshNestedPreview = (editor: vscode.TextEditor): void => {
	const mode = structuralSelectionModes.get(editor);
	const targets = mode ? mirroredTargets(editor) : [];
	editor.setDecorations(targetDecoration, targets.map(span => new vscode.Range(editor.document.positionAt(span.start), editor.document.positionAt(span.end))));
	if (editor !== vscode.window.activeTextEditor) { return; }
	if (!mode) { nestedStatus.hide(); return; }
	const scope = editScopes.get(editor)?.kind ?? 'selection', label = scope === 'selection' ? 'original selection' : scope === 'enclosing' ? 'enclosing structure' : 'entire document';
	const pending = pendingFeedback.get(keyOf(editor.document));
	nestedStatus.text = pending ? `$(sync~spin) Updating ${pending.count} matches…` : `$(list-selection) Nested Select · ${targets.length ? `${targets.length} targets · ` : ''}${label}`;
	nestedStatus.tooltip = `${targets.length} matching edit targets in ${label}. Dashed outlines mark affected ranges. Click to change scope.\n${mode.typing ? 'Enter: finish typing · Escape: return to navigation' : 'Right/Left: enter/return · Up/Down: cycle peers · Tab: components · Escape: exit'}`;
	nestedStatus.accessibilityInformation = { label: nestedStatus.tooltip };
	nestedStatus.show();
};
type MirroredReplacement = SelectionSpan & { text: string };
const queueMirroredEdit = (editor: vscode.TextEditor, version: number): void => {
	const session = selectionSessions.get(editor), mode = structuralSelectionModes.get(editor), focused = mode?.spans[mode.focused];
	if (!session || !mode || !focused || !isEnabled(editor.document) || editor.document.version !== version) { return; }
	const document = editor.document, key = keyOf(document), text = document.getText(), plan = componentEditPlan(editor);
	const source = plan?.source ?? (mode.stage === 'inner' ? focused : undefined);
	if (!source) { return; }
	const sourceText = text.slice(source.start, source.end);
	// Attribute names must be complete names. Values may contain whitespace.
	if (focused.role === 'property' && !/^[A-Za-z_:][\w:.-]*$/.test(sourceText)) { return; }
	const replacements: MirroredReplacement[] = (plan?.targets ?? mirroredTargets(editor)).filter(target => target.start !== source.start).flatMap(target => {
		let replacement = sourceText;
		if (focused.role === 'value') {
			const quote = text[target.start - 1];
			if ((quote === '"' || quote === "'") && text[target.end] === quote) { replacement = sourceText.replaceAll(quote, quote === '"' ? '&quot;' : '&#39;'); }
			else if (!sourceText || /[\s<>"'`=]/.test(sourceText)) { replacement = `"${sourceText.replaceAll('"', '&quot;')}"`; }
		}
		return text.slice(target.start, target.end) === replacement ? [] : [{ ...target, text: replacement }];
	});
	if (!replacements.length) { return; }
	const valid = (): boolean => selectionSessions.get(editor) === session && document.version === version && documentHasOpenEditor(document) && isEnabled(document);
	const feedback = { count: replacements.length };
	pendingFeedback.set(key, feedback);
	refreshNestedPreview(editor);
	void pendingEdits.queue(key, { version, session, valid, apply: async () => {
		if (!valid()) { return false; }
		repairing.add(key);
		try {
			const applied = await editor.edit(builder => replacements.forEach(target => builder.replace(new vscode.Range(document.positionAt(target.start), document.positionAt(target.end)), target.text)), { undoStopBefore: false, undoStopAfter: false });
			if (applied && selectionSessions.get(editor) === session && document.version === version + 1 && focused.role === 'property') {
				const current = structuralSelectionModes.get(editor);
				if (current) {
					const originalName = focused.attributeName;
					const update = (span: StructuralSelectionSpan): StructuralSelectionSpan => span.attributeName === originalName ? { ...span, attributeName: sourceText.toLowerCase() } : span;
					structuralSelectionModes.set(editor, { ...current, spans: current.spans.map(update), ancestors: current.ancestors?.map(level => ({ ...level, spans: level.spans.map(update) })) });
				}
			}
			if (applied && selectionSessions.get(editor) === session) { refreshNestedPreview(editor); }
			return applied;
		} finally { repairing.delete(key); }
	} }, vscode.workspace.getConfiguration(CONFIG_SECTION, document.uri).get('mirroredEditDelayMs', 100)).then(applied => {
		if (pendingFeedback.get(key) !== feedback) { return; }
		pendingFeedback.delete(key);
		refreshNestedPreview(editor);
		if (!applied && !selectionSessions.has(editor) && documentHasOpenEditor(document)) {
			vscode.window.setStatusBarMessage('SyntaxStitch: pending matches cancelled because the document or selection changed.', 2500);
		}
	});
};
const finalizeUniqueHtmlIdPropagation = async (editor: vscode.TextEditor, mode: StructuralSelectionMode): Promise<void> => {
	if (!documentHasOpenEditor(editor.document) || !isEnabled(editor.document)) { return; }
	const focused = mode.spans[mode.focused];
	if (editor.document.languageId !== 'html' || focused?.role !== 'value') { return; }
	index(editor.document);
	const text = editor.document.getText(), shadow = states.get(keyOf(editor.document))!.shadow, target = focused.start, pair = shadow.pairs.filter(candidate => candidate.type === 'tag').find(candidate => candidate.openIdx <= target && target < candidate.closeIdx + candidate.closeToken.length);
	if (!pair) { return; }
	const name = tagNameAt(text, pair.openIdx)?.name;
	if (!name) { return; }
	const components = tagComponents(editor, { start: pair.openIdx, end: pair.closeIdx + pair.closeToken.length, active: true, role: 'structure' as const }), valueIndex = components.findIndex(component => component.role === 'value' && component.start <= target && target <= component.end);
	if (valueIndex < 0) { return; }
	const sourceProperty = components[valueIndex - 1];
	if (sourceProperty?.role !== 'property' || text.slice(sourceProperty.start, sourceProperty.end).toLowerCase() !== 'id') { return; }
	const disabledStructures = [mode, ...(mode.ancestors ?? [])].flatMap(level => level.spans).filter(span => span.role === 'structure' && span.highlighted === false), isDisabled = (candidate: TokenPair): boolean => disabledStructures.some(span => span.start === candidate.openIdx && span.end === candidate.closeIdx + candidate.closeToken.length);
	const source = text.slice(components[valueIndex].start, components[valueIndex].end), participants = shadow.pairs.filter(candidate => candidate.type === 'tag' && !isDisabled(candidate) && inEditScope(editor, candidate) && tagNameAt(text, candidate.openIdx)?.name === name).sort((left, right) => left.openIdx - right.openIdx).flatMap(candidate => {
		const peers = tagComponents(editor, { start: candidate.openIdx, end: candidate.closeIdx + candidate.closeToken.length, active: true, role: 'structure' as const }), propertyIndex = peers.findIndex(component => component.role === 'property' && text.slice(component.start, component.end).toLowerCase() === 'id'), value = propertyIndex >= 0 ? peers[propertyIndex + 1] : undefined;
		return value?.role === 'value' ? [value] : [];
	});
	if (participants.length < 2 || !source || /\s/.test(decodeAttribute(source))) { return; }
	const participantStarts = new Set(participants.map(participant => participant.start));
	const reserved = new Set(markupTags(text).flatMap(tag => tag.attributes.flatMap(attribute => attribute.name === 'id' && attribute.value && !participantStarts.has(attribute.value.start) ? [decodeAttribute(text.slice(attribute.value.start, attribute.value.end))] : [])));
	const ids = numberedIds(decodeAttribute(source), participants.length, reserved).map(id => id.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'));
	repairing.add(keyOf(editor.document));
	try { await editor.edit(builder => participants.forEach((participant, index) => builder.replace(new vscode.Range(editor.document.positionAt(participant.start), editor.document.positionAt(participant.end)), ids[index])), { undoStopBefore: false, undoStopAfter: false }); }
	finally { repairing.delete(keyOf(editor.document)); }
};

const keyOf = (document: vscode.TextDocument): string => document.uri.toString();
const awaitPendingReconciliation = async (document: vscode.TextDocument): Promise<void> => {
	const key = keyOf(document), deadline = Date.now() + SAVE_DRAIN_TIMEOUT_MS;
	while (states.has(key) && (observedDocumentVersions.get(key) ?? -1) < document.version && Date.now() < deadline) {
		await (pendingReconciliations.get(key) ?? new Promise<void>(resolve => setTimeout(resolve, 0)));
	}
	await pendingReconciliations.get(key);
};
const tagNameRange = (token: string, tokenStart: number): { start: number; end: number } | undefined => {
	const match = token.match(/^<\s*\/?\s*([A-Za-z][\w:.-]*)/), name = match?.[1];
	if (!match || !name) { return undefined; }
	const start = tokenStart + match[0].lastIndexOf(name);
	return { start, end: start + name.length };
};
const tagNameAt = (text: string, tokenStart: number): { name: string; start: number; end: number } | undefined => {
	const tag = parseTagAt(text, tokenStart);
	return tag && tag.name !== '#fragment' ? { name: text.slice(tag.nameStart, tag.nameEnd), start: tag.nameStart, end: tag.nameEnd } : undefined;
};
const enabledSetting = (uri?: vscode.Uri): boolean => vscode.workspace.getConfiguration(CONFIG_SECTION, uri).get('enabled', true);
const isEnabled = (document: vscode.TextDocument): boolean => {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION, document.uri), languages = config.get<string[]>('languages', []);
	const withinLimit = Buffer.byteLength(document.getText(), 'utf8') <= config.get('maxFileSizeKB', 2048) * BYTES_PER_KIBIBYTE;
	return enabledSetting(document.uri) && !pausedDocuments.has(keyOf(document)) && withinLimit && ['file', 'untitled', 'vscode-notebook-cell'].includes(document.uri.scheme) && (!languages.length || languages.includes(document.languageId));
};
const index = (document: vscode.TextDocument): void => {
	const key = keyOf(document), current = states.get(key);
	if (current?.languageId === document.languageId) {
		if (current.version !== document.version) { current.shadow.reindex(document.getText(), document.languageId); current.version = document.version; }
		return;
	}
	states.set(key, { shadow: new ShadowStructure(document.getText(), document.languageId), languageId: document.languageId, version: document.version });
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
		return actual === expected ? [] : [{ offset: document.offsetAt(new vscode.Position(close.line, 0)), deleteLength: actual.length, text: expected, pairId: pair.id, side: 'close' as const, blockType: 'indent' as const, kind: 'indent' as const, rule: 'align-closing-indent' }];
	});
};
const refreshStatus = (status: vscode.StatusBarItem, counter: RepairCounter): void => {
	const presentation = repairStatusPresentation(counter.statistics, enabledSetting(vscode.window.activeTextEditor?.document.uri));
	const key = vscode.window.activeTextEditor?.document.uri.toString();
	const override = key && (pausedDocuments.has(key) ? 'Paused for this file' : skippedEdits.has(key) ? 'Next edit will be left unchanged' : undefined);
	status.text = override ? `{S} ${pausedDocuments.has(key!) ? 'Paused' : 'Skip next edit'}` : presentation.text;
	status.tooltip = override ? `${override}. Click for actions.` : presentation.tooltip;
	status.accessibilityInformation = { label: override ?? presentation.accessibilityLabel };
};
const repairDescription = (document: vscode.TextDocument, patches: readonly RepairPatch[], pairs: readonly TokenPair[]): string => {
	const patch = patches[0], owner = pairs.find(pair => pair.id === patch.pairId), line = document.positionAt(Math.min(patch.offset, document.getText().length)).line + 1;
	const action = patch.text && patch.deleteLength ? 'Replaced' : patch.text ? 'Restored' : 'Removed', token = patch.text || (patch.kind === 'indent' ? 'indentation' : owner ? `${owner.openToken}${owner.closeToken}` : patch.kind);
	return `${action} ${JSON.stringify(token)} · ${owner?.languageId ?? document.languageId} · line ${line}${patches.length > 1 ? ` · ${patches.length} changes` : ''}`;
};
const statusFlashTimers = new WeakMap<vscode.StatusBarItem, ReturnType<typeof setTimeout>>();
const flashStatus = (status: vscode.StatusBarItem): void => {
	const previous = statusFlashTimers.get(status);
	if (previous) { clearTimeout(previous); }
	status.text = animatedRepairStatusText(status.text);
	status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
	status.color = new vscode.ThemeColor('statusBarItem.warningForeground');
	statusFlashTimers.set(status, setTimeout(() => {
		if (status.text.startsWith(STATUS_ACTIVITY_PREFIX)) { status.text = status.text.slice(STATUS_ACTIVITY_PREFIX.length); }
		status.backgroundColor = undefined;
		status.color = undefined;
		statusFlashTimers.delete(status);
	}, 500));
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
const tagTokenEnd = (text: string, start: number): number => parseTagAt(text, start)?.end ?? start;
const placePendingTagCaret = (editor: vscode.TextEditor): void => {
	if (!documentHasOpenEditor(editor.document)) { pendingTagCarets.delete(editor); return; }
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
type ProtectedBoundaryIntent = { deletion: DirectDeletion; pairId: string; blockType: BlockType; side: 'open' | 'close'; selectionKind: 'pair' | 'token' };
type TagContentSelection = { start: number; length: number };
const protectedBoundaryIntent = (event: vscode.TextDocumentChangeEvent, patches: readonly RepairPatch[]): ProtectedBoundaryIntent | undefined => {
	const change = event.contentChanges[0], deletion = directDeletions.get(keyOf(event.document)), editor = deletion?.editor;
	if (!editor || !deletion || editor.document !== event.document || event.contentChanges.length !== 1 || !change || change.text || change.rangeLength !== 1) { return undefined; }
	const expectedOffset = deletion.direction === 'left' ? change.rangeOffset + change.rangeLength : change.rangeOffset;
	if (deletion.offset !== expectedOffset) { return undefined; }
	const patch = patches.find(candidate => candidate.text && (candidate.blockType === 'brace' || candidate.blockType === 'tag' || candidate.blockType === 'quote') && (candidate.side === 'open' || candidate.side === 'close'));
	if (patch) { directDeletions.delete(keyOf(event.document)); }
	const selectionKind = patch?.selectionKind ?? 'pair';
	return patch ? { deletion, pairId: patch.pairId, blockType: patch.blockType, side: patch.side, selectionKind } : undefined;
};
const reconcile = async (event: vscode.TextDocumentChangeEvent, output: vscode.OutputChannel, counter: RepairCounter, status: vscode.StatusBarItem): Promise<void> => {
	const document = event.document, key = keyOf(document);
	if (!isEnabled(document)) { states.delete(key); return; }
	if (!documentHasOpenEditor(document)) { states.delete(key); pendingTagRenames.delete(key); return; }
	if (repairing.has(key) || !event.contentChanges.length) { index(document); return; }
	const state = states.get(key);
	if (!state || state.languageId !== document.languageId) { index(document); return; }
	const pendingRename = pendingTagRenames.get(key), change = event.contentChanges.length === 1 ? event.contentChanges[0] : undefined;
	const editor = vscode.window.visibleTextEditors.find(candidate => candidate.document === document), mode = editor && structuralSelectionModes.get(editor), focused = mode?.spans[mode.focused];
	if (mode?.typing && focused && change && change.rangeOffset >= focused.start && change.rangeOffset <= focused.end) { index(document); return; }
	const preliminaryStructural = change ? state.shadow.planRepairs(event.contentChanges, document.getText()) : [], partialTagBoundary = preliminaryStructural.some(patch => patch.blockType === 'tag' && patch.selectionKind === 'token');
	if (partialTagBoundary) { pendingTagRenames.delete(key); }
	if (pendingRename && change && !partialTagBoundary) {
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
	if (event.contentChanges.length && !partialTagBoundary) {
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
	const structures = vscode.workspace.getConfiguration(CONFIG_SECTION, document.uri).get<StructureSetting[]>('structures', ['brace', 'tag', 'quote', 'indent']);
	const structural = preliminaryStructural.filter(patch => patch.blockType === 'brace' ? structures.includes('brace') || structures.includes(patch.kind) : structures.includes(patch.blockType));
	const providerDuplicate = partialTagBoundary && change && !change.text ? (() => {
		const pair = state.shadow.pairs.find(candidate => candidate.type === 'tag' && candidate.openIdx + candidate.openToken.length - 1 === change.rangeOffset);
		if (!pair || pair.openToken.startsWith('</')) { return undefined; }
		const text = document.getText(), searchStart = pair.openIdx + pair.openToken.length - 1, first = text.indexOf(pair.closeToken, searchStart), second = first < 0 ? -1 : text.indexOf(pair.closeToken, first + pair.closeToken.length);
		return first >= searchStart && second >= 0 ? { offset: first, deleteLength: pair.closeToken.length, text: '', pairId: pair.id, side: 'close' as const, blockType: 'tag' as const, kind: 'tag' as const, rule: 'remove-provider-duplicate-tag' } : undefined;
	})() : undefined;
	const resultingTagPairs = new ShadowStructure(document.getText(), document.languageId).pairs.filter(pair => pair.type === 'tag');
	const plannedPatches = [...structural, ...(providerDuplicate ? [providerDuplicate] : []), ...planClosingIndentRepairs(document, event.contentChanges)]
		.filter(patch => patch.rule !== 'restore-closer' || !resultingTagPairs.some(pair => pair.closeIdx === patch.offset && pair.closeToken === patch.text))
		.sort((left, right) => right.offset - left.offset);
	if (!plannedPatches.length) { index(document); return; }
	const boundaryIntent = protectedBoundaryIntent(event, plannedPatches), directChange = event.contentChanges[0];
	const tagContentSelection: TagContentSelection | undefined = event.contentChanges.length === 1 && !directChange.text ? (() => {
		const pair = state.shadow.pairs.find(candidate => candidate.type === 'tag' && [
			{ start: candidate.openIdx, length: candidate.openToken.length },
			{ start: candidate.closeIdx, length: candidate.closeToken.length },
		].some(boundary => boundary.start === directChange.rangeOffset && boundary.length === directChange.rangeLength));
		const counterpartRepair = pair && plannedPatches.find(patch => patch.pairId === pair.id && patch.blockType === 'tag' && !patch.text);
		if (!pair || !counterpartRepair) { return undefined; }
		const endingTag = state.shadow.pairs.find(candidate => candidate.type === 'tag' && candidate.openIdx > pair.openIdx && candidate.closeIdx + candidate.closeToken.length === pair.closeIdx);
		if (endingTag) { return { start: endingTag.closeIdx - pair.openToken.length, length: endingTag.closeToken.length }; }
		return { start: pair.openIdx, length: pair.closeIdx - pair.openIdx - pair.openToken.length };
	})() : undefined;
	const patches = boundaryIntent?.blockType === 'brace' && boundaryIntent.side === 'close' ? plannedPatches.map(patch => patch.pairId === boundaryIntent.pairId ? { ...patch, offset: directChange.rangeOffset, deleteLength: 0, text: patch.text.at(-1) ?? patch.text } : patch) : plannedPatches;

	const edit = new vscode.WorkspaceEdit();
	for (const patch of patches) { edit.replace(document.uri, patchRange(document, patch), patch.text); }
	repairing.add(key);
	let applied = false;
	try {
		applied = await vscode.workspace.applyEdit(edit);
		repairing.delete(key);
		const documentOpen = vscode.workspace.textDocuments.includes(document), documentVisible = vscode.window.visibleTextEditors.some(editor => editor.document === document), windowFocused = vscode.window.state.focused;
		const source: RepairSource = directDeletions.has(key) && documentOpen && documentVisible && windowFocused ? 'direct' : 'indirect';
		if (applied) { repairHistory.record(document, patches, state.shadow.pairs); }
		const countedRepairs = applied ? await counter.record(patches, document.uri, repairDescription(document, patches, state.shadow.pairs), source) : 0;
		if (countedRepairs) {
			refreshStatus(status, counter);
			if (vscode.workspace.getConfiguration(CONFIG_SECTION, document.uri).get('flashStatus', true)) { flashStatus(status); }
		}
		log(output, document.uri, 'repairs', { type: 'syntaxstitch/reconciled', uri: document.uri.toString(), version: document.version, applied, source, documentOpen, documentVisible, windowFocused, countedRepairs, suppressedRepeats: applied ? patches.length - countedRepairs : 0, repairs: patches });
		if (!applied) { log(output, document.uri, 'repairs', { type: 'syntaxstitch/error', uri: document.uri.toString(), reason: 'workspace-edit-rejected' }); }
	} catch (error) {
		log(output, document.uri, 'repairs', { type: 'syntaxstitch/error', uri: document.uri.toString(), reason: error instanceof Error ? error.message : String(error) });
	} finally {
		repairing.delete(key);
		index(document);
		const shadow = states.get(key)?.shadow, restored = applied && boundaryIntent ? shadow?.pairs.find(pair => pair.id === boundaryIntent.pairId) : undefined;
		if (restored && boundaryIntent) {
			const start = boundaryIntent.selectionKind === 'token' && boundaryIntent.side === 'close' ? restored.closeIdx : restored.openIdx;
			const token = boundaryIntent.side === 'close' ? restored.closeToken : restored.openToken;
			const end = boundaryIntent.selectionKind === 'token' ? start + token.length : restored.closeIdx + restored.closeToken.length;
			boundaryIntent.deletion.selection = new vscode.Selection(document.positionAt(start), document.positionAt(end));
		}
		if (applied && tagContentSelection) {
			const editor = vscode.window.visibleTextEditors.find(candidate => candidate.document === document);
			if (editor) { editor.selection = new vscode.Selection(document.positionAt(tagContentSelection.start), document.positionAt(tagContentSelection.start + tagContentSelection.length)); }
		}
	}
};
// endregion

// region Lifecycle
export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel(OUTPUT_NAME, { log: true });
	const status = vscode.window.createStatusBarItem('syntaxstitch.status', vscode.StatusBarAlignment.Right, 100);
	nestedStatus = vscode.window.createStatusBarItem('syntaxstitch.nestedSelect', vscode.StatusBarAlignment.Right, 99);
	nestedStatus.name = 'SyntaxStitch Nested Select';
	nestedStatus.command = 'syntaxstitch.chooseMirroringScope';
	targetDecoration = vscode.window.createTextEditorDecorationType({ border: '1px dashed', borderColor: new vscode.ThemeColor('editor.findMatchHighlightBorder'), overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.findMatchForeground'), overviewRulerLane: vscode.OverviewRulerLane.Right });
	structuralSelectionDecoration = vscode.window.createTextEditorDecorationType({ backgroundColor: new vscode.ThemeColor('editor.wordHighlightBackground'), border: '1px solid ' + new vscode.ThemeColor('editor.wordHighlightBorder').id, overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.wordHighlightForeground'), overviewRulerLane: vscode.OverviewRulerLane.Center });
	structuralSelectionFocusedDecoration = vscode.window.createTextEditorDecorationType({ backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'), border: '2px solid ' + new vscode.ThemeColor('editor.findMatchBorder').id, overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.findMatchForeground'), overviewRulerLane: vscode.OverviewRulerLane.Center });
	structuralSelectionInactiveDecoration = vscode.window.createTextEditorDecorationType({ backgroundColor: '#ef444433', border: '1px solid #ef4444', opacity: '0.75', overviewRulerColor: '#ef4444', overviewRulerLane: vscode.OverviewRulerLane.Center });
	structuralSelectionFocusedInactiveDecoration = vscode.window.createTextEditorDecorationType({ backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground'), border: '2px dashed ' + new vscode.ThemeColor('editorWarning.foreground'), opacity: '0.95', overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.warningForeground'), overviewRulerLane: vscode.OverviewRulerLane.Center });
	structuralSelectionComponentDecoration = vscode.window.createTextEditorDecorationType({ backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground'), border: '1px solid ' + new vscode.ThemeColor('editorLink.activeForeground').id });
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
	vscode.workspace.textDocuments.filter(isEnabled).forEach(document => { index(document); observedDocumentVersions.set(keyOf(document), document.version); });
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
		{ dispose: () => { pendingEdits.cancelAll(); selectionSessions.clear(); } },
		output,
		status,
		nestedStatus,
		targetDecoration,
		structuralSelectionDecoration,
		structuralSelectionFocusedDecoration,
		structuralSelectionInactiveDecoration,
		structuralSelectionFocusedInactiveDecoration,
		structuralSelectionComponentDecoration,
		pairLabelsChanged,
		vscode.languages.registerInlayHintsProvider([{ scheme: 'file' }, { scheme: 'untitled' }, { scheme: 'vscode-notebook-cell' }], { onDidChangeInlayHints: pairLabelsChanged.event, provideInlayHints: pairLabelHints }),
		vscode.workspace.onDidOpenTextDocument(document => { if (isEnabled(document)) { index(document); observedDocumentVersions.set(keyOf(document), document.version); refreshLabels(); } }),
		vscode.workspace.onWillSaveTextDocument(event => {
			const key = keyOf(event.document);
			event.waitUntil((async () => {
				await awaitPendingReconciliation(event.document);
				savingDocuments.add(key);
				if (pendingEdits.has(key)) { await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'SyntaxStitch: Finishing mirrored edits before save' }, () => pendingEdits.flush(key)); }
				for (const editor of [...selectionSessions.keys()]) {
					if (editor.document === event.document) { clearSelectionSession(editor); }
				}
				return [];
			})().finally(() => savingDocuments.delete(key)));
		}),
		vscode.workspace.onDidCloseTextDocument(document => {
			const key = keyOf(document);
			states.delete(key);
			observedDocumentVersions.delete(key);
			pendingEdits.cancel(key);
			for (const editor of [...selectionSessions.keys()]) { if (editor.document === document) { selectionSessions.delete(editor); } }
			pausedDocuments.delete(key);
			skippedEdits.delete(key);
			pendingTagRenames.delete(key);
			directDeletions.get(key)?.complete();
			directDeletions.delete(key);
		}),
		vscode.window.tabGroups.onDidChangeTabs(() => {
			for (const editor of [...selectionSessions.keys()]) {
				if (!documentHasOpenEditor(editor.document)) { pendingEdits.cancel(keyOf(editor.document)); clearSelectionSession(editor); }
			}
		}),
		vscode.workspace.onDidChangeTextDocument(event => {
			const key = keyOf(event.document), deletion = directDeletions.get(key), version = event.document.version, internal = repairing.has(key);
			observedDocumentVersions.set(key, version);
			if (!internal && event.contentChanges.length) { pendingEdits.cancel(key); }
			// Explicit bypasses and undo/redo are authoritative, like disk reloads.
			// Cancel queued edits before reindexing so they cannot replay the change.
			const bypass = !repairing.has(key) && event.contentChanges.length > 0 && (skippedEdits.delete(key) || pausedDocuments.has(key));
			if (event.contentChanges.length && (bypass || (!event.document.isDirty && !savingDocuments.has(key)) || event.reason === vscode.TextDocumentChangeReason.Undo || event.reason === vscode.TextDocumentChangeReason.Redo)) {
				pendingTagRenames.delete(key);
				directDeletions.delete(key);
				deletion?.complete();
				pendingEdits.cancel(key);
				for (const editor of [...selectionSessions.keys()]) { if (editor.document === event.document) { clearSelectionSession(editor); } }
				if (isEnabled(event.document)) { index(event.document); } else { states.delete(key); }
				refreshLabels();
				refreshStatus(status, counter);
				if (vscode.window.activeTextEditor) { refreshNestedPreview(vscode.window.activeTextEditor); }
				return;
			}
			// The active editor owns a user edit; another pane must never donate its selection.
			const editor = vscode.window.activeTextEditor?.document === event.document ? vscode.window.activeTextEditor : undefined;
			const mode = editor && structuralSelectionModes.get(editor), focused = mode?.spans[mode.focused], change = event.contentChanges.length === 1 ? event.contentChanges[0] : undefined;
			const mirror = !internal && !!focused && !!change && change.rangeOffset >= focused.start && change.rangeOffset + change.rangeLength <= focused.end;
			if (!internal && event.contentChanges.length) {
				for (const candidate of [...selectionSessions.keys()]) {
					if (candidate.document === event.document && (candidate !== editor || !mirror)) { clearSelectionSession(candidate); }
				}
			}
			for (const candidate of selectionSessions.keys()) {
				if (candidate.document === event.document) { for (const edit of [...event.contentChanges].sort((a, b) => b.rangeOffset - a.rangeOffset)) { rebaseStructuralSelectionMode(candidate, edit, internal); } }
			}
			const reconciliation = reconcile(event, output, counter, status).finally(() => {
				if (mirror && editor && event.document.version === version) { queueMirroredEdit(editor, version); }
				if (deletion && directDeletions.get(key) === deletion) { directDeletions.delete(key); }
				deletion?.complete();
				captureTagCaret(event);
				refreshLabels();
				if (editor) { refreshNestedPreview(editor); }
			});
			pendingReconciliations.set(key, reconciliation);
			void reconciliation.finally(() => { if (pendingReconciliations.get(key) === reconciliation) { pendingReconciliations.delete(key); } });
		}),
		vscode.window.onDidChangeActiveTextEditor(editor => {
			if (editor && isEnabled(editor.document)) { index(editor.document); }
			refreshStatus(status, counter);
			refreshLabels();
			if (editor) { refreshNestedPreview(editor); } else { nestedStatus.hide(); }
			void vscode.commands.executeCommand('setContext', 'syntaxstitch.structuralSelectionMode', !!editor && structuralSelectionModes.has(editor));
			void vscode.commands.executeCommand('setContext', 'syntaxstitch.structuralSelectionTyping', !!editor && !!structuralSelectionModes.get(editor)?.typing);
		}),
		vscode.window.onDidChangeVisibleTextEditors(editors => { editors.filter(editor => isEnabled(editor.document)).forEach(editor => index(editor.document)); refreshLabels(); }),
		vscode.window.onDidChangeTextEditorSelection(event => {
			const editor = event.textEditor, current = snapshotSelections(editor), previous = lastSelections.get(editor);
			lastSelections.set(editor, current);
			if (!structuralSelectionModes.get(editor)?.typing) { balanceForwardSelection(editor, previous, current); }
			if (lastSelections.get(editor) !== current) { lastSelections.set(editor, snapshotSelections(editor)); }
			placePendingTagCaret(editor);
			refreshLabels();
		}),
		vscode.workspace.onDidChangeConfiguration(event => {
			if (!event.affectsConfiguration(CONFIG_SECTION)) { return; }
			pendingEdits.cancelAll();
			for (const editor of [...selectionSessions.keys()]) { if (!isEnabled(editor.document)) { clearSelectionSession(editor); } }
			states.clear();
			vscode.workspace.textDocuments.filter(isEnabled).forEach(index);
			refreshStatus(status, counter);
			refreshLabels();
		}),
		vscode.commands.registerCommand('syntaxstitch.showMenu', async () => {
			const enabled = enabledSetting(vscode.window.activeTextEditor?.document.uri);
			const selected = await vscode.window.showQuickPick([
				{ label: enabled ? '$(circle-slash) Disable SyntaxStitch' : '$(shield) Enable SyntaxStitch', command: 'syntaxstitch.toggle' },
				{ label: '$(debug-pause) Pause / Resume This File', command: 'syntaxstitch.toggleFilePause' },
				{ label: '$(debug-step-over) Skip Next Edit / Cancel Skip', command: 'syntaxstitch.skipNextRepair' },
				{ label: '$(list-selection) Choose Mirrored Edit Scope', command: 'syntaxstitch.chooseMirroringScope' },
				{ label: '$(history) Recent Repairs', command: 'syntaxstitch.showRecentRepairs' },
				{ label: '$(gear) Open Settings', command: 'syntaxstitch.openSettings' },
				{ label: '$(selection) Enter Nested Select', description: 'Ctrl+Alt+S / Cmd+Option+S', command: 'syntaxstitch.enterStructuralSelectionMode' },
				{ label: '$(selection) Select Matching Structure', command: 'syntaxstitch.selectMatchingStructure' },
				{ label: '$(fold-down) Select Inner Structure', command: 'syntaxstitch.selectInnerStructure' },
				{ label: '$(symbol-key) Configure Pair Labels', command: 'syntaxstitch.configurePairLabels' },
				{ label: '$(graph) View Repair Statistics', command: 'syntaxstitch.showStatistics' },
				{ label: '$(discard) Reset Repair Count', command: 'syntaxstitch.resetStatistics' },
				{ label: '$(book) Nested Select Tutorial', description: 'Open a selected example with instructions', command: 'syntaxstitch.openPractice' },
				{ label: '$(output) Show Reconciliation Output', command: 'syntaxstitch.showOutput' },
				{ label: '$(refresh) Rebuild Shadow Index', command: 'syntaxstitch.rebuildShadowIndex' },
			], { placeHolder: `SyntaxStitch: ${counter.statistics.total} repairs recorded` });
			if (selected) { await vscode.commands.executeCommand(selected.command); }
		}),
		vscode.commands.registerCommand('syntaxstitch.toggleFilePause', () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) { return false; }
			const key = keyOf(editor.document);
			if (pausedDocuments.has(key)) { pausedDocuments.delete(key); index(editor.document); }
			else { pausedDocuments.add(key); cancelAutomaticEdits(editor); }
			refreshStatus(status, counter); refreshLabels(); refreshNestedPreview(editor);
			return pausedDocuments.has(key);
		}),
		vscode.commands.registerCommand('syntaxstitch.skipNextRepair', () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) { return false; }
			const key = keyOf(editor.document);
			if (skippedEdits.has(key)) { skippedEdits.delete(key); }
			else { skippedEdits.add(key); cancelAutomaticEdits(editor); }
			refreshStatus(status, counter);
			return skippedEdits.has(key);
		}),
		vscode.commands.registerCommand('syntaxstitch.chooseMirroringScope', async (requested?: MirroringScope) => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) { return; }
			const scope = editScopes.get(editor);
			if (!scope || !structuralSelectionModes.has(editor)) { void vscode.window.showInformationMessage('Enter Nested Select with a highlighted region first.'); return; }
			const choices = [{ label: 'Original selection', scope: 'selection' as const }, { label: 'Enclosing structure', scope: 'enclosing' as const }, { label: 'Entire document', scope: 'document' as const }];
			const selected = requested ? choices.find(choice => choice.scope === requested) : await vscode.window.showQuickPick(choices, { placeHolder: 'Choose where matching edits may apply' });
			if (selected && structuralSelectionModes.has(editor)) { pendingEdits.cancel(keyOf(editor.document)); scope.kind = selected.scope; refreshNestedPreview(editor); }
		}),
		vscode.commands.registerCommand('syntaxstitch.showRecentRepairs', () => repairHistory.show()),
		vscode.commands.registerCommand('syntaxstitch.clearRecentRepairs', () => repairHistory.clear()),
		vscode.commands.registerCommand('syntaxstitch.openPractice', () => openPractice()),
		vscode.commands.registerCommand('syntaxstitch.inspectMirroredEdits', () => {
			const editor = vscode.window.activeTextEditor;
			return editor ? { scope: editScopes.get(editor)?.kind, targets: mirroredTargets(editor) } : undefined;
		}),
		vscode.commands.registerCommand('syntaxstitch.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:BrockNash.syntaxstitch')),
		vscode.commands.registerCommand('syntaxstitch.enterStructuralSelectionMode', () => enterStructuralSelectionMode(vscode.window.activeTextEditor!)),
		vscode.commands.registerCommand('syntaxstitch.exitStructuralSelectionTyping', async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) { return false; }
			// Finish mirrored edits before leaving typing mode so their offsets are rebased only once.
			await pendingEdits.flush(keyOf(editor.document));
			if (!documentHasOpenEditor(editor.document)) { return false; }
			const mode = structuralSelectionModes.get(editor);
			if (!mode) { return false; }
			const focused = mode.spans[mode.focused], caret = editor.document.offsetAt(editor.selection.active), spans = focused && mode.typing && editor.selection.isEmpty && caret >= focused.end
				? mode.spans.map((span, index) => index === mode.focused ? { ...span, end: caret } : span)
				: mode.spans;
			const nextMode = { ...mode, spans, typing: false };
			applyStructuralSelectionMode(editor, nextMode);
			await finalizeUniqueHtmlIdPropagation(editor, nextMode);
			return true;
		}),
		vscode.commands.registerCommand('syntaxstitch.exitStructuralSelectionMode', () => exitStructuralSelectionMode(vscode.window.activeTextEditor!)),
		vscode.commands.registerCommand('syntaxstitch.structuralSelectionEnter', () => activateStructuralSelection(vscode.window.activeTextEditor!)),
		vscode.commands.registerCommand('syntaxstitch.structuralSelectionDrillDown', () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) { return false; }
			if (cyclePeerComponentSelection(editor, 1) || cycleDerivedComponentPeerSelection(editor, 1) || cycleSiblingComponentSlotSelection(editor, 1)) { return true; }
			if (structuralSelectionModes.get(editor)?.stage === 'inner' && cycleInnerContentSelection(editor, 1)) { return true; }
			if (structuralSelectionModes.get(editor)?.stage === 'components') { return true; }
			return cycleStructuralPeerSelection(editor, 1) || cycleDerivedNestedPeerSelection(editor, 1) || enterNextStructuralStage(editor, false);
		}),
		vscode.commands.registerCommand('syntaxstitch.structuralSelectionDrillUp', () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) { return false; }
			if (cyclePeerComponentSelection(editor, -1) || cycleDerivedComponentPeerSelection(editor, -1) || cycleSiblingComponentSlotSelection(editor, -1)) { return true; }
			if (structuralSelectionModes.get(editor)?.stage === 'inner' && cycleInnerContentSelection(editor, -1)) { return true; }
			if (structuralSelectionModes.get(editor)?.stage === 'components') { return true; }
			if (cycleStructuralPeerSelection(editor, -1) || cycleDerivedNestedPeerSelection(editor, -1)) { return true; }
			return climbStructuralSelection(editor);
		}),
		vscode.commands.registerCommand('syntaxstitch.structuralSelectionHome', () => { const editor = vscode.window.activeTextEditor, mode = editor && structuralSelectionModes.get(editor); if (!editor || !mode) { return false; } applyStructuralSelectionMode(editor, { ...mode, focused: 0 }); return true; }),
		vscode.commands.registerCommand('syntaxstitch.structuralSelectionEnd', () => { const editor = vscode.window.activeTextEditor, mode = editor && structuralSelectionModes.get(editor); if (!editor || !mode) { return false; } applyStructuralSelectionMode(editor, { ...mode, focused: mode.spans.length - 1 }); return true; }),
		vscode.commands.registerCommand('syntaxstitch.structuralSelectionNext', () => {
			const editor = vscode.window.activeTextEditor, mode = editor && structuralSelectionModes.get(editor);
			if (!editor || !mode) { return false; }
			if (mode.stage === 'components' && descendFromComponentSelection(editor)) { return true; }
			return mode.stage === 'structure' ? enterNextStructuralStage(editor, false) : (applyStructuralSelectionMode(editor, { ...mode, focused: (mode.focused + 1) % mode.spans.length }), true);
		}),
		vscode.commands.registerCommand('syntaxstitch.structuralSelectionPrevious', () => {
			const editor = vscode.window.activeTextEditor, mode = editor && structuralSelectionModes.get(editor);
			if (!editor || !mode) { return false; }
			if (reverseComponentToAncestor(editor)) { return true; }
			return mode.stage === 'structure' || mode.stage === 'components' ? climbStructuralSelection(editor) : changeStructuralStage(editor, -1);
		}),
		vscode.commands.registerCommand('syntaxstitch.structuralSelectionComponents', () => enterNextStructuralStage(vscode.window.activeTextEditor!)),
		vscode.commands.registerCommand('syntaxstitch.structuralSelectionToggle', () => {
			const editor = vscode.window.activeTextEditor, mode = editor && structuralSelectionModes.get(editor);
			if (!editor || !mode) { return false; }
			const spans = mode.spans.map((span, index) => index === mode.focused ? { ...span, highlighted: span.highlighted === false } : span);
			applyStructuralSelectionMode(editor, { ...mode, spans });
			return true;
		}),
		vscode.commands.registerCommand('syntaxstitch.structuralSelectionDelete', () => {
			const editor = vscode.window.activeTextEditor, mode = editor && structuralSelectionModes.get(editor);
			if (!editor || !mode) { return false; }
			const spans = mode.spans.filter((_, index) => index !== mode.focused);
			if (!spans.length) { return exitStructuralSelectionMode(editor); }
			applyStructuralSelectionMode(editor, { ...mode, spans, focused: Math.min(mode.focused, spans.length - 1) });
			return true;
		}),
		vscode.commands.registerCommand('syntaxstitch.structuralSelectionExpandRight', () => expandStructuralSelectionMode(vscode.window.activeTextEditor!, 1)),
		vscode.commands.registerCommand('syntaxstitch.structuralSelectionExpandLeft', () => expandStructuralSelectionMode(vscode.window.activeTextEditor!, -1)),
		vscode.commands.registerCommand('syntaxstitch.toggle', async () => {
			const uri = vscode.window.activeTextEditor?.document.uri, config = vscode.workspace.getConfiguration(CONFIG_SECTION, uri), enabled = enabledSetting(uri);
			const target = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
			await config.update('enabled', !enabled, target);
			log(output, uri, 'verbose', { type: 'syntaxstitch/toggled', enabled: !enabled, scope: target === vscode.ConfigurationTarget.Workspace ? 'workspace' : 'global' });
		}),
		...(['left', 'right'] as const).map(direction => vscode.commands.registerCommand(`syntaxstitch.delete${direction === 'left' ? 'Left' : 'Right'}`, async () => {
			const editor = vscode.window.activeTextEditor, command = direction === 'left' ? 'deleteLeft' : 'deleteRight';
			if (!editor || !isEnabled(editor.document) || skippedEdits.has(keyOf(editor.document)) || editor.selections.length !== 1 || !editor.selection.isEmpty) { return vscode.commands.executeCommand(command); }
			const offset = editor.document.offsetAt(editor.selection.active);
			if ((direction === 'left' && offset === 0) || (direction === 'right' && offset === editor.document.getText().length)) { return vscode.commands.executeCommand(command); }
			index(editor.document);
			const target = direction === 'left' ? offset - 1 : offset, text = editor.document.getText(), whitespaceQuote = states.get(keyOf(editor.document))?.shadow.pairs.find(pair => pair.type === 'quote' && pair.closeIdx <= target && target < pair.closeIdx + pair.closeToken.length && !text.slice(pair.openIdx + pair.openToken.length, pair.closeIdx).trim());
			if (whitespaceQuote) {
				editor.selection = new vscode.Selection(editor.document.positionAt(whitespaceQuote.openIdx), editor.document.positionAt(whitespaceQuote.closeIdx + whitespaceQuote.closeToken.length));
				return;
			}
			let complete!: () => void;
			const completed = new Promise<void>(resolve => { complete = resolve; }), version = editor.document.version, deletion: DirectDeletion = { editor, direction, offset, completed, complete };
			directDeletions.set(keyOf(editor.document), deletion);
			try {
				await vscode.commands.executeCommand(command);
			} finally {
				if (editor.document.version === version && directDeletions.get(keyOf(editor.document)) === deletion) {
					directDeletions.delete(keyOf(editor.document));
					complete();
				}
			}
			await completed;
			if (deletion.selection) { editor.selection = deletion.selection; }
		})),
		vscode.commands.registerCommand('syntaxstitch.showStatistics', async () => {
			const statistics = counter.statistics;
			if (statisticsPanel) {
				statisticsPanel.reveal(vscode.ViewColumn.Active);
				statisticsPanel.webview.html = statisticsHtml(statistics);
				return statistics;
			}
			const panel = statisticsPanel = vscode.window.createWebviewPanel('syntaxstitch.statistics', 'SyntaxStitch Statistics', vscode.ViewColumn.Active, { enableScripts: false });
			panel.onDidDispose(() => { if (statisticsPanel === panel) { statisticsPanel = undefined; } });
			panel.webview.html = statisticsHtml(statistics);
			return statistics;
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
			editor.selections = editor.selections.flatMap(selection => {
				if (selection.isEmpty) { return selection; }
				const start = editor.document.offsetAt(selection.start), end = editor.document.offsetAt(selection.end);
				const spans = shadow.innerSelectionSpans(start, end);
				if (spans.length > 1) {
					selected += spans.length;
					return spans.map(span => new vscode.Selection(editor.document.positionAt(span.start), editor.document.positionAt(span.end)));
				}
				const span = shadow.innerSelectionSpan(start, end, selection.active.isAfter(selection.anchor));
				if (!span) { return selection; }
				selected++;
				return new vscode.Selection(editor.document.positionAt(span.start), editor.document.positionAt(span.end));
			});
			return selected;
		}),
		vscode.commands.registerCommand('syntaxstitch.rebuildShadowIndex', () => {
			const document = vscode.window.activeTextEditor?.document;
			if (document && isEnabled(document)) { states.delete(keyOf(document)); index(document); void vscode.window.showInformationMessage(`SyntaxStitch indexed ${states.get(keyOf(document))?.shadow.pairs.length ?? 0} structural pairs.`); }
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

export function deactivate(): void { states.clear(); repairing.clear(); directDeletions.clear(); pausedDocuments.clear(); skippedEdits.clear(); repairHistory.clear(); pendingEdits.cancelAll(); selectionSessions.clear(); }
// endregion
