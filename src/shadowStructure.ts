import { randomUUID } from 'node:crypto';
import type * as vscode from 'vscode';

// region Types & State
export type BlockType = 'brace' | 'tag' | 'quote' | 'indent';
export type RepairKind = 'square' | 'parenthesis' | 'curly' | 'tag' | 'quote' | 'indent';
export type TokenPair = { id: string; openIdx: number; closeIdx: number; type: BlockType; languageId: string; openToken: string; closeToken: string };
export type RepairPatch = { offset: number; deleteLength: number; text: string; pairId: string; side: 'open' | 'close'; blockType: BlockType; kind: RepairKind };
export type SelectionSpan = { start: number; end: number };

export interface IShadowStructure {
	addPair(openIdx: number, closeIdx: number, type?: BlockType): string;
	validateEdit(startIdx: number, endIdx: number): TokenPair[];
	shiftOffsets(offset: number, afterIdx: number): void;
	healEdit(change: vscode.TextDocumentContentChangeEvent, violations: TokenPair[]): vscode.TextDocumentContentChangeEvent;
	processBatch(changes: readonly vscode.TextDocumentContentChangeEvent[]): { healed: vscode.TextDocumentContentChangeEvent[]; msg?: string };
	selectionSpan(startIdx: number, endIdx?: number): SelectionSpan | undefined;
	innerSelectionSpan(startIdx: number, endIdx: number, towardEnd?: boolean): SelectionSpan | undefined;
}

type PairRecord = TokenPair & { openToken: string; closeToken: string };
type PendingPair = Omit<PairRecord, 'id'>;
type Change = Pick<vscode.TextDocumentContentChangeEvent, 'range' | 'rangeLength' | 'rangeOffset' | 'text'>;

const BRACES = new Map([['{', '}'], ['[', ']'], ['(', ')']]);
const CLOSING_BRACES = new Set(BRACES.values());
const MARKUP_LANGUAGES = new Set(['html', 'xml', 'vue', 'svelte', 'astro', 'handlebars']);
const JSX_LANGUAGES = new Set(['javascriptreact', 'typescriptreact']);
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const TAG_PATTERN = /<\/?([A-Za-z][\w:.-]*)(?:\s[^<>]*?)?\s*\/?>/g;
const LINE_PATTERN = /.*(?:\r?\n|$)/g;
const TAB_WIDTH = 4;
// endregion

// region Indexers
type TagToken = { start: number; end: number; token: string; name: string; closing: boolean; selfClosing: boolean; quotes: { openIdx: number; closeIdx: number; token: string }[] };
type TagOpen = Pick<TagToken, 'name' | 'start' | 'token'>;

const pair = (openIdx: number, closeIdx: number, type: BlockType, openToken: string, closeToken: string, languageId: string): PendingPair => ({ openIdx, closeIdx, type, openToken, closeToken, languageId });
const parseTagAt = (text: string, start: number, end = text.length): TagToken | undefined => {
	if (text[start] !== '<' || text.startsWith('<!--', start)) { return undefined; }
	const head = text.slice(start, Math.min(end, start + 128)).match(/^<\s*(\/?)\s*([A-Za-z][\w:.-]*)/);
	if (!head) { return undefined; }
	let quote = '', escaped = false, cursor = start + head[0].length;
	for (; cursor < end; cursor++) {
		const char = text[cursor];
		if (quote) { if (!escaped && char === quote) { quote = ''; } escaped = !escaped && char === '\\'; if (char !== '\\') { escaped = false; } continue; }
		if (char === '"' || char === "'") { quote = char; continue; }
		if (char !== '>') { continue; }
		const token = text.slice(start, cursor + 1), quotes: TagToken['quotes'] = [];
		let attributeQuote = '', openIdx = -1;
		for (let idx = start + head[0].length; idx < cursor; idx++) {
			const attributeChar = text[idx];
			if (!attributeQuote && (attributeChar === '"' || attributeChar === "'")) { attributeQuote = attributeChar; openIdx = idx; continue; }
			if (attributeQuote && attributeChar === attributeQuote) { quotes.push({ openIdx, closeIdx: idx, token: attributeQuote }); attributeQuote = ''; }
		}
		return { start, end: cursor + 1, token, name: head[2].toLowerCase(), closing: !!head[1], selfClosing: /\/\s*>$/.test(token), quotes };
	}
	return undefined;
};
const addTag = (tag: TagToken, stack: TagOpen[], pairs: PendingPair[], languageId: string): void => {
	for (const quote of tag.quotes) { pairs.push(pair(quote.openIdx, quote.closeIdx, 'quote', quote.token, quote.token, languageId)); }
	if (tag.closing) {
		const openIdx = stack.map(candidate => candidate.name).lastIndexOf(tag.name), open = stack[openIdx];
		if (open) { stack.splice(openIdx); pairs.push(pair(open.start, tag.start, 'tag', open.token, tag.token, languageId)); }
	} else if (!tag.selfClosing && !VOID_TAGS.has(tag.name)) { stack.push({ name: tag.name, start: tag.start, token: tag.token }); }
};

const scanString = (text: string, openIdx: number, end: number, languageId: string, pairs: PendingPair[]): number => {
	const character = text[openIdx], token = (languageId === 'python' || languageId === 'csharp') && text.startsWith(character.repeat(3), openIdx) ? character.repeat(3) : character;
	const multiline = token.length > 1 || (languageId === 'csharp' && text[openIdx - 1] === '@');
	for (let idx = openIdx + token.length, escaped = false; idx < end; idx++) {
		const char = text[idx];
		if (!escaped && text.startsWith(token, idx)) { pairs.push(pair(openIdx, idx, 'quote', token, token, languageId)); return idx + token.length - 1; }
		if (!multiline && (char === '\r' || char === '\n')) {
			if (!escaped) { return idx - 1; }
			if (char === '\r' && text[idx + 1] === '\n') { idx++; }
			escaped = false;
			continue;
		}
		escaped = !escaped && char === '\\';
		if (char !== '\\') { escaped = false; }
	}
	return end - 1;
};
function scanCode(text: string, start: number, end: number, languageId: string, pairs: PendingPair[], stopAtBrace = false): number {
	const braces: { token: string; idx: number }[] = [], tags: TagOpen[] = [];
	const css = languageId === 'css';
	for (let idx = start; idx < end; idx++) {
		const char = text[idx], next = text[idx + 1] ?? '';
		if (char === '/' && next === '*') { const close = text.indexOf('*/', idx + 2); idx = close < 0 ? end : close + 1; continue; }
		if (!css && char === '/' && next === '/') { const close = text.indexOf('\n', idx + 2); idx = close < 0 ? end : close; continue; }
		if (char === '"' || char === "'") { idx = scanString(text, idx, end, languageId, pairs); continue; }
		if (char === '`') { idx = scanTemplate(text, idx, end, languageId, pairs); continue; }
		if (JSX_LANGUAGES.has(languageId) && char === '<') { const tag = parseTagAt(text, idx, end); if (tag) { addTag(tag, tags, pairs, 'html'); idx = tag.end - 1; continue; } }
		if (BRACES.has(char)) { braces.push({ token: char, idx }); continue; }
		if (!CLOSING_BRACES.has(char)) { continue; }
		if (char === '}' && stopAtBrace && !braces.length) { return idx; }
		const open = braces.at(-1);
		if (open && BRACES.get(open.token) === char) { braces.pop(); pairs.push(pair(open.idx, idx, 'brace', open.token, char, languageId)); }
	}
	return end;
}
function scanTemplate(text: string, openIdx: number, end: number, languageId: string, pairs: PendingPair[]): number {
	const tags: TagOpen[] = [];
	for (let idx = openIdx + 1; idx < end; idx++) {
		if (text[idx] === '\\') { idx++; continue; }
		if (text[idx] === '`') { pairs.push(pair(openIdx, idx, 'quote', '`', '`', languageId)); return idx; }
		if (text[idx] === '$' && text[idx + 1] === '{') {
			const close = scanCode(text, idx + 2, end, languageId, pairs, true);
			if (close < end) { pairs.push(pair(idx + 1, close, 'brace', '{', '}', languageId)); idx = close; }
			continue;
		}
		if (text[idx] === '<') { const tag = parseTagAt(text, idx, end); if (tag) { addTag(tag, tags, pairs, 'html'); idx = tag.end - 1; } }
	}
	return end - 1;
}
const scanMarkup = (text: string, languageId: string, pairs: PendingPair[]): void => {
	const tags: TagOpen[] = [];
	for (let idx = 0; idx < text.length; idx++) {
		if (text.startsWith('<!--', idx)) { const close = text.indexOf('-->', idx + 4); idx = close < 0 ? text.length : close + 2; continue; }
		if (text[idx] !== '<') { continue; }
		const tag = parseTagAt(text, idx);
		if (!tag) { continue; }
		for (const quote of tag.quotes) { pairs.push(pair(quote.openIdx, quote.closeIdx, 'quote', quote.token, quote.token, languageId)); }
		if (!tag.closing && !tag.selfClosing && (tag.name === 'script' || tag.name === 'style')) {
			const closePattern = new RegExp(`<\\/\\s*${tag.name}\\s*>`, 'ig');
			closePattern.lastIndex = tag.end;
			const match = closePattern.exec(text);
			if (match) {
				const embeddedLanguage = tag.name === 'style' ? 'css' : 'javascript';
				scanCode(text, tag.end, match.index, embeddedLanguage, pairs);
				pairs.push(pair(tag.start, match.index, 'tag', tag.token, match[0], languageId));
				idx = match.index + match[0].length - 1;
				continue;
			}
		}
		addTag({ ...tag, quotes: [] }, tags, pairs, languageId);
		idx = tag.end - 1;
	}
};

const indentWidth = (value: string): number => [...value].reduce((width, char) => width + (char === '\t' ? TAB_WIDTH : 1), 0);
const indexIndents = (text: string): PendingPair[] => {
	const pairs: PendingPair[] = [], stack: { width: number; idx: number; token: string }[] = [];
	for (const match of text.matchAll(LINE_PATTERN)) {
		const line = match[0], content = line.replace(/\r?\n$/, '');
		if (!content.trim() || content.trimStart().startsWith('#')) { continue; }
		const token = content.match(/^[\t ]*/)?.[0] ?? '', width = indentWidth(token), idx = match.index;
		while (stack.length && width < stack.at(-1)!.width) {
			const open = stack.pop()!;
			pairs.push(pair(open.idx, idx, 'indent', open.token, '', 'python'));
		}
		if (width > (stack.at(-1)?.width ?? 0)) { stack.push({ width, idx, token }); }
	}
	for (const open of stack.reverse()) { pairs.push(pair(open.idx, text.length, 'indent', open.token, '', 'python')); }
	return pairs;
};
const indexDocument = (text: string, languageId: string): PendingPair[] => {
	const pairs: PendingPair[] = [];
	if (MARKUP_LANGUAGES.has(languageId)) { scanMarkup(text, languageId, pairs); } else { scanCode(text, 0, text.length, languageId, pairs); }
	if (languageId === 'python') { pairs.push(...indexIndents(text)); }
	return pairs;
};
// endregion

// region Reconciliation
const overlaps = (start: number, end: number, tokenIdx: number, tokenLength: number): boolean => tokenLength ? start < tokenIdx + tokenLength && end > tokenIdx : start <= tokenIdx && end > tokenIdx;
const tagIdentity = (token: string): string | undefined => {
	const match = token.match(/^<\s*(\/?)\s*([A-Za-z][\w:.-]*)/);
	return match ? `${match[1] ? 'close' : 'open'}:${match[2].toLowerCase()}` : undefined;
};
const suppliesEquivalent = (text: string, pair: PairRecord, side: 'open' | 'close'): boolean => {
	const token = side === 'open' ? pair.openToken : pair.closeToken;
	if (!token) { return false; }
	if (pair.type === 'brace' || pair.type === 'quote') { return text.includes(token); }
	if (pair.type === 'tag') { const identity = tagIdentity(token); return [...text.matchAll(TAG_PATTERN)].some(match => tagIdentity(match[0]) === identity); }
	return indentWidth(text.match(/^[\t ]*/)?.[0] ?? '') >= indentWidth(token);
};
const mapOffset = (offset: number, changes: readonly Change[], endAffinity: boolean): number => {
	let delta = 0;
	for (const change of [...changes].sort((left, right) => left.rangeOffset - right.rangeOffset)) {
		const end = change.rangeOffset + change.rangeLength;
		if (offset < change.rangeOffset) { break; }
		if (offset <= end) { return change.rangeOffset + delta + (endAffinity ? change.text.length : 0); }
		delta += change.text.length - change.rangeLength;
	}
	return offset + delta;
};
const sameBoundary = (left: string, right: string, type: BlockType): boolean => type === 'tag' ? tagIdentity(left) === tagIdentity(right) : left === right;
const repairKind = (pair: PairRecord): RepairKind => pair.type === 'tag' ? 'tag' : pair.type === 'quote' ? 'quote' : pair.type === 'indent' ? 'indent' : pair.openToken === '[' ? 'square' : pair.openToken === '(' ? 'parenthesis' : 'curly';
const counterpartRebound = (pair: PairRecord, side: 'open' | 'close', changes: readonly Change[], resultingPairs: readonly PendingPair[], originalPairCount: number): boolean => {
	const endpoint = side === 'close' ? 'openIdx' : 'closeIdx', token = side === 'close' ? 'openToken' : 'closeToken';
	const mappedIdx = mapOffset(pair[endpoint], changes, false);
	const scopedPairs = resultingPairs.filter(candidate => candidate.languageId === pair.languageId);
	return scopedPairs.length >= originalPairCount && scopedPairs.some(candidate => candidate.type === pair.type && candidate[endpoint] === mappedIdx && sameBoundary(candidate[token], pair[token], pair.type));
};
const removeExactTagPair = (pair: PairRecord, side: 'open' | 'close', change: Change, changes: readonly Change[]): Pick<RepairPatch, 'offset' | 'deleteLength' | 'text'> | undefined => {
	const token = side === 'open' ? pair.openToken : pair.closeToken, tokenIdx = side === 'open' ? pair.openIdx : pair.closeIdx;
	if (pair.type !== 'tag' || change.text || change.rangeOffset !== tokenIdx || change.rangeLength !== token.length) { return undefined; }
	const counterpart = side === 'open' ? pair.closeToken : pair.openToken, counterpartIdx = side === 'open' ? pair.closeIdx : pair.openIdx;
	const offset = mapOffset(counterpartIdx, changes, false), end = mapOffset(counterpartIdx + counterpart.length, changes, true);
	return { offset, deleteLength: Math.max(0, end - offset), text: '' };
};
const removeExactGroupingPair = (source: string, pair: PairRecord, side: 'open' | 'close', change: Change, changes: readonly Change[]): Pick<RepairPatch, 'offset' | 'deleteLength' | 'text'> | undefined => {
	const token = side === 'open' ? pair.openToken : pair.closeToken, tokenIdx = side === 'open' ? pair.openIdx : pair.closeIdx, previous = source.slice(0, pair.openIdx).match(/\S(?=\s*$)/)?.[0];
	if (pair.type !== 'brace' || pair.openToken !== '(' || change.text || change.rangeOffset !== tokenIdx || change.rangeLength !== token.length || (previous && /[\w$.)\]]/.test(previous))) { return undefined; }
	const counterpartIdx = side === 'open' ? pair.closeIdx : pair.openIdx, counterpart = side === 'open' ? pair.closeToken : pair.openToken;
	const offset = mapOffset(counterpartIdx, changes, false), end = mapOffset(counterpartIdx + counterpart.length, changes, true);
	return { offset, deleteLength: Math.max(0, end - offset), text: '' };
};
const removeEmptyPair = (pair: PairRecord, side: 'open' | 'close', change: Change, changes: readonly Change[], resultingText: string): Pick<RepairPatch, 'offset' | 'deleteLength' | 'text'> | undefined => {
	if (pair.type === 'indent' || change.text) { return undefined; }
	const offset = mapOffset(pair.openIdx, changes, false), end = mapOffset(pair.closeIdx + pair.closeToken.length, changes, false);
	const remainder = resultingText.slice(offset, end), survivingToken = side === 'close' ? pair.openToken : pair.closeToken;
	const ownsRemainder = side === 'close' ? remainder.startsWith(survivingToken) : remainder.endsWith(survivingToken);
	if (!ownsRemainder || remainder.replace(survivingToken, '').trim()) { return undefined; }
	return { offset, deleteLength: remainder.length, text: '' };
};
const compactBeforeCloser = (pair: PairRecord, side: 'open' | 'close', change: Change, changes: readonly Change[], resultingText: string): Pick<RepairPatch, 'offset' | 'deleteLength' | 'text'> | undefined => {
	if ((pair.type !== 'brace' && pair.type !== 'tag') || side !== 'close' || change.text) { return undefined; }
	const openEnd = mapOffset(pair.openIdx + pair.openToken.length, changes, false), close = mapOffset(pair.closeIdx, changes, false);
	const whitespace = resultingText.slice(openEnd, close).match(/[\t \r\n]+$/)?.[0] ?? '', lineBreaks = whitespace.match(/\r?\n/g) ?? [];
	if (!lineBreaks.length || !resultingText.slice(openEnd, close - whitespace.length).trim()) { return undefined; }
	const trailingIndent = whitespace.slice(whitespace.lastIndexOf('\n') + 1), compacted = `${lineBreaks.slice(1).join('')}${trailingIndent}`;
	return { offset: close - whitespace.length, deleteLength: whitespace.length, text: `${compacted}${pair.closeToken}` };
};

export class ShadowStructure implements IShadowStructure {
	readonly #pairs = new Map<string, PairRecord>();
	#languageId = 'plaintext';
	#source = '';

	constructor(text = '', languageId = 'plaintext') { this.reindex(text, languageId); }

	get pairs(): readonly TokenPair[] { return [...this.#pairs.values()].map(({ id, openIdx, closeIdx, type, languageId, openToken, closeToken }) => ({ id, openIdx, closeIdx, type, languageId, openToken, closeToken })); }

	reindex(text: string, languageId = 'plaintext'): void {
		const previous = [...this.#pairs.values()];
		const indexed = indexDocument(text, languageId);
		this.#languageId = languageId;
		this.#source = text;
		this.#pairs.clear();
		for (const pair of indexed) {
			const candidates = previous.map((record, idx) => ({ record, idx })).filter(({ record }) => record.type === pair.type && record.languageId === pair.languageId && sameBoundary(record.openToken, pair.openToken, pair.type) && sameBoundary(record.closeToken, pair.closeToken, pair.type));
			const match = candidates.sort((left, right) => Math.abs(left.record.openIdx - pair.openIdx) + Math.abs(left.record.closeIdx - pair.closeIdx) - Math.abs(right.record.openIdx - pair.openIdx) - Math.abs(right.record.closeIdx - pair.closeIdx))[0];
			if (match) { previous.splice(match.idx, 1); this.#pairs.set(match.record.id, { ...pair, id: match.record.id }); } else { this.#addRecord(pair); }
		}
	}

	addPair(openIdx: number, closeIdx: number, type: BlockType = 'brace'): string { return this.#addRecord({ openIdx, closeIdx, type, openToken: '', closeToken: '', languageId: this.#languageId }); }

	validateEdit(startIdx: number, endIdx: number): TokenPair[] {
		return [...this.#pairs.values()].filter(pair => overlaps(startIdx, endIdx, pair.openIdx, pair.openToken.length) !== overlaps(startIdx, endIdx, pair.closeIdx, pair.closeToken.length));
	}

	shiftOffsets(offset: number, afterIdx: number): void {
		for (const pair of this.#pairs.values()) { if (pair.openIdx >= afterIdx) { pair.openIdx += offset; } if (pair.closeIdx >= afterIdx) { pair.closeIdx += offset; } }
	}

	selectionSpan(startIdx: number, endIdx = startIdx): SelectionSpan | undefined {
		const collapsed = startIdx === endIdx;
		return [...this.#pairs.values()].filter(pair => {
			if (pair.type === 'indent') { return false; }
			const end = pair.closeIdx + pair.closeToken.length;
			if (collapsed) { return (pair.openIdx <= startIdx && startIdx <= pair.openIdx + pair.openToken.length) || (pair.closeIdx <= startIdx && startIdx <= end); }
			return pair.openIdx <= startIdx && endIdx <= end && (pair.openIdx < startIdx || endIdx < end);
		}).map(pair => ({ start: pair.openIdx, end: pair.closeIdx + pair.closeToken.length })).sort((left, right) => left.end - left.start - (right.end - right.start))[0];
	}

	innerSelectionSpan(startIdx: number, endIdx: number, towardEnd = true): SelectionSpan | undefined {
		return [...this.#pairs.values()].filter(pair => pair.type !== 'indent')
			.map(pair => ({ start: pair.openIdx, end: pair.closeIdx + pair.closeToken.length }))
			.filter(span => startIdx <= span.start && span.end <= endIdx && (startIdx < span.start || span.end < endIdx))
			.sort((left, right) => towardEnd ? right.end - left.end || right.start - left.start : left.start - right.start || left.end - right.end)[0];
	}

	healEdit(change: vscode.TextDocumentContentChangeEvent, violations: TokenPair[]): vscode.TextDocumentContentChangeEvent {
		const records = violations.map(pair => this.#pairs.get(pair.id)).filter((pair): pair is PairRecord => !!pair);
		const prefix = records.filter(pair => overlaps(change.rangeOffset, change.rangeOffset + change.rangeLength, pair.openIdx, pair.openToken.length) && !suppliesEquivalent(change.text, pair, 'open')).map(pair => pair.openToken).join('');
		const suffix = records.filter(pair => overlaps(change.rangeOffset, change.rangeOffset + change.rangeLength, pair.closeIdx, pair.closeToken.length) && !suppliesEquivalent(change.text, pair, 'close')).map(pair => pair.closeToken).join('');
		return { ...change, text: `${prefix}${change.text}${suffix}` };
	}

	processBatch(changes: readonly vscode.TextDocumentContentChangeEvent[]): { healed: vscode.TextDocumentContentChangeEvent[]; msg?: string } {
		const healed = [...changes].sort((left, right) => right.rangeOffset - left.rangeOffset).flatMap(change => {
			const violations = this.validateEdit(change.rangeOffset, change.rangeOffset + change.rangeLength);
			return violations.length ? [this.healEdit(change, violations)] : [];
		});
		return { healed, msg: healed.length ? JSON.stringify({ type: 'syntaxstitch/reconciled', repairs: healed.length }) : undefined };
	}

	planRepairs(changes: readonly Change[], resultingText?: string): RepairPatch[] {
		const patches = new Map<string, RepairPatch>();
		const fullyTouched = new Set([...this.#pairs.values()].filter(pair => pair.type !== 'indent' && (() => {
			const touches = (idx: number, length: number): boolean => changes.some(change => overlaps(change.rangeOffset, change.rangeOffset + change.rangeLength, idx, length));
			return touches(pair.openIdx, pair.openToken.length) && touches(pair.closeIdx, pair.closeToken.length);
		})()).map(pair => pair.id));
		const resultingPairs = new Map<BlockType, PendingPair[]>();
		if (resultingText !== undefined) { for (const candidate of indexDocument(resultingText, this.#languageId)) { resultingPairs.set(candidate.type, [...(resultingPairs.get(candidate.type) ?? []), candidate]); } }
		for (const change of [...changes].sort((left, right) => right.rangeOffset - left.rangeOffset)) {
			const start = change.rangeOffset, end = start + change.rangeLength;
			for (const violation of this.validateEdit(start, end)) {
				const pair = this.#pairs.get(violation.id)!;
				if (fullyTouched.has(pair.id)) { continue; }
				const openHit = overlaps(start, end, pair.openIdx, pair.openToken.length), side = openHit ? 'open' : 'close';
				if (suppliesEquivalent(change.text, pair, side)) { continue; }
				const emptyPairRemoval = resultingText === undefined ? undefined : removeEmptyPair(pair, side, change, changes, resultingText);
				const pairRemoval = emptyPairRemoval ?? removeExactTagPair(pair, side, change, changes) ?? removeExactGroupingPair(this.#source, pair, side, change, changes);
				const originalPairCount = [...this.#pairs.values()].filter(candidate => candidate.type === pair.type && candidate.languageId === pair.languageId).length;
				if (!pairRemoval && resultingText !== undefined && counterpartRebound(pair, side, changes, resultingPairs.get(pair.type) ?? [], originalPairCount)) { continue; }
				const compaction = resultingText === undefined || pairRemoval ? undefined : compactBeforeCloser(pair, side, change, changes, resultingText);
				const restoring = side === 'open' || pair.closeToken.length > 0;
				const token = openHit ? pair.openToken : pair.closeToken, oldOffset = restoring ? (openHit ? pair.openIdx : pair.closeIdx) : pair.openIdx;
				const mappedStart = mapOffset(oldOffset, changes, false), mappedEnd = mapOffset(oldOffset + token.length, changes, true);
				const intentional = pairRemoval ?? compaction;
				const patch = { offset: intentional?.offset ?? mappedStart, deleteLength: intentional?.deleteLength ?? (restoring ? Math.max(0, mappedEnd - mappedStart) : pair.openToken.length), text: intentional?.text ?? (restoring ? token : ''), pairId: pair.id, side, blockType: pair.type, kind: repairKind(pair) } satisfies RepairPatch;
				if (patch.text || patch.deleteLength) { patches.set(`${patch.offset}:${patch.deleteLength}:${patch.text}`, patch); }
			}
		}
		return [...patches.values()].sort((left, right) => right.offset - left.offset);
	}

	#addRecord(pair: PendingPair): string { const record = { ...pair, id: randomUUID() }; this.#pairs.set(record.id, record); return record.id; }
}
// endregion