import * as assert from 'assert';
import * as vscode from 'vscode';
import { ShadowStructure } from '../shadowStructure';

const change = (text: string, start: number, length: number, replacement = ''): vscode.TextDocumentContentChangeEvent => ({
	range: new vscode.Range(new vscode.Position(0, start), new vscode.Position(0, start + length)),
	rangeOffset: start,
	rangeLength: length,
	text: replacement,
});
const applyRepair = (text: string, edit: vscode.TextDocumentContentChangeEvent, shadow: ShadowStructure): string => {
	let result = `${text.slice(0, edit.rangeOffset)}${edit.text}${text.slice(edit.rangeOffset + edit.rangeLength)}`;
	for (const patch of shadow.planRepairs([edit])) { result = `${result.slice(0, patch.offset)}${patch.text}${result.slice(patch.offset + patch.deleteLength)}`; }
	return result;
};

suite('ShadowStructure', () => {
	test('restores either deleted half of a brace pair', () => {
		const text = 'const value = { nested: true };', shadow = new ShadowStructure(text, 'typescript');
		const open = text.indexOf('{'), close = text.indexOf('}');

		assert.deepStrictEqual(shadow.planRepairs([change(text, open, 1)]).map(({ offset, text: token }) => [offset, token]), [[open, '{']]);
		assert.deepStrictEqual(shadow.planRepairs([change(text, close, 1)]).map(({ offset, text: token }) => [offset, token]), [[close, '}']]);
	});

	test('classifies each bracket family separately', () => {
		const cases = [['const value = [1];', '[', 'square'], ['call(1);', '(', 'parenthesis'], ['const value = { key: 1 };', '{', 'curly']] as const;
		for (const [text, token, kind] of cases) {
			const shadow = new ShadowStructure(text, 'typescript'), start = text.indexOf(token);
			assert.strictEqual(shadow.planRepairs([change(text, start, 1)])[0]?.kind, kind);
		}
	});

	test('selects a boundary pair and expands to its enclosing pair', () => {
		const text = 'call({ value: true })', shadow = new ShadowStructure(text, 'javascript'), close = text.indexOf('}') + 1;
		const inner = shadow.selectionSpan(close), outer = shadow.selectionSpan(inner!.start, inner!.end);
		assert.strictEqual(text.slice(inner!.start, inner!.end), '{ value: true }');
		assert.strictEqual(text.slice(outer!.start, outer!.end), '({ value: true })');
		assert.deepStrictEqual(shadow.innerSelectionSpan(outer!.start, outer!.end), inner);
	});

	test('selects the inner sibling nearest the active edge', () => {
		const text = '{ first(); second(); }', shadow = new ShadowStructure(text, 'javascript');
		assert.strictEqual(text.slice(...Object.values(shadow.innerSelectionSpan(0, text.length, true)!)), '()');
		assert.strictEqual(shadow.innerSelectionSpan(0, text.length, true)!.start, text.lastIndexOf('('));
		assert.strictEqual(shadow.innerSelectionSpan(0, text.length, false)!.start, text.indexOf('('));
	});

	test('selects complete markup tags from a closing boundary', () => {
		const text = '<main><section>Content</section></main>', shadow = new ShadowStructure(text, 'html'), closeEnd = text.indexOf('</section>') + '</section>'.length;
		const span = shadow.selectionSpan(closeEnd);
		assert.strictEqual(text.slice(span!.start, span!.end), '<section>Content</section>');
	});

	test('tracks HTML to JavaScript to template HTML language shifts', () => {
		const text = '<main><script>const view = `<section>${render({ ready: true })}</section>`;</script></main>', shadow = new ShadowStructure(text, 'html');
		const pairsAt = (token: string) => shadow.pairs.filter(pair => pair.openIdx === text.indexOf(token));
		assert.ok(pairsAt('<main>').some(pair => pair.type === 'tag' && pair.languageId === 'html'));
		assert.ok(pairsAt('(').some(pair => pair.type === 'brace' && pair.languageId === 'javascript'));
		assert.ok(pairsAt('{').some(pair => pair.type === 'brace' && pair.languageId === 'javascript'));
		assert.ok(pairsAt('<section>').some(pair => pair.type === 'tag' && pair.languageId === 'html'));
		assert.ok(pairsAt('`').some(pair => pair.type === 'quote' && pair.languageId === 'javascript'));
	});

	test('tracks CSS structures and ignores quoted or commented decoys', () => {
		const text = '<style>.card { content: "}"; background: url("<fake></fake>"); /* { } */ }</style>', shadow = new ShadowStructure(text, 'html');
		const cssBrace = shadow.pairs.find(pair => pair.openIdx === text.indexOf('{'));
		assert.strictEqual(cssBrace?.type, 'brace');
		assert.strictEqual(cssBrace?.languageId, 'css');
		assert.strictEqual(shadow.pairs.filter(pair => pair.type === 'quote' && pair.languageId === 'css').length, 2);
		assert.ok(!shadow.pairs.some(pair => pair.type === 'tag' && text.slice(pair.openIdx).startsWith('<fake>')));
		assert.ok(!shadow.pairs.some(pair => pair.type === 'brace' && pair.openIdx === text.lastIndexOf('{')));
	});

	test('pairs code quotes without indexing their structural content', () => {
		const text = 'const value = "<fake>{[( content )]} </fake>"; call(value);', shadow = new ShadowStructure(text, 'javascript');
		const quote = shadow.pairs.find(pair => pair.type === 'quote');
		assert.strictEqual(quote?.languageId, 'javascript');
		assert.strictEqual(quote?.openIdx, text.indexOf('"'));
		assert.strictEqual(quote?.closeIdx, text.lastIndexOf('"'));
		assert.strictEqual(shadow.pairs.filter(pair => pair.type === 'brace').length, 1);
		assert.ok(!shadow.pairs.some(pair => pair.type === 'tag'));
	});

	test('pairs attribute and triple quotes and repairs a deleted quote', () => {
		const markup = '<section title="a > b">Content</section>', html = new ShadowStructure(markup, 'html');
		assert.ok(html.pairs.some(pair => pair.type === 'quote' && pair.languageId === 'html'));

		const python = 'message = """{ quoted content }"""', pythonShadow = new ShadowStructure(python, 'python');
		assert.strictEqual(pythonShadow.pairs.filter(pair => pair.type === 'quote').length, 1);
		assert.ok(!pythonShadow.pairs.some(pair => pair.type === 'brace'));

		const code = 'const value = "content";', shadow = new ShadowStructure(code, 'javascript'), close = code.lastIndexOf('"');
		assert.strictEqual(shadow.planRepairs([change(code, close, 1)], `${code.slice(0, close)}${code.slice(close + 1)}`)[0]?.text, '"');
	});

	test('removes whitespace-only concrete pairs when either boundary is deleted', () => {
		const applyDeletion = (text: string, languageId: string, token: string): string => {
			const shadow = new ShadowStructure(text, languageId), start = text.indexOf(token), edit = change(text, start, token.length);
			let result = `${text.slice(0, start)}${text.slice(start + token.length)}`;
			for (const patch of shadow.planRepairs([edit], result)) { result = `${result.slice(0, patch.offset)}${patch.text}${result.slice(patch.offset + patch.deleteLength)}`; }
			return result;
		};

		assert.ok(applyDeletion('internal static void Main() => Console.WriteLine(CalculateTotal(new[\n\n    ]{ 4, 8, 15, 16, 23, 42 }));', 'csharp', ']').includes('new{'));
		assert.strictEqual(applyDeletion('call( )', 'javascript', ')'), 'call');
		assert.strictEqual(applyDeletion('call( )', 'javascript', '('), 'call');
		assert.strictEqual(applyDeletion('const value = {\n};', 'javascript', '}'), 'const value = ;');
		assert.strictEqual(applyDeletion('<section>\n</section>', 'html', '</section>'), '');
		assert.strictEqual(applyDeletion('call(value)', 'javascript', ')'), 'call(value)');
		assert.strictEqual(applyDeletion('call(/* intentionally empty */)', 'javascript', ')'), 'call(/* intentionally empty */)');
	});

	test('allows coordinated boundary edits to unwrap meaningful content', () => {
		const text = 'call(value)', shadow = new ShadowStructure(text, 'javascript');
		const changes = [change(text, text.indexOf('('), 1), change(text, text.indexOf(')'), 1)];
		assert.deepStrictEqual(shadow.planRepairs(changes, 'callvalue'), []);
	});

	test('allows coordinated boundary edits to change delimiter type', () => {
		const text = '(value)', shadow = new ShadowStructure(text, 'javascript');
		const changes = [change(text, text.indexOf('('), 1, '['), change(text, text.indexOf(')'), 1, ']')];
		assert.deepStrictEqual(shadow.planRepairs(changes, '[value]'), []);
	});

	test('removes only the targeted adjacent empty pair', () => {
		const text = '()[]{}', shadow = new ShadowStructure(text, 'javascript'), start = text.indexOf(']'), edit = change(text, start, 1);
		const resulting = `${text.slice(0, start)}${text.slice(start + 1)}`, patches = shadow.planRepairs([edit], resulting);
		assert.deepStrictEqual(patches.map(({ offset, deleteLength, text: replacement }) => [offset, deleteLength, replacement]), [[2, 1, '']]);
	});

	test('prefers removing a targeted empty pair over rebinding it to an outer closer', () => {
		const text = '(({()}))', shadow = new ShadowStructure(text, 'javascript'), start = text.indexOf(')'), edit = change(text, start, 1);
		const resulting = `${text.slice(0, start)}${text.slice(start + 1)}`;
		assert.deepStrictEqual(shadow.planRepairs([edit], resulting).map(({ offset, deleteLength, text: replacement }) => [offset, deleteLength, replacement]), [[3, 1, '']]);
	});

	test('compacts one trailing line break per protected closer deletion', () => {
		const applyCloseDeletion = (text: string): string => {
			const shadow = new ShadowStructure(text, 'csharp'), start = text.lastIndexOf('}'), edit = change(text, start, 1);
			let result = text.slice(0, start);
			for (const patch of shadow.planRepairs([edit], result)) { result = `${result.slice(0, patch.offset)}${patch.text}${result.slice(patch.offset + patch.deleteLength)}`; }
			return result;
		};
		const first = applyCloseDeletion('class C {\n    void Main();\n\n\n}');
		assert.strictEqual(first, 'class C {\n    void Main();\n\n}');
		const second = applyCloseDeletion(first), third = applyCloseDeletion(second);
		assert.strictEqual(second, 'class C {\n    void Main();\n}');
		assert.strictEqual(third, 'class C {\n    void Main();}');
	});

	test('allows a range that removes both halves', () => {
		const text = 'call({ value: true });', shadow = new ShadowStructure(text, 'typescript');
		assert.deepStrictEqual(shadow.planRepairs([change(text, text.indexOf('{'), text.indexOf('}') - text.indexOf('{') + 1)]), []);
	});

	test('allows deletion of a stale paired brace when another close already balances it', () => {
		const text = 'class Fixture { void Run() { return; }} void Main() {} }', shadow = new ShadowStructure(text, 'csharp');
		const redundant = text.indexOf('}}') + 1, edit = change(text, redundant, 1), resulting = `${text.slice(0, redundant)}${text.slice(redundant + 1)}`;
		assert.deepStrictEqual(shadow.planRepairs([edit], resulting), []);
	});

	test('allows deleting the first of newline-separated closes when the second rebinds', () => {
		const text = 'class Fixture\n{\n    void Run()\n    {\n        return;\n    }\n    }\n}\n', shadow = new ShadowStructure(text, 'csharp');
		const firstClose = text.indexOf('    }') + 4, edit = change(text, firstClose, 1), resulting = `${text.slice(0, firstClose)}${text.slice(firstClose + 1)}`;
		assert.deepStrictEqual(shadow.planRepairs([edit], resulting), []);
	});

	test('still restores a required closing brace after checking resulting balance', () => {
		const text = 'class Fixture { void Run() { return; } }', shadow = new ShadowStructure(text, 'csharp'), close = text.lastIndexOf('}');
		const edit = change(text, close, 1), resulting = text.slice(0, close);
		assert.strictEqual(shadow.planRepairs([edit], resulting)[0]?.text, '}');
	});

	test('preserves UUID ownership when unchanged pairs shift during reindexing', () => {
		const shadow = new ShadowStructure('class Fixture { void Run() {} }', 'csharp'), ids = shadow.pairs.map(pair => pair.id);
		shadow.reindex('\nclass Fixture { void Run() {} }', 'csharp');
		assert.deepStrictEqual(shadow.pairs.map(pair => pair.id).sort(), ids.sort());
	});

	test('allows pasted replacements that supply equivalent tokens', () => {
		const code = 'const value = { nested: true };', shadow = new ShadowStructure(code, 'typescript');
		assert.deepStrictEqual(shadow.planRepairs([change(code, code.indexOf('{'), 1, '{')]), []);
		assert.deepStrictEqual(shadow.planRepairs([change(code, code.indexOf('}'), 1, '}')]), []);

		const markup = '<section class="old">Hi</section>', tags = new ShadowStructure(markup, 'html'), start = markup.indexOf('<section');
		assert.deepStrictEqual(tags.planRepairs([change(markup, start, '<section class="old">'.length, '<section class="new">')]), []);
	});

	test('restores the exact deleted tag token', () => {
		const text = '<section class="hero"><span>Hi</span></section>', shadow = new ShadowStructure(text, 'html'), start = text.indexOf('<section');
		assert.strictEqual(shadow.planRepairs([change(text, start, '<section class="hero">'.length)])[0]?.text, '<section class="hero">');
		const closeEnd = text.indexOf('</section>') + '</section>'.length, partial = shadow.planRepairs([change(text, closeEnd - 1, 1)], `${text.slice(0, closeEnd - 1)}${text.slice(closeEnd)}`)[0];
		assert.deepStrictEqual([partial?.offset, partial?.deleteLength, partial?.text], [text.indexOf('</section>'), '</section'.length, '</section>']);
	});

	test('repairs the complete HTML fixture opening-tag line', () => {
		const text = '<main>\n    <article data-syntaxstitch-target="html">\n        <p>Content</p>\n    </article>\n</main>\n';
		const shadow = new ShadowStructure(text, 'html'), start = text.indexOf('    <article'), length = '    <article data-syntaxstitch-target="html">\n'.length;
		const repaired = applyRepair(text, change(text, start, length), shadow);
		assert.ok(repaired.includes('<article data-syntaxstitch-target="html">'));
		assert.strictEqual((repaired.match(/<article/g) ?? []).length, 1);
	});

	test('indexes Python indent and dedent boundaries', () => {
		const shadow = new ShadowStructure('if ready:\n    run()\ndone()\n', 'python');
		assert.ok(shadow.pairs.some(pair => pair.type === 'indent'));
	});
});

suite('Extension integration', () => {
	test('moves a meaningful block closer upward one line per deletion', async function () {
		this.timeout(5000);
		await vscode.commands.executeCommand('syntaxstitch.showOutput');
		const content = 'class C {\n    internal static void Main();\n\n\n}', document = await vscode.workspace.openTextDocument({ language: 'csharp', content });
		await vscode.window.showTextDocument(document);
		await vscode.commands.executeCommand('syntaxstitch.rebuildShadowIndex');
		for (const expected of ['class C {\n    internal static void Main();\n\n}', 'class C {\n    internal static void Main();\n}', 'class C {\n    internal static void Main();}']) {
			const close = document.getText().lastIndexOf('}'), edit = new vscode.WorkspaceEdit();
			edit.delete(document.uri, new vscode.Range(document.positionAt(close), document.positionAt(close + 1)));
			assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
			const deadline = Date.now() + 750;
			while (document.getText() !== expected && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 20)); }
			assert.strictEqual(document.getText(), expected);
		}
	});

	test('steps inside adjacent closers then selects the inner pair on deletion', async function () {
		this.timeout(5000);
		const content = 'console.log(add(x, y))', document = await vscode.workspace.openTextDocument({ language: 'javascript', content });
		const editor = await vscode.window.showTextDocument(document), deleteLeft = async (): Promise<void> => {
			await vscode.commands.executeCommand('syntaxstitch.deleteLeft');
			const deadline = Date.now() + 1000;
			while (document.getText() !== content && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 20)); }
			assert.strictEqual(document.getText(), content);
		};
		await vscode.commands.executeCommand('syntaxstitch.rebuildShadowIndex');

		const outerClose = content.lastIndexOf(')');
		editor.selection = new vscode.Selection(document.positionAt(outerClose + 1), document.positionAt(outerClose + 1));
		await deleteLeft();
		const cursorDeadline = Date.now() + 1000;
		while (document.offsetAt(editor.selection.active) !== outerClose && Date.now() < cursorDeadline) { await new Promise(resolve => setTimeout(resolve, 20)); }
		assert.ok(editor.selection.isEmpty);
		assert.strictEqual(document.offsetAt(editor.selection.active), outerClose);

		await deleteLeft();
		const selectionDeadline = Date.now() + 1000;
		while (editor.selection.isEmpty && Date.now() < selectionDeadline) { await new Promise(resolve => setTimeout(resolve, 20)); }
		assert.strictEqual(document.getText(editor.selection), '(x, y)');
	});

	test('selects a meaningful multiline block when its closer is directly deleted', async function () {
		this.timeout(5000);
		const content = `function incrementX({amount = 1} = {}) {
    x += amount;
}`, document = await vscode.workspace.openTextDocument({ language: 'javascript', content });
		const editor = await vscode.window.showTextDocument(document), close = content.lastIndexOf('}');
		await vscode.commands.executeCommand('syntaxstitch.rebuildShadowIndex');
		editor.selection = new vscode.Selection(document.positionAt(close + 1), document.positionAt(close + 1));

		await vscode.commands.executeCommand('syntaxstitch.deleteLeft');
		const deadline = Date.now() + 1000;
		while ((document.getText() !== content || editor.selection.isEmpty) && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 20)); }
		assert.strictEqual(document.getText(), content);
		assert.strictEqual(document.getText(editor.selection), content.slice(content.lastIndexOf('{'), close + 1));
	});

	test('restores a partially deleted closing tag once and selects its full element', async function () {
		this.timeout(5000);
		const content = '<main><p>Hello</p></main>', document = await vscode.workspace.openTextDocument({ language: 'html', content });
		const editor = await vscode.window.showTextDocument(document), closeEnd = content.indexOf('</p>') + '</p>'.length;
		await vscode.commands.executeCommand('syntaxstitch.rebuildShadowIndex');
		editor.selection = new vscode.Selection(document.positionAt(closeEnd), document.positionAt(closeEnd));

		await vscode.commands.executeCommand('syntaxstitch.deleteLeft');
		const deadline = Date.now() + 1000;
		while ((document.getText() !== content || editor.selection.isEmpty) && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 20)); }
		assert.strictEqual(document.getText(), content);
		assert.strictEqual(document.getText(editor.selection), '<p>Hello</p>');
	});

	test('corrects a provider cursor left after an auto-inserted closing tag', async function () {
		this.timeout(5000);
		const document = await vscode.workspace.openTextDocument({ language: 'html', content: '' }), editor = await vscode.window.showTextDocument(document);
		await vscode.commands.executeCommand('syntaxstitch.rebuildShadowIndex');
		const edit = new vscode.WorkspaceEdit();
		edit.insert(document.uri, new vscode.Position(0, 0), '<p></p>');
		assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
		const deadline = Date.now() + 1000;
		while (document.offsetAt(editor.selection.active) !== '<p>'.length && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 20)); }
		assert.strictEqual(document.getText(), '<p></p>');
		assert.strictEqual(document.offsetAt(editor.selection.active), '<p>'.length);
	});

	test('tabs from an inner closing tag to the next closing tag', async () => {
		const content = '<p><h1>Manual repair test</h1></p>', document = await vscode.workspace.openTextDocument({ language: 'html', content });
		const editor = await vscode.window.showTextDocument(document), innerClose = content.indexOf('</h1>'), outerClose = content.indexOf('</p>');
		await vscode.commands.executeCommand('syntaxstitch.rebuildShadowIndex');
		editor.selection = new vscode.Selection(document.positionAt(innerClose), document.positionAt(innerClose));

		assert.strictEqual(await vscode.commands.executeCommand<boolean>('syntaxstitch.tabToNextClosingTag'), true);
		assert.ok(editor.selection.isEmpty);
		assert.strictEqual(document.offsetAt(editor.selection.active), outerClose);
	});

	test('tabs past a correctly indented closing brace', async () => {
		const content = 'function run() {\n    if (ready) {\n        work();\n    }\n}', document = await vscode.workspace.openTextDocument({ language: 'javascript', content });
		const editor = await vscode.window.showTextDocument(document), close = content.indexOf('    }') + 4;
		await vscode.commands.executeCommand('syntaxstitch.rebuildShadowIndex');
		editor.selection = new vscode.Selection(document.positionAt(close), document.positionAt(close));

		assert.strictEqual(await vscode.commands.executeCommand<boolean>('syntaxstitch.structuralTab'), true);
		assert.ok(editor.selection.isEmpty);
		assert.strictEqual(document.offsetAt(editor.selection.active), close + 1);
	});

	test('pair label selects full lines, links to its start, and selects its exact block', async () => {
		const content = 'function run() {\n    work();\n}', document = await vscode.workspace.openTextDocument({ language: 'javascript', content });
		const editor = await vscode.window.showTextDocument(document);
		await vscode.commands.executeCommand('syntaxstitch.rebuildShadowIndex');
		const hints = await vscode.commands.executeCommand<vscode.InlayHint[]>('vscode.executeInlayHintProvider', document.uri, new vscode.Range(document.positionAt(0), document.positionAt(content.length)));
		const hint = hints.find(candidate => Array.isArray(candidate.label) && candidate.label.some(part => part.value.includes('function run()')));
		assert.ok(hint && Array.isArray(hint.label));
		assert.strictEqual(hint.label.map(part => part.value).join(''), '← function run() · L1–L3 · 3 lines');
		assert.strictEqual(await vscode.commands.executeCommand<boolean>(hint.label[0].command!.command, ...hint.label[0].command!.arguments ?? []), true);
		assert.strictEqual(document.getText(editor.selection), content);
		assert.strictEqual(await vscode.commands.executeCommand<boolean>(hint.label[1].command!.command, ...hint.label[1].command!.arguments ?? []), true);
		assert.ok(editor.selection.isEmpty);
		assert.strictEqual(editor.selection.active.line, 0);
		assert.strictEqual(editor.selection.active.character, 0);
		assert.strictEqual(await vscode.commands.executeCommand<boolean>(hint.label[3].command!.command, ...hint.label[3].command!.arguments ?? []), true);
		assert.strictEqual(document.getText(editor.selection), content.slice(content.indexOf('{')));
	});

	test('selects and expands a matching structure from its closing boundary', async () => {
		await vscode.commands.executeCommand('syntaxstitch.showOutput');
		const content = 'call({ value: true })', document = await vscode.workspace.openTextDocument({ language: 'javascript', content });
		const editor = await vscode.window.showTextDocument(document), cursor = document.positionAt(content.indexOf('}') + 1);
		editor.selection = new vscode.Selection(cursor, cursor);
		assert.strictEqual(await vscode.commands.executeCommand<number>('syntaxstitch.selectMatchingStructure'), 1);
		assert.strictEqual(document.getText(editor.selection), '{ value: true }');
		assert.strictEqual(await vscode.commands.executeCommand<number>('syntaxstitch.selectMatchingStructure'), 1);
		assert.strictEqual(document.getText(editor.selection), '({ value: true })');
		assert.strictEqual(await vscode.commands.executeCommand<number>('syntaxstitch.selectInnerStructure'), 1);
		assert.strictEqual(document.getText(editor.selection), '{ value: true }');
	});

	test('returns to the prior method selection after expanding to its class', async () => {
		const content = `internal static class Fixture
{
    internal static int CalculateTotal(int[] values)
    {
        return values.Sum();
    }

    internal static void Main() => Console.WriteLine(CalculateTotal(new[] { 4, 8, 15, 16, 23, 42 }));
}`;
		const document = await vscode.workspace.openTextDocument({ language: 'csharp', content }), editor = await vscode.window.showTextDocument(document);
		const methodStart = content.indexOf('    internal static int'), methodEnd = content.indexOf('\n\n    internal static void Main');
		editor.selection = new vscode.Selection(document.positionAt(methodStart), document.positionAt(methodEnd));
		const methodSelection = editor.selection;

		assert.strictEqual(await vscode.commands.executeCommand<number>('syntaxstitch.selectMatchingStructure'), 1);
		assert.strictEqual(document.getText(editor.selection), content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1));
		assert.strictEqual(await vscode.commands.executeCommand<number>('syntaxstitch.selectInnerStructure'), 1);
		assert.deepStrictEqual(editor.selection, methodSelection);
	});

	test('peels nested empty pairs one layer per Delete while preserving cursor intent', async function () {
		this.timeout(5000);
		await vscode.commands.executeCommand('syntaxstitch.showOutput');
		const document = await vscode.workspace.openTextDocument({ language: 'javascript', content: '(({()}))' });
		const editor = await vscode.window.showTextDocument(document), expected = ['(({}))', '(())', '()', ''];
		await vscode.commands.executeCommand('syntaxstitch.rebuildShadowIndex');
		editor.selection = new vscode.Selection(document.positionAt(4), document.positionAt(4));
		for (const text of expected) {
			const cursor = editor.selection.active, edit = new vscode.WorkspaceEdit();
			edit.delete(document.uri, new vscode.Range(cursor, cursor.translate(0, 1)));
			assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
			const deadline = Date.now() + 750;
			while (document.getText() !== text && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 20)); }
			assert.strictEqual(document.getText(), text, `Expected one nested layer to be removed after Delete`);
			assert.strictEqual(document.offsetAt(editor.selection.active), Math.ceil(text.length / 2));
		}
	});

	test('removes an empty multiline pair with one boundary deletion', async () => {
		const content = 'internal static void Main() => Console.WriteLine(CalculateTotal(new[\n\n    ]{ 4, 8, 15, 16, 23, 42 }));';
		const document = await vscode.workspace.openTextDocument({ language: 'csharp', content });
		const close = document.getText().indexOf(']'), edit = new vscode.WorkspaceEdit();
		edit.delete(document.uri, new vscode.Range(document.positionAt(close), document.positionAt(close + 1)));
		assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
		const deadline = Date.now() + 2000;
		while (!document.getText().includes('new{') && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 20)); }
		assert.ok(document.getText().includes('new{'));
		assert.ok(!document.getText().includes('['));
	});

	test('heals an HTML opening tag deleted through WorkspaceEdit', async () => {
		await vscode.commands.executeCommand('syntaxstitch.showOutput');
		await vscode.commands.executeCommand('syntaxstitch.resetStatistics');
		const opening = '<article data-syntaxstitch-target="html">', content = `<main>\n    ${opening}\n        <p>Content</p>\n    </article>\n</main>\n`;
		const document = await vscode.workspace.openTextDocument({ language: 'html', content }), start = content.indexOf(opening);
		const edit = new vscode.WorkspaceEdit();
		edit.delete(document.uri, new vscode.Range(document.positionAt(start), document.positionAt(start + opening.length)));
		assert.strictEqual(await vscode.workspace.applyEdit(edit), true);

		const deadline = Date.now() + 2000;
		while (!document.getText().includes(opening) && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 20)); }
		assert.ok(document.getText().includes(opening), 'SyntaxStitch did not restore the HTML opening tag');
		const statistics = await vscode.commands.executeCommand<{ total: number; byKind: { tag: number } }>('syntaxstitch.showStatistics');
		assert.strictEqual(statistics.total, 1);
		assert.strictEqual(statistics.byKind.tag, 1);
	});

	test('allows the later closing brace to replace a deleted earlier close', async () => {
		const content = 'class Fixture\n{\n    void Run()\n    {\n        return;\n    }\n    }\n}\n';
		const document = await vscode.workspace.openTextDocument({ language: 'csharp', content }), firstClose = content.indexOf('    }') + 4;
		const edit = new vscode.WorkspaceEdit();
		edit.delete(document.uri, new vscode.Range(document.positionAt(firstClose), document.positionAt(firstClose + 1)));
		assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
		await new Promise(resolve => setTimeout(resolve, 100));
		assert.strictEqual(document.getText(), `${content.slice(0, firstClose)}${content.slice(firstClose + 1)}`);
	});

	test('realigns a touched closing brace with its matched opening brace', async () => {
		const content = 'class Fixture\n{\n    void Run()\n    {\n        return;\n    }\n}\n';
		const document = await vscode.workspace.openTextDocument({ language: 'csharp', content }), closeLine = 5;
		const edit = new vscode.WorkspaceEdit();
		edit.replace(document.uri, new vscode.Range(new vscode.Position(closeLine, 0), new vscode.Position(closeLine, 4)), '            ');
		assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
		const deadline = Date.now() + 2000;
		while (document.lineAt(closeLine).text !== '    }' && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 20)); }
		assert.strictEqual(document.lineAt(closeLine).text, '    }');
	});

	test('counts immediate repeat repairs of one boundary as one incident', async () => {
		await vscode.commands.executeCommand('syntaxstitch.resetStatistics');
		const content = 'const value = call(1);', document = await vscode.workspace.openTextDocument({ language: 'javascript', content }), close = content.indexOf(')');
		for (let attempt = 0; attempt < 2; attempt++) {
			const edit = new vscode.WorkspaceEdit();
			edit.delete(document.uri, new vscode.Range(document.positionAt(close), document.positionAt(close + 1)));
			assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
			const deadline = Date.now() + 2000;
			while (!document.getText().includes(')') && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 20)); }
			assert.ok(document.getText().includes(')'));
		}
		const statistics = await vscode.commands.executeCommand<{ total: number; byKind: { parenthesis: number } }>('syntaxstitch.showStatistics');
		assert.strictEqual(statistics.total, 1);
		assert.strictEqual(statistics.byKind.parenthesis, 1);
	});
});
