export type TextSpan = { start: number; end: number };
export type MarkupAttribute = { name: string; key: TextSpan; value?: TextSpan; quote?: string; end: number };
export type TagToken = { start: number; end: number; token: string; name: string; nameStart: number; nameEnd: number; closing: boolean; selfClosing: boolean; quotes: { openIdx: number; closeIdx: number; token: string }[]; attributes: MarkupAttribute[] };

/** Shared lexical boundaries for indexing, navigation and mirrored edits. */
export function parseTagAt(text: string, start: number, end = text.length): TagToken | undefined {
	if (text[start] !== '<' || text.startsWith('<!--', start)) { return; }
	const fragment = text.startsWith('<>', start) ? '<>' : text.startsWith('</>', start) ? '</>' : undefined;
	if (fragment) { return { start, end: start + fragment.length, token: fragment, name: '#fragment', nameStart: start + 1, nameEnd: start + 1, closing: fragment === '</>', selfClosing: false, quotes: [], attributes: [] }; }
	const head = text.slice(start, Math.min(end, start + 128)).match(/^<\s*(\/?)\s*([A-Za-z][\w:.-]*)/);
	if (!head) { return; }
	const nameStart = start + head[0].lastIndexOf(head[2]), attributes: MarkupAttribute[] = [], quotes: TagToken['quotes'] = [];
	let cursor = start + head[0].length;
	const skipSpace = () => { while (cursor < end && /\s/.test(text[cursor])) { cursor++; } };
	const skipExpression = (): boolean => {
		let depth = 0, quote = '';
		for (; cursor < end; cursor++) {
			const char = text[cursor];
			if (quote) { if (char === '\\') { cursor++; } else if (char === quote) { quote = ''; } continue; }
			if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
			if (char === '{') { depth++; }
			if (char === '}' && --depth === 0) { cursor++; return true; }
		}
		return false;
	};
	while (cursor < end) {
		skipSpace();
		if (text[cursor] === '>' || text[cursor] === '/' && text[cursor + 1] === '>') {
			const selfClosing = text[cursor] === '/';
			cursor += selfClosing ? 2 : 1;
			return { start, end: cursor, token: text.slice(start, cursor), name: head[2].toLowerCase(), nameStart, nameEnd: nameStart + head[2].length, closing: !!head[1], selfClosing, attributes, quotes };
		}
		if (text[cursor] === '{') { if (!skipExpression()) { return; } continue; }
		const keyStart = cursor;
		while (cursor < end && !/[\s=<>/"'{}]/.test(text[cursor])) { cursor++; }
		if (cursor === keyStart) { return; }
		const keyEnd = cursor, name = text.slice(keyStart, keyEnd).toLowerCase();
		skipSpace();
		let value: TextSpan | undefined, quote: string | undefined;
		if (text[cursor] === '=') {
			cursor++; skipSpace();
			if (text[cursor] === '{') { if (!skipExpression()) { return; } continue; }
			if (text[cursor] === '"' || text[cursor] === "'") {
				quote = text[cursor++];
				const valueStart = cursor;
				while (cursor < end && text[cursor] !== quote) { cursor++; }
				if (cursor >= end) { return; }
				value = { start: valueStart, end: cursor };
				quotes.push({ openIdx: valueStart - 1, closeIdx: cursor, token: quote });
				cursor++;
			} else {
				const valueStart = cursor;
				while (cursor < end && !/[\s>]/.test(text[cursor]) && !(text[cursor] === '/' && text[cursor + 1] === '>')) { cursor++; }
				if (cursor === valueStart || /[<"'`=]/.test(text.slice(valueStart, cursor))) { return; }
				value = { start: valueStart, end: cursor };
			}
		}
		attributes.push({ name, key: { start: keyStart, end: keyEnd }, value, quote, end: value ? cursor : keyEnd });
	}
	return;
}

/** Includes void/self-closing elements, but excludes comments and raw-text contents. */
export function markupTags(text: string): TagToken[] {
	const tags: TagToken[] = [];
	for (let cursor = 0; cursor < text.length;) {
		cursor = text.indexOf('<', cursor);
		if (cursor < 0) { break; }
		if (text.startsWith('<!--', cursor)) { const end = text.indexOf('-->', cursor + 4); cursor = end < 0 ? text.length : end + 3; continue; }
		const tag = parseTagAt(text, cursor);
		if (!tag) { cursor++; continue; }
		tags.push(tag); cursor = tag.end;
		if (!tag.closing && !tag.selfClosing && ['script', 'style', 'textarea', 'title'].includes(tag.name)) {
			const close = new RegExp(`</${tag.name}\\s*>`, 'gi'); close.lastIndex = cursor;
			const match = close.exec(text); cursor = match?.index ?? text.length;
		}
	}
	return tags;
}
