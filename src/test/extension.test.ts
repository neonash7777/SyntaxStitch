import * as assert from 'assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { repairStatusPresentation } from '../extension';
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
const manualFixture = (name: string): string => fs.readFileSync(path.join(__dirname, '..', '..', 'manual-tests', name), 'utf8');
const maximumPairDepth = (shadow: ShadowStructure): number => Math.max(...shadow.pairs.map(candidate => shadow.pairs.filter(pair => pair.openIdx <= candidate.openIdx && candidate.closeIdx <= pair.closeIdx).length));

suite('Status presentation', () => {
	test('keeps the tray compact and puts symbol counts in the tooltip', () => {
		const presentation = repairStatusPresentation({ total: 1234, byKind: { square: 2, parenthesis: 3, curly: 5, tag: 7, quote: 11, indent: 13 }, unclassified: 0 }, true);
		assert.strictEqual(presentation.text, '{S} 1234');
		for (const detail of ['()  Parentheses: 3', '[]  Square brackets: 2', '{}  Curly braces: 5', '<>  Tags: 7', '""  Quotes: 11', '\\t  Indentation: 13']) { assert.ok(presentation.tooltip.includes(detail)); }
		assert.ok(presentation.tooltip.startsWith('SyntaxStitch is enabled.'));
		assert.ok(presentation.tooltip.includes('1234 repairs\n()') && !presentation.tooltip.includes('1234 repairs\n\n'));
	});
});

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

	test('advanced manual fixtures retain embedded languages and deep nesting', () => {
		const cases = [
			{ name: 'advanced-embedded.html', languageId: 'html', languages: ['html', 'css', 'javascript'], minimumPairs: 25, minimumDepth: 5 },
			{ name: 'advanced-component.tsx', languageId: 'typescriptreact', languages: ['typescriptreact', 'html'], minimumPairs: 25, minimumDepth: 7 },
			{ name: 'advanced-nested.js', languageId: 'javascript', languages: ['javascript', 'html'], minimumPairs: 30, minimumDepth: 6 },
		];
		for (const fixture of cases) {
			const shadow = new ShadowStructure(manualFixture(fixture.name), fixture.languageId), languages = new Set(shadow.pairs.map(pair => pair.languageId));
			assert.ok(shadow.pairs.length >= fixture.minimumPairs, `${fixture.name} should contain at least ${fixture.minimumPairs} indexed pairs`);
			assert.ok(maximumPairDepth(shadow) >= fixture.minimumDepth, `${fixture.name} should nest at least ${fixture.minimumDepth} pairs deep`);
			for (const language of fixture.languages) { assert.ok(languages.has(language), `${fixture.name} should include ${language} pairs`); }
		}
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

	test('removes the corresponding tag when exactly one complete tag is deleted', () => {
		const removeTag = (text: string, token: string): string => {
			const shadow = new ShadowStructure(text, 'html'), start = text.indexOf(token), edit = change(text, start, token.length), resulting = `${text.slice(0, start)}${text.slice(start + token.length)}`;
			return shadow.planRepairs([edit], resulting).reduce((current, patch) => `${current.slice(0, patch.offset)}${patch.text}${current.slice(patch.offset + patch.deleteLength)}`, resulting);
		};
		const text = '<main><section class="report"><p>Keep me</p></section></main>';
		assert.strictEqual(removeTag(text, '<section class="report">'), '<main><p>Keep me</p></main>');
		assert.strictEqual(removeTag(text, '</section>'), '<main><p>Keep me</p></main>');
	});

	test('unwraps meaningful grouping parentheses when either boundary is deleted', () => {
		const removeBoundary = (text: string, offset: number): string => {
			const shadow = new ShadowStructure(text, 'javascript'), edit = change(text, offset, 1), resulting = `${text.slice(0, offset)}${text.slice(offset + 1)}`;
			return shadow.planRepairs([edit], resulting).reduce((current, patch) => `${current.slice(0, patch.offset)}${patch.text}${current.slice(patch.offset + patch.deleteLength)}`, resulting);
		};
		assert.strictEqual(removeBoundary('(cat)', 0), 'cat');
		assert.strictEqual(removeBoundary('(cat)', 4), 'cat');
		assert.strictEqual(removeBoundary('const pet = (cat);', 'const pet = (cat);'.indexOf(')')), 'const pet = cat;');
		assert.strictEqual(removeBoundary('call(cat)', 'call(cat)'.indexOf(')')), 'call(cat)');
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

	test('restores a partially deleted tag token', () => {
		const text = '<section class="hero"><span>Hi</span></section>', shadow = new ShadowStructure(text, 'html'), start = text.indexOf('<section');
		assert.strictEqual(shadow.planRepairs([change(text, start, '<section class="hero">'.length - 1)])[0]?.text, '<section class="hero">');
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
	suiteSetup(async () => {
		const extension = vscode.extensions.all.find(candidate => candidate.packageJSON.name === 'syntaxstitch');
		assert.ok(extension, 'SyntaxStitch development extension was not loaded');
		await extension.activate();
	});

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

	test('unwraps standalone grouping parentheses with direct Backspace', async () => {
		const document = await vscode.workspace.openTextDocument({ language: 'javascript', content: '(cat)' }), editor = await vscode.window.showTextDocument(document);
		await vscode.commands.executeCommand('syntaxstitch.rebuildShadowIndex');
		const end = document.positionAt(document.getText().length);
		editor.selection = new vscode.Selection(end, end);
		await vscode.commands.executeCommand('syntaxstitch.deleteLeft');
		const deadline = Date.now() + 1000;
		while (document.getText() !== 'cat' && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 20)); }
		assert.strictEqual(document.getText(), 'cat');
		assert.ok(editor.selection.isEmpty);
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

	test('synchronizes opening tag name replacements without counting a repair', async () => {
		await vscode.commands.executeCommand('syntaxstitch.resetStatistics');
		const content = '<section><p>Keep me</p></section>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), nameStart = content.indexOf('section');
		await vscode.window.showTextDocument(document);
		await vscode.commands.executeCommand('syntaxstitch.rebuildShadowIndex');
		const edit = new vscode.WorkspaceEdit();
		edit.replace(document.uri, new vscode.Range(document.positionAt(nameStart), document.positionAt(nameStart + 'section'.length)), 'div');
		assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
		const deadline = Date.now() + 1000;
		while (document.getText() !== '<div><p>Keep me</p></div>' && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 20)); }
		assert.strictEqual(document.getText(), '<div><p>Keep me</p></div>');
		const statistics = await vscode.commands.executeCommand<{ total: number }>('syntaxstitch.showStatistics');
		assert.strictEqual(statistics.total, 0);
	});

	test('allows deleting a tag name before typing its replacement', async () => {
		await vscode.commands.executeCommand('syntaxstitch.resetStatistics');
		const content = '<section><p>Keep me</p></section>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), nameStart = content.indexOf('section');
		await vscode.window.showTextDocument(document);
		await vscode.commands.executeCommand('syntaxstitch.rebuildShadowIndex');
		const remove = new vscode.WorkspaceEdit();
		remove.delete(document.uri, new vscode.Range(document.positionAt(nameStart), document.positionAt(nameStart + 'section'.length)));
		assert.strictEqual(await vscode.workspace.applyEdit(remove), true);
		await new Promise(resolve => setTimeout(resolve, 50));
		assert.strictEqual(document.getText(), '<><p>Keep me</p></section>');
		const insert = new vscode.WorkspaceEdit();
		insert.insert(document.uri, document.positionAt(nameStart), 'div');
		assert.strictEqual(await vscode.workspace.applyEdit(insert), true);
		const deadline = Date.now() + 1000;
		while (document.getText() !== '<div><p>Keep me</p></div>' && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 20)); }
		assert.strictEqual(document.getText(), '<div><p>Keep me</p></div>');
		const statistics = await vscode.commands.executeCommand<{ total: number }>('syntaxstitch.showStatistics');
		assert.strictEqual(statistics.total, 0);
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

	test('pair label actions fold and select inner, structural, declaration, and full-line ranges', async () => {
		const content = 'function run() {\n    work();\n}', document = await vscode.workspace.openTextDocument({ language: 'javascript', content });
		const editor = await vscode.window.showTextDocument(document);
		await vscode.commands.executeCommand('syntaxstitch.rebuildShadowIndex');
		const hints = await vscode.commands.executeCommand<vscode.InlayHint[]>('vscode.executeInlayHintProvider', document.uri, new vscode.Range(document.positionAt(0), document.positionAt(content.length))), hint = hints.find(candidate => Array.isArray(candidate.label) && candidate.label.some(part => part.value.includes('function run()')));
		assert.ok(hint && Array.isArray(hint.label));
		const parts = hint.label;
		assert.strictEqual(parts.map(part => part.value).join(''), 'function run() L1↔L3 3 Lines');
		assert.strictEqual(hint.tooltip, undefined);
		const menu = parts.find(part => part.value.includes('function run()'))!.tooltip;
		assert.ok(menu instanceof vscode.MarkdownString);
		for (const command of ['syntaxstitch.togglePairFold', 'syntaxstitch.foldPairContents', 'syntaxstitch.selectPairContents', 'syntaxstitch.selectPairWithDeclaration', 'syntaxstitch.selectPairLabel', 'syntaxstitch.selectPairLabelLines']) { assert.ok(menu.value.includes(`command:${command}?`)); }
		assert.ok(!menu.value.includes('[Before]') && !menu.value.includes('[After]') && !menu.value.includes('$(arrow-'));
		assert.ok(menu.value.indexOf('[Fold / unfold]') < menu.value.indexOf('[Fold / unfold contents]'));
		assert.ok(menu.value.includes('$(fold-down) [Fold / unfold contents]'));
		assert.ok(menu.value.includes('↔ [Select inner content]'));
		assert.ok(!menu.value.includes('$(selection) [Select inner content]'));
		assert.ok(menu.value.includes('[Select declaration + block]'));
		assert.ok(menu.value.includes('[Select delimiters + content]'));
		assert.ok(menu.value.includes('$(symbol-array) [Select delimiters + content]'));
		assert.ok(!menu.value.includes('[$(symbol-array)'));
		assert.deepStrictEqual(parts.filter(part => part.command).map(part => part.value), ['function run()', 'L1', '↔', 'L3', '3 Lines']);
		assert.deepStrictEqual(parts.filter(part => part.command).map(part => part.command!.command), ['syntaxstitch.selectPairWithDeclaration', 'syntaxstitch.selectPairStartLine', 'syntaxstitch.selectPairContents', 'syntaxstitch.selectPairEndLine', 'syntaxstitch.selectPairLabelLines']);
		assert.strictEqual(parts.find(part => part.value === 'L1')!.command!.command, 'syntaxstitch.selectPairStartLine');
		assert.strictEqual(parts.find(part => part.value === '↔')!.command!.command, 'syntaxstitch.selectPairContents');
		assert.strictEqual(parts.find(part => part.value === 'L3')!.command!.command, 'syntaxstitch.selectPairEndLine');
		assert.strictEqual(parts.find(part => part.value === '3 Lines')!.command!.command, 'syntaxstitch.selectPairLabelLines');
		assert.ok(!parts.find(part => part.value === ' ')!.command && !parts.find(part => part.value === ' ')!.tooltip);
		assert.ok(typeof menu.isTrusted === 'object' && menu.isTrusted.enabledCommands.length === 6);
		const target = parts.find(part => part.command?.command === 'syntaxstitch.selectPairWithDeclaration')!.command!.arguments![0], run = (command: string) => vscode.commands.executeCommand<boolean>(command, target);
		editor.selection = new vscode.Selection(document.positionAt(content.indexOf('work')), document.positionAt(content.indexOf('work')));
		const cursor = editor.selection;
		assert.strictEqual(await run('syntaxstitch.togglePairFold'), true);
		assert.notDeepStrictEqual(editor.selection, cursor);
		assert.ok(editor.selection.isEmpty);
		assert.strictEqual(document.offsetAt(editor.selection.active), content.indexOf('{'));
		assert.strictEqual(await run('syntaxstitch.togglePairFold'), true);
		assert.strictEqual(await run('syntaxstitch.selectPairContents'), true);
		assert.strictEqual(document.getText(editor.selection), '\n    work();\n');
		assert.strictEqual(await run('syntaxstitch.selectPairWithDeclaration'), true);
		assert.strictEqual(document.getText(editor.selection), content);
		assert.strictEqual(await run('syntaxstitch.selectPairLabel'), true);
		assert.strictEqual(document.getText(editor.selection), content.slice(content.indexOf('{')));
		assert.strictEqual(await run('syntaxstitch.goToPairStart'), true);
		assert.ok(editor.selection.isEmpty);
		assert.strictEqual(editor.selection.active.line, 0);
		assert.strictEqual(editor.selection.active.character, content.indexOf('{'));
		assert.strictEqual(await run('syntaxstitch.goAfterPairStart'), true);
		assert.strictEqual(document.offsetAt(editor.selection.active), content.indexOf('{') + 1);
		assert.strictEqual(await run('syntaxstitch.selectPairStartToken'), true);
		assert.strictEqual(document.getText(editor.selection), '{');
		assert.strictEqual(await run('syntaxstitch.selectPairStartLine'), true);
		assert.strictEqual(document.getText(editor.selection), 'function run() {');
		assert.strictEqual(await run('syntaxstitch.goToPairEnd'), true);
		assert.ok(editor.selection.isEmpty);
		assert.strictEqual(document.offsetAt(editor.selection.active), content.lastIndexOf('}'));
		assert.strictEqual(await run('syntaxstitch.goAfterPairEnd'), true);
		assert.strictEqual(document.offsetAt(editor.selection.active), content.length);
		assert.strictEqual(await run('syntaxstitch.selectPairEndToken'), true);
		assert.strictEqual(document.getText(editor.selection), '}');
		assert.strictEqual(await run('syntaxstitch.selectPairEndLine'), true);
		assert.strictEqual(document.getText(editor.selection), '}');
		assert.strictEqual(await run('syntaxstitch.selectPairLabelLines'), true);
		assert.strictEqual(document.getText(editor.selection), content);

		editor.selection = new vscode.Selection(document.positionAt(content.length), document.positionAt(content.length));
		assert.strictEqual(await run('syntaxstitch.togglePairFold'), true);
		assert.strictEqual(document.offsetAt(editor.selection.active), content.indexOf('{'));
		assert.strictEqual(await run('syntaxstitch.togglePairFold'), true);
	});

	test('shows labels for every multiline pair sharing a TSX closing line', async () => {
		const content = `export function NestedList({ values }: { values: number[] }) {
    return (
        <ul>
            {values.map(value => (
                <li key={value}>{value}</li>
            ))}
        </ul>
    );
}`;
		const document = await vscode.workspace.openTextDocument({ language: 'typescriptreact', content }), editor = await vscode.window.showTextDocument(document);
		await vscode.commands.executeCommand('syntaxstitch.rebuildShadowIndex');
		const hints = await vscode.commands.executeCommand<vscode.InlayHint[]>('vscode.executeInlayHintProvider', document.uri, new vscode.Range(document.positionAt(0), document.positionAt(content.length))), closers = content.indexOf('))}');
		const positions = hints.map(hint => document.offsetAt(hint.position));
		assert.ok(positions.includes(closers + 1), 'Expected a label after the callback body parenthesis');
		assert.ok(positions.includes(closers + 2), 'Expected a label after the map call parenthesis');
		assert.ok(positions.includes(closers + 3), 'Expected a label after the JSX expression brace');
		const labelAt = (offset: number) => hints.find(hint => document.offsetAt(hint.position) === offset && Array.isArray(hint.label));
		const grouped = labelAt(closers + 1)!, map = labelAt(closers + 2)!;
		assert.ok(Array.isArray(grouped.label) && !grouped.label.some(part => part.value === 'map()'));
		assert.ok(Array.isArray(map.label) && map.label.some(part => part.value === 'map()' || part.value.endsWith('.map')));
		const target = map.label.find(part => part.command?.command === 'syntaxstitch.selectPairWithDeclaration')!.command!.arguments![0], mapOpen = content.indexOf('(', content.indexOf('values.map'));
		assert.strictEqual(await vscode.commands.executeCommand<boolean>('syntaxstitch.selectPairWithDeclaration', target), true);
		assert.strictEqual(document.getText(editor.selection), content.slice(mapOpen, closers + 2));
	});

	test('folds and unfolds collapsible contents without folding the owner block', async () => {
		const content = 'function run() {\n    if (ready) {\n        if (nested) {\n            work();\n        }\n        continueWork();\n    }\n    finish();\n}', document = await vscode.workspace.openTextDocument({ language: 'javascript', content });
		const editor = await vscode.window.showTextDocument(document);
		await vscode.commands.executeCommand('syntaxstitch.rebuildShadowIndex');
		const hints = await vscode.commands.executeCommand<vscode.InlayHint[]>('vscode.executeInlayHintProvider', document.uri, new vscode.Range(document.positionAt(0), document.positionAt(content.length))), hint = hints.find(candidate => Array.isArray(candidate.label) && candidate.label.some(part => part.value.includes('function run()')));
		assert.ok(hint && Array.isArray(hint.label));
		const target = hint.label.find(part => part.command?.command === 'syntaxstitch.selectPairWithDeclaration')!.command!.arguments![0], caret = document.positionAt(content.indexOf('finish'));
		editor.selection = new vscode.Selection(caret, caret);

		assert.strictEqual(await vscode.commands.executeCommand<boolean>('syntaxstitch.foldPairContents', target), true);
		await new Promise(resolve => setTimeout(resolve, 50));
		assert.ok(editor.selection.isEmpty && editor.selection.active.isEqual(caret));
		assert.ok(!editor.visibleRanges.some(range => range.contains(new vscode.Position(2, 0))));
		assert.ok(editor.visibleRanges.some(range => range.contains(new vscode.Position(8, 0))));
		assert.strictEqual(await vscode.commands.executeCommand<boolean>('syntaxstitch.foldPairContents', target), true);
		await new Promise(resolve => setTimeout(resolve, 50));
		assert.ok(editor.visibleRanges.some(range => range.contains(new vscode.Position(2, 0))));
		assert.ok(!editor.visibleRanges.some(range => range.contains(new vscode.Position(3, 0))));
		assert.ok(editor.visibleRanges.some(range => range.contains(new vscode.Position(8, 0))));
	});

	test('leaves an owner expanded when it has no collapsible contents', async () => {
		const content = 'function run() {\n    work();\n}', document = await vscode.workspace.openTextDocument({ language: 'javascript', content });
		const editor = await vscode.window.showTextDocument(document);
		await vscode.commands.executeCommand('syntaxstitch.rebuildShadowIndex');
		const hints = await vscode.commands.executeCommand<vscode.InlayHint[]>('vscode.executeInlayHintProvider', document.uri, new vscode.Range(document.positionAt(0), document.positionAt(content.length))), hint = hints.find(candidate => Array.isArray(candidate.label) && candidate.label.some(part => part.value.includes('function run()')));
		assert.ok(hint && Array.isArray(hint.label));
		const target = hint.label.find(part => part.command?.command === 'syntaxstitch.selectPairWithDeclaration')!.command!.arguments![0];

		assert.strictEqual(await vscode.commands.executeCommand<boolean>('syntaxstitch.foldPairContents', target), true);
		await new Promise(resolve => setTimeout(resolve, 50));
		for (let line = 0; line < document.lineCount; line++) { assert.ok(editor.visibleRanges.some(range => range.contains(new vscode.Position(line, 0)))); }
	});

	test('navigates before and after complete tags and selects each full tag token', async () => {
		const opening = '<section data-kind="demo">', closing = '</section>', content = `  ${opening}\n    <p>Content</p>\n  ${closing}`;
		const document = await vscode.workspace.openTextDocument({ language: 'html', content });
		const editor = await vscode.window.showTextDocument(document);
		await vscode.commands.executeCommand('syntaxstitch.rebuildShadowIndex');
		const hints = await vscode.commands.executeCommand<vscode.InlayHint[]>('vscode.executeInlayHintProvider', document.uri, new vscode.Range(document.positionAt(0), document.positionAt(content.length))), hint = hints.find(candidate => Array.isArray(candidate.label) && candidate.label.some(part => part.command?.command === 'syntaxstitch.selectPairWithDeclaration'));
		assert.ok(hint && Array.isArray(hint.label));
		const target = hint.label.find(part => part.command?.command === 'syntaxstitch.selectPairWithDeclaration')!.command!.arguments![0], run = (command: string) => vscode.commands.executeCommand<boolean>(command, target);
		assert.strictEqual(await run('syntaxstitch.goToPairStart'), true);
		assert.strictEqual(document.offsetAt(editor.selection.active), content.indexOf(opening));
		assert.strictEqual(await run('syntaxstitch.goAfterPairStart'), true);
		assert.strictEqual(document.offsetAt(editor.selection.active), content.indexOf(opening) + opening.length);
		assert.strictEqual(await run('syntaxstitch.selectPairStartToken'), true);
		assert.strictEqual(document.getText(editor.selection), opening);
		assert.strictEqual(await run('syntaxstitch.selectPairStartLine'), true);
		assert.strictEqual(document.getText(editor.selection), `  ${opening}`);
		assert.strictEqual(await run('syntaxstitch.goToPairEnd'), true);
		assert.strictEqual(document.offsetAt(editor.selection.active), content.indexOf(closing));
		assert.strictEqual(await run('syntaxstitch.goAfterPairEnd'), true);
		assert.strictEqual(document.offsetAt(editor.selection.active), content.indexOf(closing) + closing.length);
		assert.strictEqual(await run('syntaxstitch.selectPairEndToken'), true);
		assert.strictEqual(document.getText(editor.selection), closing);
		assert.strictEqual(await run('syntaxstitch.selectPairEndLine'), true);
		assert.strictEqual(document.getText(editor.selection), `  ${closing}`);
	});

	test('owner selects a preceding C# declaration with its own-line brace block', async () => {
		const content = 'internal static int CalculateTotal(int[] values)\n    {\n        // SyntaxStitch C# target follows.\n        return values.Sum();\n    }';
		const document = await vscode.workspace.openTextDocument({ language: 'csharp', content });
		const editor = await vscode.window.showTextDocument(document);
		await vscode.commands.executeCommand('syntaxstitch.rebuildShadowIndex');
		const hints = await vscode.commands.executeCommand<vscode.InlayHint[]>('vscode.executeInlayHintProvider', document.uri, new vscode.Range(document.positionAt(0), document.positionAt(content.length))), hint = hints.find(candidate => Array.isArray(candidate.label) && candidate.label.some(part => part.command?.command === 'syntaxstitch.selectPairWithDeclaration'));
		assert.ok(hint && Array.isArray(hint.label));
		const target = hint.label.find(part => part.command?.command === 'syntaxstitch.selectPairWithDeclaration')!.command!.arguments![0];
		assert.strictEqual(await vscode.commands.executeCommand<boolean>('syntaxstitch.selectPairWithDeclaration', target), true);
		assert.strictEqual(document.getText(editor.selection), content);
	});

	test('keeps pair metadata visible when a declaration exceeds the inlay hint limit', async () => {
		const declaration = 'function calculateAnExceptionallyLongQuarterlyRevenueProjection(customerAccounts) {', content = `${declaration}\n    return customerAccounts.length;\n}`;
		const document = await vscode.workspace.openTextDocument({ language: 'javascript', content });
		await vscode.window.showTextDocument(document);
		await vscode.commands.executeCommand('syntaxstitch.rebuildShadowIndex');
		const hints = await vscode.commands.executeCommand<vscode.InlayHint[]>('vscode.executeInlayHintProvider', document.uri, new vscode.Range(document.positionAt(0), document.positionAt(content.length))), hint = hints.find(candidate => Array.isArray(candidate.label) && candidate.label.some(part => part.command?.command === 'syntaxstitch.selectPairWithDeclaration'));
		assert.ok(hint && Array.isArray(hint.label));
		const label = hint.label.map(part => part.value).join(''), owner = hint.label.find(part => part.command?.command === 'syntaxstitch.selectPairWithDeclaration')!;
		assert.ok(label.length <= 43);
		assert.ok(label.endsWith(' L1↔L3 3 Lines'));
		assert.ok(!label.includes('...') && !label.includes('…'));
		assert.ok(owner.tooltip instanceof vscode.MarkdownString && owner.tooltip.value.includes('calculateAnExceptionallyLongQuarterlyRevenueProjection') && owner.tooltip.value.includes('customerAccounts'));
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

	test('removes the matching closing tag after exact opening-tag deletion', async () => {
		await vscode.commands.executeCommand('syntaxstitch.showOutput');
		await vscode.commands.executeCommand('syntaxstitch.resetStatistics');
		const opening = '<article data-syntaxstitch-target="html">', content = `<main>\n    ${opening}\n        <p>Content</p>\n    </article>\n</main>\n`;
		const document = await vscode.workspace.openTextDocument({ language: 'html', content }), start = content.indexOf(opening);
		const edit = new vscode.WorkspaceEdit();
		edit.delete(document.uri, new vscode.Range(document.positionAt(start), document.positionAt(start + opening.length)));
		assert.strictEqual(await vscode.workspace.applyEdit(edit), true);

		const deadline = Date.now() + 2000;
		while (document.getText().includes('</article>') && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 20)); }
		assert.ok(!document.getText().includes(opening));
		assert.ok(!document.getText().includes('</article>'), 'SyntaxStitch did not remove the matching HTML closing tag');
		assert.ok(document.getText().includes('<p>Content</p>'));
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
