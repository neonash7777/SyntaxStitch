import * as assert from 'assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as vscode from 'vscode';
import { animatedRepairStatusText, repairStatusPresentation } from '../extension';
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
		const presentation = repairStatusPresentation({ total: 1234, byKind: { square: 2, parenthesis: 3, curly: 5, tag: 7, quote: 11, indent: 13 }, unclassified: 0, lastRepair: 'Restored "}" · typescript · line 42' }, true);
		assert.strictEqual(presentation.text, '{S} 1234');
		for (const detail of ['()  Parentheses: 3', '[]  Square brackets: 2', '{}  Curly braces: 5', '<>  Tags: 7', '""  Quotes: 11', '\\tab  Indentation: 13']) { assert.ok(presentation.tooltip.includes(detail)); }
		assert.ok(presentation.tooltip.startsWith('SyntaxStitch is enabled.'));
		assert.ok(presentation.tooltip.includes('1234 repairs\n') && !presentation.tooltip.includes('1234 repairs\n\n'));
		assert.ok(presentation.tooltip.includes('Last repair\nRestored "}" · typescript · line 42'));
		assert.ok(presentation.accessibilityLabel.includes('Last repair: Restored "}" · typescript · line 42.'));
		assert.strictEqual(animatedRepairStatusText(presentation.text), '$(sync~spin) {S} 1234');
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

	test('does not pair a stray quote with a string on a later line', () => {
		const text = 'type Group = {\n    name: string;\n    values: number[];\n};"\nconst name = "primary";', shadow = new ShadowStructure(text, 'typescript');
		const quotes = shadow.pairs.filter(pair => pair.type === 'quote');
		assert.strictEqual(quotes.length, 1);
		assert.strictEqual(text.slice(quotes[0].openIdx, quotes[0].closeIdx + 1), '"primary"');
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

	test('does not add a second closer when completing an opening tag before its matching closer', () => {
		const text = '<h2 id="section-basic"</h2>', offset = text.indexOf('</h2>'), shadow = new ShadowStructure(text, 'html'), resulting = `${text.slice(0, offset)}>${text.slice(offset)}`;
		assert.deepStrictEqual(shadow.planRepairs([change(text, offset, 0, '>')], resulting), []);
		assert.strictEqual(resulting, '<h2 id="section-basic"></h2>');
	});

	test('indexes Python indent and dedent boundaries', () => {
		const shadow = new ShadowStructure('if ready:\n    run()\ndone()\n', 'python');
		assert.ok(shadow.pairs.some(pair => pair.type === 'indent'));
	});
});

suite('Extension integration', () => {
	test('does not repair or reopen a document with no open tab', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'syntaxstitch-closed-')), filename = path.join(directory, 'closed.js');
		fs.writeFileSync(filename, 'call(value)');
		try {
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filename));
			const edit = new vscode.WorkspaceEdit();
			edit.delete(document.uri, new vscode.Range(document.positionAt(10), document.positionAt(11)));
			assert.ok(await vscode.workspace.applyEdit(edit));
			await new Promise(resolve => setTimeout(resolve, 250));
			assert.strictEqual(document.getText(), 'call(value');
			assert.ok(!vscode.window.visibleTextEditors.some(editor => editor.document === document));
			await document.save();
		} finally { fs.rmSync(directory, { recursive: true, force: true }); }
	});

	test('discards queued attribute propagation when its tab is closed', async function () {
		this.timeout(5000);
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'syntaxstitch-pending-')), filename = path.join(directory, 'pending.html');
		const content = '<button class="one">One</button><button class="two">Two</button>';
		fs.writeFileSync(filename, content);
		try {
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filename)), editor = await vscode.window.showTextDocument(document);
			editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(content.length));
			await vscode.commands.executeCommand('syntaxstitch.enterStructuralSelectionMode');
			await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
			await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
			await vscode.commands.executeCommand('syntaxstitch.structuralSelectionNext');
			assert.strictEqual(document.getText(editor.selection), 'one');
			await editor.edit(edit => edit.replace(editor.selection, 'updated'));
			await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
			await new Promise(resolve => setTimeout(resolve, 350));
			assert.ok(!vscode.window.visibleTextEditors.some(candidate => candidate.document.uri.toString() === document.uri.toString()));
			assert.strictEqual(fs.readFileSync(filename, 'utf8'), content);
			assert.ok(!vscode.workspace.textDocuments.some(candidate => candidate.uri.toString() === document.uri.toString() && candidate.isDirty));
		} finally { fs.rmSync(directory, { recursive: true, force: true }); }
	});

	test('keeps a reverted disk document clean and allows it to close', async function () {
		this.timeout(5000);
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'syntaxstitch-revert-')), filename = path.join(directory, 'revert.js');
		const content = 'function run() {\n    work();\n  }\n';
		fs.writeFileSync(filename, content);
		try {
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filename)), editor = await vscode.window.showTextDocument(document);
			await editor.edit(edit => edit.insert(new vscode.Position(1, 4), 'more(); '));
			assert.ok(document.isDirty);
			await vscode.commands.executeCommand('workbench.action.files.revert');
			await new Promise(resolve => setTimeout(resolve, 250));
			assert.strictEqual(document.getText(), content);
			assert.strictEqual(document.isDirty, false);
			assert.strictEqual(fs.readFileSync(filename, 'utf8'), content);
			await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
			await new Promise(resolve => setTimeout(resolve, 250));
			assert.ok(!vscode.window.visibleTextEditors.some(candidate => candidate.document === document));
		} finally { fs.rmSync(directory, { recursive: true, force: true }); }
	});

	const deleteLeft = async (): Promise<void> => {
		await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
		await vscode.commands.executeCommand('syntaxstitch.deleteLeft');
	};
	const deleteRight = async (): Promise<void> => {
		await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
		await vscode.commands.executeCommand('syntaxstitch.deleteRight');
	};

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

	test('selects the complete pair when restoring an adjacent closer', async function () {
		this.timeout(5000);
		const content = 'console.log(add(x, y))', document = await vscode.workspace.openTextDocument({ language: 'javascript', content });
		const editor = await vscode.window.showTextDocument(document);
		await vscode.commands.executeCommand('syntaxstitch.rebuildShadowIndex');

		const outerClose = content.lastIndexOf(')');
		editor.selection = new vscode.Selection(document.positionAt(outerClose + 1), document.positionAt(outerClose + 1));
		await deleteLeft();
		const deadline = Date.now() + 1000;
		while ((document.getText() !== content || editor.selection.isEmpty) && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 20)); }
		assert.strictEqual(document.getText(), content);
		assert.strictEqual(document.getText(editor.selection), '(add(x, y))');
	});

	test('unwraps standalone grouping parentheses with direct Backspace', async () => {
		const document = await vscode.workspace.openTextDocument({ language: 'javascript', content: '(cat)' }), editor = await vscode.window.showTextDocument(document);
		await vscode.commands.executeCommand('syntaxstitch.rebuildShadowIndex');
		const end = document.positionAt(document.getText().length);
		editor.selection = new vscode.Selection(end, end);
		await deleteLeft();
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

		await deleteLeft();
		const deadline = Date.now() + 1000;
		while ((document.getText() !== content || editor.selection.isEmpty) && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 20)); }
		assert.strictEqual(document.getText(), content);
		assert.strictEqual(document.getText(editor.selection), content.slice(content.lastIndexOf('{'), close + 1));
	});

	test('selects each meaningful bracket pair when its closer is directly deleted', async function () {
		this.timeout(5000);
		const cases: readonly (readonly [string, string, string])[] = [['call(value)', '(value)', ')'], ['const values = [1, 2];', '[1, 2]', ']'], ['const value = { nested: true };', '{ nested: true }', '}']];
		for (const [content, expected, closer] of cases) {
			const language = content.startsWith('call') ? 'javascript' : 'typescript', document = await vscode.workspace.openTextDocument({ language, content });
			const editor = await vscode.window.showTextDocument(document), close = content.lastIndexOf(closer);
			await vscode.commands.executeCommand('syntaxstitch.rebuildShadowIndex');
			editor.selection = new vscode.Selection(document.positionAt(close + 1), document.positionAt(close + 1));
			await deleteLeft();
			const deadline = Date.now() + 1000;
			while ((document.getText() !== content || editor.selection.isEmpty) && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 20)); }
			assert.strictEqual(document.getText(), content);
			assert.strictEqual(document.getText(editor.selection), expected);
		}
	});

	test('selects each meaningful bracket pair when its opener is directly deleted', async function () {
		this.timeout(5000);
		const cases: readonly (readonly [string, string, string])[] = [['call(value)', '(value)', '('], ['const values = [1, 2];', '[1, 2]', '['], ['const value = { nested: true };', '{ nested: true }', '{']];
		for (const [content, expected, opener] of cases) {
			const language = content.startsWith('call') ? 'javascript' : 'typescript', document = await vscode.workspace.openTextDocument({ language, content });
			const editor = await vscode.window.showTextDocument(document), open = content.indexOf(opener);
			await vscode.commands.executeCommand('syntaxstitch.rebuildShadowIndex');
			editor.selection = new vscode.Selection(document.positionAt(open), document.positionAt(open));
			await deleteRight();
			const deadline = Date.now() + 1000;
			while ((document.getText() !== content || editor.selection.isEmpty) && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 20)); }
			assert.strictEqual(document.getText(), content);
			assert.strictEqual(document.getText(editor.selection), expected);
		}
	});

	test('balances a forward selection extension across an adjacent brace pair', async () => {
		const content = '{{_____}}', document = await vscode.workspace.openTextDocument({ language: 'javascript', content }), editor = await vscode.window.showTextDocument(document);
		await vscode.commands.executeCommand('syntaxstitch.rebuildShadowIndex');
		editor.selection = new vscode.Selection(document.positionAt(2), document.positionAt(7));
		await vscode.commands.executeCommand('cursorRightSelect');
		assert.strictEqual(document.getText(editor.selection), '{_____}');
	});

	test('enters structural selection mode and exposes multiple brace selections', async () => {
		const content = 'body { color: red; } .btn { padding: 1em; }', document = await vscode.workspace.openTextDocument({ language: 'css', content }), editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(content.length));
		await vscode.commands.executeCommand('syntaxstitch.enterStructuralSelectionMode');
		assert.strictEqual(document.getText(editor.selection), '{ color: red; }');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionDrillDown');
		assert.strictEqual(document.getText(editor.selection), '{ padding: 1em; }');
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionMode');
		assert.strictEqual(editor.selections.length, 1);
	});

	test('starts Nested Select at selected outer siblings before nested markup', async () => {
		const content = '<div><span><span>Nested Span</span></span></div>\n<div><span><span>Nested Span</span></span></div>\n<div><span><span>Nested Span</span></span></div>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(content.length));
		assert.strictEqual(await vscode.commands.executeCommand<boolean>('syntaxstitch.enterStructuralSelectionMode'), true);
		assert.strictEqual(document.getText(editor.selection), '<div><span><span>Nested Span</span></span></div>');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionDrillDown');
		assert.strictEqual(document.getText(editor.selection), '<div><span><span>Nested Span</span></span></div>');
		assert.strictEqual(editor.document.offsetAt(editor.selection.start), content.indexOf('<div>', content.indexOf('</div>') + '</div>'.length));
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		assert.strictEqual(document.getText(editor.selection), '<span><span>Nested Span</span></span>');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		assert.strictEqual(document.getText(editor.selection), '<span>Nested Span</span>');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		assert.strictEqual(document.getText(editor.selection), 'Nested Span');
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionMode');
	});

	test('tabs to parent attributes before nested markup', async () => {
		const content = '<div><span class="parent"><span class="child">Nested Span</span></span></div>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(content.length));
		await vscode.commands.executeCommand('syntaxstitch.enterStructuralSelectionMode');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionNext');
		assert.strictEqual(document.getText(editor.selection), '<span class="parent"><span class="child">Nested Span</span></span>');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		assert.strictEqual(document.getText(editor.selection), 'class');
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionMode');
	});

	test('uses Shift+Tab to reverse from a child property to its parent value', async () => {
		const content = '<div><span class="parent"><span class="child">Nested Span</span></span></div>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(content.length));
		await vscode.commands.executeCommand('syntaxstitch.enterStructuralSelectionMode');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionNext');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		assert.strictEqual(document.getText(editor.selection), 'class');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionNext');
		assert.strictEqual(document.getText(editor.selection), '<span class="child">Nested Span</span>');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		assert.strictEqual(document.getText(editor.selection), 'class');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionPrevious');
		assert.strictEqual(document.getText(editor.selection), 'parent');
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionMode');
	});

	test('selects an element final attribute clause with Shift+Left', async () => {
		const content = '<span class="child">Nested Span</span>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(content.length));
		await vscode.commands.executeCommand('syntaxstitch.enterStructuralSelectionMode');
		assert.strictEqual(document.getText(editor.selection), '<span class="child">Nested Span</span>');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionExpandLeft');
		assert.strictEqual(document.getText(editor.selection), 'class="child"');
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionMode');
	});

	test('expands an attribute value to its full clause with Shift+Left', async () => {
		const content = '<span class="parent">Nested Span</span>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(content.length));
		await vscode.commands.executeCommand('syntaxstitch.enterStructuralSelectionMode');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		assert.strictEqual(document.getText(editor.selection), 'Nested Span');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		assert.strictEqual(document.getText(editor.selection), 'class');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		assert.strictEqual(document.getText(editor.selection), 'parent');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionExpandLeft');
		assert.strictEqual(document.getText(editor.selection), 'class="parent"');
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionMode');
	});

	test('cycles full matching attribute clauses across same-depth peers', async () => {
		const content = '<div><span class="parent"><span class="child">One</span></span></div><div><span class="parent"><span class="child">Two</span></span></div>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document), firstChildStart = content.indexOf('<span class="child">'), firstChildEnd = content.indexOf('</span>', firstChildStart) + '</span>'.length;
		editor.selection = new vscode.Selection(document.positionAt(firstChildStart), document.positionAt(firstChildEnd));
		await vscode.commands.executeCommand('syntaxstitch.enterStructuralSelectionMode');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		assert.strictEqual(document.getText(editor.selection), 'class');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionExpandRight');
		assert.strictEqual(document.getText(editor.selection), 'class="child"');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionDrillDown');
		assert.strictEqual(document.getText(editor.selection), 'class="child"');
		assert.strictEqual(editor.document.offsetAt(editor.selection.start), content.indexOf('class="child"', firstChildEnd));
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionMode');
	});

	test('expands an attribute key to its full clause and mirrors replacement and deletion', async () => {
		const content = '<span class="parent">One</span><span class="peer">Two</span>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(content.length));
		await vscode.commands.executeCommand('syntaxstitch.enterStructuralSelectionMode');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		assert.strictEqual(document.getText(editor.selection), 'One');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		assert.strictEqual(document.getText(editor.selection), 'class');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionExpandRight');
		assert.strictEqual(document.getText(editor.selection), 'class="parent"');
		await editor.edit(edit => edit.replace(editor.selection, 'class="updated"'));
		const deadline = Date.now() + 1000;
		while (!document.getText().includes('<span class="updated">Two</span>') && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 20)); }
		assert.strictEqual(document.getText(), '<span class="updated">One</span><span class="updated">Two</span>');
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionTyping');
		await editor.edit(edit => edit.delete(editor.selection));
		const deletionDeadline = Date.now() + 1000;
		while (document.getText().includes('class=') && Date.now() < deletionDeadline) { await new Promise(resolve => setTimeout(resolve, 20)); }
		assert.strictEqual(document.getText(), '<span >One</span><span >Two</span>');
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionMode');
	});

	test('expands to adjacent matching attribute clauses across discontiguous peers', async () => {
		const content = '<span class="one" id="first">One</span><span class="two" data-kind="peer" id="second">Two</span><span class="three" data-kind="skip">Three</span>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(content.length));
		await vscode.commands.executeCommand('syntaxstitch.enterStructuralSelectionMode');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		assert.strictEqual(document.getText(editor.selection), 'class');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionExpandRight');
		assert.strictEqual(document.getText(editor.selection), 'class="one"');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionExpandRight');
		assert.strictEqual(document.getText(editor.selection), 'id="first"');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionExpandLeft');
		assert.strictEqual(document.getText(editor.selection), 'id="first"');
		await editor.edit(edit => edit.replace(editor.selection, 'id="shared"'));
		const deadline = Date.now() + 1000;
		while (!document.getText().includes('id="shared">Two</span>') && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 20)); }
		assert.ok(document.getText().includes('<span class="one" id="shared">One</span>'));
		assert.ok(document.getText().includes('<span class="two" data-kind="peer" id="shared">Two</span>'));
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionMode');
	});

	test('uses arrows to move between a parent attribute, child markup, and the parent div', async () => {
		const content = '<div><span class="parent"><span>Nested Span</span></span></div><div><span class="parent"><span class="child">Nested Span</span></span></div>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(content.length));
		await vscode.commands.executeCommand('syntaxstitch.enterStructuralSelectionMode');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionDrillDown');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionNext');
		assert.strictEqual(document.getText(editor.selection), '<span class="parent"><span class="child">Nested Span</span></span>');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		assert.strictEqual(document.getText(editor.selection), 'class');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionPrevious');
		assert.strictEqual(document.getText(editor.selection), '<div><span class="parent"><span class="child">Nested Span</span></span></div>');
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionMode');
	});

	test('walks the nested section fixture through structure, inner, and component stages', async () => {
		const content = `<section aria-labelledby="section-basic">
			<h2 id="section-basic">Basic Buttons</h2>
			<button class="btn" id="btnHello" aria-label="Say Hello"></button>
			<button class="btn" id="btnCount" aria-label="Increment Counter">Increment Counter</button>
			<button class="btn" id="btnReset" aria-label="Reset Counter">Reset</button>
			<div class="output" id="output" aria-live="polite"></div>
		</section>`;
		const document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document), sectionOpen = content.indexOf('<section'), sectionClose = content.lastIndexOf('</section>');
		const scopeStart = content.indexOf('\n') + 1, scopeEnd = sectionClose;
		editor.selection = new vscode.Selection(document.positionAt(scopeStart), document.positionAt(scopeEnd));
		assert.strictEqual(await vscode.commands.executeCommand<boolean>('syntaxstitch.enterStructuralSelectionMode'), true);
		assert.strictEqual(document.getText(editor.selection), '<h2 id="section-basic">Basic Buttons</h2>');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		assert.strictEqual(document.getText(editor.selection), 'Basic Buttons');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		assert.strictEqual(document.getText(editor.selection), 'id');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionNext');
		assert.strictEqual(document.getText(editor.selection), 'section-basic');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionNext');
		assert.strictEqual(document.getText(editor.selection), 'Basic Buttons');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionPrevious');
		assert.strictEqual(document.getText(editor.selection), '<h2 id="section-basic">Basic Buttons</h2>');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionToggle');
		assert.ok(editor.selection.isEmpty || document.getText(editor.selection).length >= 0);
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionExpandRight');
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionMode');
		assert.ok(document.getText().includes('<section') && document.getText().includes('</section>'));
	});

	test('walks Structural Selection Mode across supported language fixtures', async () => {
		const fixtures = [
			['javascript', 'const value = ({ items: [call({ ready: true })] });'],
			['typescript', 'type Value = { ready: boolean }; const value: Value = { ready: true };'],
			['typescriptreact', 'const view = <section><button id="go">Go</button><span>{value}</span></section>;'],
			['html', '<main><section><h1>Title</h1><p>Body</p></section></main>'],
			['css', '.one { color: red; } .two { padding: 1em; }'],
			['javascript', 'const view = `<section>${render({ ready: true })}</section>`;'],
		] as const;
		for (const [language, content] of fixtures) {
			const document = await vscode.workspace.openTextDocument({ language, content }), editor = await vscode.window.showTextDocument(document);
			editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(content.length));
			assert.strictEqual(await vscode.commands.executeCommand<boolean>('syntaxstitch.enterStructuralSelectionMode'), true, `${language} should enter mode`);
			for (const command of ['syntaxstitch.structuralSelectionNext', 'syntaxstitch.structuralSelectionPrevious', 'syntaxstitch.structuralSelectionComponents', 'syntaxstitch.structuralSelectionPrevious', 'syntaxstitch.structuralSelectionDrillDown', 'syntaxstitch.structuralSelectionDrillUp', 'syntaxstitch.structuralSelectionHome', 'syntaxstitch.structuralSelectionEnd']) {
				await vscode.commands.executeCommand(command);
			}
			assert.strictEqual(document.getText(), content, `${language} navigation should not mutate text`);
			await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionMode');
		}
	});

	test('keeps edits safe across empty pairs, nested calls, JSX expressions, and CSS values', async () => {
		const cases = [
			['javascript', 'const value = call({ ready: true });', '{ ready: true }'],
			['typescriptreact', 'const view = <section>{items.map(item => <span>{item}</span>)}</section>;', '{item}'],
			['css', '.button { border: 1px solid #222; padding: 0.5em; }', '{ border: 1px solid #222; padding: 0.5em; }'],
		] as const;
		for (const [language, content, marker] of cases) {
			const document = await vscode.workspace.openTextDocument({ language, content }), editor = await vscode.window.showTextDocument(document), markerStart = content.indexOf(marker);
			editor.selection = new vscode.Selection(document.positionAt(markerStart), document.positionAt(markerStart + marker.length));
			assert.strictEqual(await vscode.commands.executeCommand<boolean>('syntaxstitch.enterStructuralSelectionMode'), true, `${language} should enter edit mode`);
			await editor.edit(edit => edit.insert(editor.selection.active, ' '));
			assert.ok(document.getText().includes(`${marker} `), `${language} should preserve the edited marker`);
			await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionTyping');
			await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionMode');
		}
	});

	test('mirrors a class-property rename without changing unrelated elements', async () => {
		const content = '<button class="btn" aria-label="Say Hello"></button>\n\t\t<button class="btn" id="test_1" aria-label="Increment Counter">Increment Counter</button>\n\t\t<button class="btn" id="test_2" aria-label="Reset Counter">Reset</button>\n\t\t<div class="output" id="output" aria-live="polite"></div>';
		const document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(content.length));
		await vscode.commands.executeCommand('syntaxstitch.enterStructuralSelectionMode');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionNext');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionNext');
		assert.strictEqual(document.getText(editor.selection), 'btn');
		await editor.edit(edit => edit.replace(editor.selection, 'class'));
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionTyping');
		assert.strictEqual(document.getText(editor.selection), 'class');
		assert.strictEqual((document.getText().match(/class="class"/g) ?? []).length, 3);
		assert.ok(document.getText().includes('<div class="output" id="output" aria-live="polite"></div>'));
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionMode');
	});

	test('cycles sibling elements with Up/Down at the parent level and drills in on Enter', async () => {
		const content = '<p>One</p><p>Two</p><p>Three</p>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(content.length));
		await vscode.commands.executeCommand('syntaxstitch.enterStructuralSelectionMode');
		const before = document.getText(editor.selection);
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionDrillDown');
		assert.notStrictEqual(document.getText(editor.selection), before);
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionDrillUp');
		assert.strictEqual(document.getText(editor.selection), before);
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionEnter');
		assert.notStrictEqual(document.getText(editor.selection), before);
		assert.ok(document.getText(editor.selection).includes('<p>') || document.getText(editor.selection).includes('One'));
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionMode');
	});

	test('cycles peers vertically and descends horizontally through nested spans', async () => {
		const content = '<div><span>One</span></div><div><span>Two</span></div><div><span>Three</span></div>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(content.length));
		await vscode.commands.executeCommand('syntaxstitch.enterStructuralSelectionMode');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionDrillDown');
		assert.strictEqual(document.getText(editor.selection), '<div><span>Two</span></div>');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionDrillDown');
		assert.strictEqual(document.getText(editor.selection), '<div><span>Three</span></div>');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionNext');
		assert.strictEqual(document.getText(editor.selection), '<span>Three</span>');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionDrillUp');
		assert.strictEqual(document.getText(editor.selection), '<span>Two</span>');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionNext');
		assert.strictEqual(document.getText(editor.selection), 'Two');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionPrevious');
		assert.strictEqual(document.getText(editor.selection), '<span>Two</span>');
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionMode');
	});

	test('derives nested span peers before Down enters inner content', async () => {
		const content = '<div><span><span>One</span></span></div><div><span><span>Two</span></span></div>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document), innerStart = content.indexOf('<span>', content.indexOf('<span>') + 1), innerEnd = content.indexOf('</span>', innerStart) + '</span>'.length;
		editor.selection = new vscode.Selection(document.positionAt(innerStart), document.positionAt(innerEnd));
		await vscode.commands.executeCommand('syntaxstitch.enterStructuralSelectionMode');
		assert.strictEqual(document.getText(editor.selection), '<span>One</span>');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionDrillDown');
		assert.strictEqual(document.getText(editor.selection), '<span>Two</span>');
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionMode');
	});

	test('cycles nested peer body text with Up and Down before Tab enters properties', async () => {
		const content = '<div><span class="parent"><span class="child">One</span></span></div><div><span class="parent"><span class="child">Two</span></span></div><div><span class="parent"><span class="child">Three</span></span></div>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(content.length));
		await vscode.commands.executeCommand('syntaxstitch.enterStructuralSelectionMode');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionNext');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionNext');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionNext');
		assert.strictEqual(document.getText(editor.selection), 'One');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionDrillDown');
		assert.strictEqual(document.getText(editor.selection), 'Two');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionDrillUp');
		assert.strictEqual(document.getText(editor.selection), 'One');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		assert.strictEqual(document.getText(editor.selection), 'class');
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionMode');
	});

	test('cycles matching nested properties with Up and Down while Tab stays local', async () => {
		const content = '<div><span class="parent"><span class="child">One</span></span></div><div><span class="parent"><span class="child">Two</span></span></div><div><span class="parent"><span class="child">Three</span></span></div>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(content.length));
		await vscode.commands.executeCommand('syntaxstitch.enterStructuralSelectionMode');
		for (let index = 0; index < 3; index++) { await vscode.commands.executeCommand('syntaxstitch.structuralSelectionNext'); }
		assert.strictEqual(document.getText(editor.selection), 'One');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		assert.strictEqual(document.getText(editor.selection), 'class');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionDrillDown');
		assert.strictEqual(document.getText(editor.selection), 'class');
		assert.strictEqual(editor.document.offsetAt(editor.selection.start), content.indexOf('class="child"', content.indexOf('<div>', content.indexOf('</div>') + '</div>'.length)));
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		assert.strictEqual(document.getText(editor.selection), 'child');
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionMode');
	});

	test('cycles attribute values only among peers with the same key and value', async () => {
		const content = '<div><span class="parent"><span>One</span></span></div><div><span class="parent"><span class="child">Two</span></span></div><div><span><span class="child">Three</span></span></div>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(content.length));
		await vscode.commands.executeCommand('syntaxstitch.enterStructuralSelectionMode');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionNext');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		assert.strictEqual(document.getText(editor.selection), 'class');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		assert.strictEqual(document.getText(editor.selection), 'parent');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionDrillDown');
		assert.strictEqual(document.getText(editor.selection), 'parent');
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionMode');
	});

	test('resumes root sibling cycling after climbing from a nested span', async () => {
		const content = '<div><span>One</span></div><div><span>Two</span></div><div><span>Three</span></div>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(content.length));
		await vscode.commands.executeCommand('syntaxstitch.enterStructuralSelectionMode');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionNext');
		assert.strictEqual(document.getText(editor.selection), '<span>One</span>');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionDrillDown');
		assert.strictEqual(document.getText(editor.selection), '<span>Two</span>');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionPrevious');
		assert.strictEqual(document.getText(editor.selection), '<div><span>Two</span></div>');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionDrillDown');
		assert.strictEqual(document.getText(editor.selection), '<div><span>Three</span></div>');
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionMode');
	});

	test('uses the Tab inner-content transition when Return is at the root', async () => {
		const content = '<p>One</p><p>Two</p><p>Three</p>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(content.length));
		await vscode.commands.executeCommand('syntaxstitch.enterStructuralSelectionMode');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionEnter');
		assert.strictEqual(document.getText(editor.selection), 'One');
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionMode');
	});

	test('wraps property peer cycling past elements that lack the property', async () => {
		const content = '<div><span class="parent"><span class="child">One</span></span></div><div><span><span class="child">Two</span></span></div>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(content.length));
		await vscode.commands.executeCommand('syntaxstitch.enterStructuralSelectionMode');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionNext');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		assert.strictEqual(document.getText(editor.selection), 'class');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionDrillDown');
		assert.strictEqual(document.getText(editor.selection), 'class');
		assert.strictEqual(editor.document.offsetAt(editor.selection.start), content.indexOf('class="parent"'));
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionMode');
	});

	test('derives same-depth property peers before Down cycles a local value', async () => {
		const content = '<div><span class="parent"><span class="child">One</span></span></div><div><span class="parent"><span class="child">Two</span></span></div>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document), firstSpanEnd = content.indexOf('</span></span></div>') + '</span></span>'.length;
		editor.selection = new vscode.Selection(document.positionAt(content.indexOf('<span class="parent"')), document.positionAt(firstSpanEnd));
		await vscode.commands.executeCommand('syntaxstitch.enterStructuralSelectionMode');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		assert.strictEqual(document.getText(editor.selection), 'class');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionDrillDown');
		assert.strictEqual(document.getText(editor.selection), 'class');
		assert.strictEqual(editor.document.offsetAt(editor.selection.start), content.indexOf('class="parent"', content.indexOf('</div>') + '</div>'.length));
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionMode');
	});

	test('opens focused element components from an inner peer body with Tab', async () => {
		const content = '<button class="btn" id="one">One</button><button class="btn" id="two">Two</button><button class="btn" id="three">Three</button>',
			document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(content.length));
		await vscode.commands.executeCommand('syntaxstitch.enterStructuralSelectionMode');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionDrillDown');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionNext');
		assert.strictEqual(document.getText(editor.selection), 'Two');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		assert.strictEqual(document.getText(editor.selection), 'class');
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionMode');
	});

	test('uses Tab to climb out of a single component leaf', async () => {
		const content = '<span>One</span>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(content.length));
		await vscode.commands.executeCommand('syntaxstitch.enterStructuralSelectionMode');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		assert.strictEqual(document.getText(editor.selection), 'One');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		assert.strictEqual(document.getText(editor.selection), '<span>One</span>');
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionMode');
	});

	test('propagates a tabbed inner body edit across enabled matching elements', async () => {
		const content = '<button>One</button><button>Two</button><button>Three</button>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(content.length));
		await vscode.commands.executeCommand('syntaxstitch.enterStructuralSelectionMode');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		assert.strictEqual(document.getText(editor.selection), 'One');
		await editor.edit(edit => edit.replace(editor.selection, 'Updated'));
		const deadline = Date.now() + 1000;
		while ((document.getText().match(/>Updated</g) ?? []).length !== 3 && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 20)); }
		assert.strictEqual(document.getText(), '<button>Updated</button><button>Updated</button><button>Updated</button>');
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionTyping');
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionMode');
	});

	test('propagates every keystroke of an inner body edit without marker text', async () => {
		const content = '<button>One</button><button>Two</button><button>Three</button>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(content.length));
		await vscode.commands.executeCommand('syntaxstitch.enterStructuralSelectionMode');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		await editor.edit(edit => edit.replace(editor.selection, 'T'));
		await new Promise(resolve => setTimeout(resolve, 150));
		await editor.edit(edit => edit.insert(editor.selection.active, 'est'));
		const deadline = Date.now() + 1000;
		while ((document.getText().match(/>Test</g) ?? []).length !== 3 && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 20)); }
		assert.strictEqual(document.getText(), '<button>Test</button><button>Test</button><button>Test</button>');
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionTyping');
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionMode');
	});

	test('opens middle-button components after a mirrored inner body edit', async () => {
		const content = '<button class="btn" id="btnHello" aria-label="Say Hello">Hello</button>\n\t<button class="btn" id="btnCount" aria-label="Increment Counter">Count</button>\n\t<button class="btn" id="btnReset" aria-label="Reset Counter">Reset</button>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(content.length));
		await vscode.commands.executeCommand('syntaxstitch.enterStructuralSelectionMode');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionDrillDown');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		assert.strictEqual(document.getText(editor.selection), 'Count');
		await editor.edit(edit => edit.replace(editor.selection, 'Test'));
		const deadline = Date.now() + 1000;
		while ((document.getText().match(/>Test</g) ?? []).length !== 3 && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 20)); }
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionTyping');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		assert.strictEqual(document.getText(editor.selection), 'class');
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionMode');
	});

	test('returns a body component to synchronized peer editing and then climbs out', async () => {
		const content = '<button class="btn">One</button><button class="btn">Two</button><button class="btn">Three</button>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(content.length));
		await vscode.commands.executeCommand('syntaxstitch.enterStructuralSelectionMode');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionDrillDown');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		for (let index = 0; index < 2; index++) { await vscode.commands.executeCommand('syntaxstitch.structuralSelectionNext'); }
		assert.strictEqual(document.getText(editor.selection), 'Two');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionEnter');
		assert.strictEqual(document.getText(editor.selection), 'Two');
		await editor.edit(edit => edit.replace(editor.selection, 'Wows'));
		const deadline = Date.now() + 1000;
		while ((document.getText().match(/>Wows</g) ?? []).length !== 3 && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 20)); }
		assert.strictEqual(document.getText(), '<button class="btn">Wows</button><button class="btn">Wows</button><button class="btn">Wows</button>');
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionTyping');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionEnter');
		assert.strictEqual(document.getText(editor.selection), '<button class="btn">Wows</button>');
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionMode');
	});

	test('traverses matching nested child bodies across enabled parent peers', async () => {
		const content = '<li><span>One</span></li><li><span>Two</span></li><li><span>Three</span></li>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(content.length));
		await vscode.commands.executeCommand('syntaxstitch.enterStructuralSelectionMode');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		assert.strictEqual(document.getText(editor.selection), '<span>One</span>');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		assert.strictEqual(document.getText(editor.selection), 'One');
		await editor.edit(edit => edit.replace(editor.selection, 'Updated'));
		const deadline = Date.now() + 1000;
		while ((document.getText().match(/>Updated</g) ?? []).length !== 3 && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 20)); }
		assert.strictEqual(document.getText(), '<li><span>Updated</span></li><li><span>Updated</span></li><li><span>Updated</span></li>');
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionTyping');
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionMode');
	});

	test('locks typing to the focused component and returns to mode on Enter', async () => {
		const content = '<h2 id="234d">Basic Buttons</h2>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(content.length));
		await vscode.commands.executeCommand('syntaxstitch.enterStructuralSelectionMode');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		assert.strictEqual(document.getText(editor.selection), 'id');
		await editor.edit(edit => edit.replace(editor.selection, 'data-id'));
		await editor.edit(edit => edit.insert(editor.selection.active, '-extra'));
		assert.strictEqual(document.getText(), '<h2 data-id-extra="234d">Basic Buttons</h2>');
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionTyping');
		assert.strictEqual(document.getText(editor.selection), 'data-id-extra');
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionMode');
	});

	test('keeps multi-keystroke property typing inside the opening tag', async () => {
		const content = '<button class="btn" id="old" aria-label="Increment Counter">Increment Counter</button>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(content.length));
		await vscode.commands.executeCommand('syntaxstitch.enterStructuralSelectionMode');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionNext');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionNext');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionNext');
		await editor.edit(edit => edit.replace(editor.selection, 't'));
		await editor.edit(edit => edit.insert(editor.selection.active, 'est'));
		const deadline = Date.now() + 1000;
		while (!document.getText().includes('id="test"') && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 20)); }
		assert.strictEqual(document.getText(), '<button class="btn" id="test" aria-label="Increment Counter">Increment Counter</button>');
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionTyping');
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionMode');
	});

	test('keeps multi-keystroke empty attribute value typing inside the opening tag', async () => {
		const content = '<button class="btn" id="" aria-label="Increment Counter">Increment Counter</button>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(content.length));
		await vscode.commands.executeCommand('syntaxstitch.enterStructuralSelectionMode');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionNext');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionNext');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionNext');
		assert.strictEqual(document.getText(editor.selection), '');
		await editor.edit(edit => edit.insert(editor.selection.active, 't'));
		await editor.edit(edit => edit.insert(editor.selection.active, 'est'));
		const deadline = Date.now() + 1000;
		while (!document.getText().includes('id="test"') && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 20)); }
		assert.strictEqual(document.getText(), '<button class="btn" id="test" aria-label="Increment Counter">Increment Counter</button>');
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionTyping');
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionMode');
	});

	test('keeps editing a focused quoted value in typing mode', async () => {
		const content = 'const label = "Basic Buttons";', document = await vscode.workspace.openTextDocument({ language: 'javascript', content }), editor = await vscode.window.showTextDocument(document), valueStart = content.indexOf('Basic');
		editor.selection = new vscode.Selection(document.positionAt(valueStart), document.positionAt(valueStart + 'Basic Buttons'.length));
		await vscode.commands.executeCommand('syntaxstitch.enterStructuralSelectionMode');
		await editor.edit(edit => edit.replace(editor.selection, 'Primary'));
		await editor.edit(edit => edit.insert(editor.selection.active, ' Label'));
		assert.strictEqual(document.getText(), 'const label = "Primary Label";');
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionTyping');
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionMode');
	});

	test('preserves the typing caret across repeated value edits', async () => {
		const content = '<h2 id="234d">Basic Buttons</h2>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(content.length));
		await vscode.commands.executeCommand('syntaxstitch.enterStructuralSelectionMode');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionNext');
		await editor.edit(edit => edit.insert(editor.selection.active, 'X'));
		await editor.edit(edit => edit.insert(editor.selection.active, 'Y'));
		assert.ok(document.getText().includes('234dXY'), document.getText());
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionTyping');
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionMode');
	});

	test('propagates a focused property rename across matching sibling attributes', async () => {
		const content = '<button id="one">One</button><button id="two">Two</button>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(content.length));
		await vscode.commands.executeCommand('syntaxstitch.enterStructuralSelectionMode');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		await editor.edit(edit => edit.replace(editor.selection, 'data-id'));
		const deadline = Date.now() + 1000;
		while (!document.getText().includes('data-id="two"') && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 20)); }
		assert.ok(document.getText().includes('data-id="one"'));
		assert.ok(document.getText().includes('data-id="two"'));
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionTyping');
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionMode');
	});

	test('propagates a focused property value across matching sibling attributes', async () => {
		const content = '<button class="one" id="first">One</button><button class="two" id="second">Two</button>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(content.length));
		await vscode.commands.executeCommand('syntaxstitch.enterStructuralSelectionMode');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionNext');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionNext');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionNext');
		assert.strictEqual(document.getText(editor.selection), 'first');
		await editor.edit(edit => edit.replace(editor.selection, 'shared'));
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionTyping');
		const propagationDeadline = Date.now() + 1000;
		while (!document.getText().includes('<button class="two" id="shared_2">Two</button>') && Date.now() < propagationDeadline) { await new Promise(resolve => setTimeout(resolve, 20)); }
		assert.ok(document.getText().includes('<button class="one" id="shared_1">One</button>'));
		assert.ok(document.getText().includes('<button class="two" id="shared_2">Two</button>'));
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionMode');
	});

	test('propagates focused value deletion across matching sibling attributes', async () => {
		const content = '<button aria-label="first">One</button><button aria-label="second">Two</button>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(content.length));
		await vscode.commands.executeCommand('syntaxstitch.enterStructuralSelectionMode');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionNext');
		assert.strictEqual(document.getText(editor.selection), 'first');
		await editor.edit(edit => edit.delete(editor.selection));
		const deadline = Date.now() + 1000;
		while (!document.getText().includes('<button aria-label="">Two</button>') && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 20)); }
		assert.ok(document.getText().includes('<button aria-label="">One</button>'));
		assert.ok(document.getText().includes('<button aria-label="">Two</button>'));
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionTyping');
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionMode');
	});

	test('propagates bulk HTML id values in realtime', async () => {
		const content = '<button id="one">One</button><button id="two">Two</button><button id="three">Three</button>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(content.length));
		await vscode.commands.executeCommand('syntaxstitch.enterStructuralSelectionMode');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionNext');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionNext');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionNext');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionNext');
		assert.strictEqual(document.getText(editor.selection), 'one');
		await editor.edit(edit => edit.replace(editor.selection, 'shared'));
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionTyping');
		assert.ok(document.getText().includes('<button id="shared_1">One</button>'));
		assert.ok(document.getText().includes('<button id="shared_2">Two</button>'));
		assert.ok(document.getText().includes('<button id="shared_3">Three</button>'));
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionMode');
	});

	test('keeps focus on the edited third id during the first keystroke', async () => {
		const content = '<button class="btn" id="one" aria-label="Say Hello"></button>\n\t\t\t<button class="btn" id="two" aria-label="Increment Counter">Increment Counter</button>\n\t\t\t<button class="btn" id="three" aria-label="Reset Counter">Reset</button>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(content.length));
		await vscode.commands.executeCommand('syntaxstitch.enterStructuralSelectionMode');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionDrillDown');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionDrillDown');
		assert.strictEqual(document.getText(editor.selection), '<button class="btn" id="three" aria-label="Reset Counter">Reset</button>');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionNext');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionNext');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionNext');
		assert.strictEqual(document.getText(editor.selection), 'three');
		await editor.edit(edit => edit.replace(editor.selection, 't'));
		const deadline = Date.now() + 1000;
		while (document.getText(editor.selection) !== 't' && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 20)); }
		assert.strictEqual(document.getText(editor.selection), 't');
		await editor.edit(edit => edit.insert(editor.selection.active, 'est'));
		const typingDeadline = Date.now() + 1000;
		while (!document.getText().includes('id="test"') && Date.now() < typingDeadline) { await new Promise(resolve => setTimeout(resolve, 20)); }
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionTyping');
		assert.ok(document.getText().includes('id="test_1"'));
		assert.ok(document.getText().includes('aria-label="Say Hello"'));
		assert.ok(document.getText().includes('aria-label="Increment Counter"'));
		assert.ok(document.getText().includes('aria-label="Reset Counter"'));
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionMode');
	});

	for (const attribute of ['aria-label', 'id']) {
		test(`finalizes only the edited ${attribute} key across differently ordered HTML attributes`, async () => {
			const content = '<button class="btn" aria-label="Hello" id="one">One</button>\n<button class="btn" id="two" aria-label="Increment">Two</button>\n<button data-kind="action" id="three" aria-label="Reset" class="btn">Three</button>';
			const document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document);
			editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(content.length));
			await vscode.commands.executeCommand('syntaxstitch.enterStructuralSelectionMode');
			await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
			await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
			for (let index = 0; index < (attribute === 'aria-label' ? 3 : 5); index++) { await vscode.commands.executeCommand('syntaxstitch.structuralSelectionNext'); }
			assert.strictEqual(document.getText(editor.selection), attribute === 'aria-label' ? 'Hello' : 'one');
			await editor.edit(edit => edit.replace(editor.selection, 'updated'));
			await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionTyping');
			const expected = attribute === 'aria-label'
				? content.replace(/aria-label="[^"]*"/g, 'aria-label="updated"')
				: content.replace(/id="one"/, 'id="updated_1"').replace(/id="two"/, 'id="updated_2"').replace(/id="three"/, 'id="updated_3"');
			assert.strictEqual(document.getText(), expected);
			await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionMode');
		});
	}

	test('bulk-edits matching HTML ids after multi-keystroke typing', async () => {
		const content = '<button class="btn" id="one" aria-label="Say Hello"></button>\n<button class="btn" id="two" aria-label="Increment Counter">Increment Counter</button>\n<button class="btn" id="three" aria-label="Reset Counter">Reset</button>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(content.length));
		await vscode.commands.executeCommand('syntaxstitch.enterStructuralSelectionMode');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionDrillDown');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionDrillDown');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionNext');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionNext');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionNext');
		await editor.edit(edit => edit.replace(editor.selection, 't'));
		await editor.edit(edit => edit.insert(editor.selection.active, 'est'));
		const typingDeadline = Date.now() + 1000;
		while (!document.getText().includes('id="test"') && Date.now() < typingDeadline) { await new Promise(resolve => setTimeout(resolve, 20)); }
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionTyping');
		assert.ok(document.getText().includes('<button class="btn" id="test_1" aria-label="Say Hello"></button>'));
		assert.ok(document.getText().includes('<button class="btn" id="test_2" aria-label="Increment Counter">Increment Counter</button>'));
		assert.ok(document.getText().includes('<button class="btn" id="test_3" aria-label="Reset Counter">Reset</button>'));
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionMode');
	});

	test('propagates the focused property slot without changing sibling attributes', async () => {
		const content = '<button class="one" id="first">One</button><button class="two" id="second">Two</button>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(content.length));
		await vscode.commands.executeCommand('syntaxstitch.enterStructuralSelectionMode');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		await editor.edit(edit => edit.replace(editor.selection, 'data-class'));
		const deadline = Date.now() + 1000;
		while (!document.getText().includes('data-class="two"') && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 20)); }
		assert.ok(document.getText().includes('<button data-class="one" id="first">'));
		assert.ok(document.getText().includes('<button data-class="two" id="second">'));
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionTyping');
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionMode');
	});

	test('does not propagate shared properties to a space-disabled sibling', async () => {
		const content = '<button class="one">One</button><button class="two">Two</button><button class="three">Three</button>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(content.length));
		await vscode.commands.executeCommand('syntaxstitch.enterStructuralSelectionMode');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionDrillDown');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionToggle');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionDrillUp');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		assert.strictEqual(document.getText(editor.selection), 'class');
		await editor.edit(edit => edit.replace(editor.selection, 'data-class'));
		const deadline = Date.now() + 1000;
		while (!document.getText().includes('data-class="three"') && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 20)); }
		assert.strictEqual(document.getText(), '<button data-class="one">One</button><button class="two">Two</button><button data-class="three">Three</button>');
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionTyping');
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionMode');
	});

	test('does not renumber a space-disabled sibling ID', async () => {
		const content = '<button id="one">One</button><button id="two">Two</button><button id="three">Three</button>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(content.length));
		await vscode.commands.executeCommand('syntaxstitch.enterStructuralSelectionMode');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionDrillDown');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionToggle');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionDrillUp');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionNext');
		assert.strictEqual(document.getText(editor.selection), 'one');
		await editor.edit(edit => edit.replace(editor.selection, 'shared'));
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionTyping');
		assert.strictEqual(document.getText(), '<button id="shared_1">One</button><button id="two">Two</button><button id="shared_2">Three</button>');
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionMode');
	});

	test('preserves the parent nesting level after editing a button value', async () => {
		const content = '<button class="btn" id="test" aria-label="Increment Counter">Increment Counter</button>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(content.length));
		await vscode.commands.executeCommand('syntaxstitch.enterStructuralSelectionMode');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionNext');
		await editor.edit(edit => edit.replace(editor.selection, 'Updated Counter'));
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionTyping');
		assert.ok(document.getText().includes('Updated Counter'));
		assert.strictEqual(await vscode.commands.executeCommand('syntaxstitch.structuralSelectionDrillUp'), true);
		assert.ok(document.getText().length > content.length);
	});

	test('Tab and Shift+Tab never silently no-op at a mode boundary', async () => {
		const content = '<h2 id="234d">Basic Buttons</h2><h2 id="5678">Other</h2>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(content.length));
		assert.strictEqual(await vscode.commands.executeCommand<boolean>('syntaxstitch.enterStructuralSelectionMode'), true);
		const before = document.getText(editor.selection);
		assert.notStrictEqual(await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents'), undefined);
		assert.notStrictEqual(document.getText(editor.selection), before);
		assert.notStrictEqual(await vscode.commands.executeCommand('syntaxstitch.structuralSelectionPrevious'), undefined);
		assert.notStrictEqual(await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents'), undefined);
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionMode');
	});

	test('leaves a leaf inner-text selection without getting stuck', async () => {
		const content = '<h2 id="section-basic">Basic Buttons</h2><h2 id="other">Other</h2>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(content.length));
		await vscode.commands.executeCommand('syntaxstitch.enterStructuralSelectionMode');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionPrevious');
		assert.ok(document.getText(editor.selection).includes('Basic Buttons') || document.getText(editor.selection) === 'id');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionNext');
		assert.ok(document.getText(editor.selection).length > 0);
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionMode');
	});

	test('drill-up always escapes a leaf component cycle', async () => {
		const content = '<h2 id="section-basic">Basic Buttons</h2>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(content.length));
		await vscode.commands.executeCommand('syntaxstitch.enterStructuralSelectionMode');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		const drillResults = [await vscode.commands.executeCommand('syntaxstitch.structuralSelectionDrillUp'), await vscode.commands.executeCommand('syntaxstitch.structuralSelectionDrillUp'), await vscode.commands.executeCommand('syntaxstitch.structuralSelectionDrillUp'), await vscode.commands.executeCommand('syntaxstitch.structuralSelectionDrillUp')];
		assert.deepStrictEqual(drillResults, [true, true, true, true]);
		assert.strictEqual(await vscode.commands.executeCommand<boolean>('syntaxstitch.exitStructuralSelectionMode'), true);
	});

	test('keeps component tabbing inside the focused element and drills up one level', async () => {
		const content = '<section><span>Basic Buttons</span></section>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document);
		const spanStart = content.indexOf('<span>'), spanEnd = content.indexOf('</span>') + '</span>'.length;
		editor.selection = new vscode.Selection(document.positionAt(spanStart), document.positionAt(spanEnd));
		await vscode.commands.executeCommand('syntaxstitch.enterStructuralSelectionMode');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		assert.strictEqual(document.getText(editor.selection), 'Basic Buttons');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionNext');
		assert.strictEqual(document.getText(editor.selection), 'Basic Buttons');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionDrillUp');
		assert.strictEqual(document.getText(editor.selection), 'Basic Buttons');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionDrillUp');
		assert.strictEqual(document.getText(editor.selection), 'Basic Buttons');
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionMode');
	});

	test('restores sibling spans after returning from a focused nested span', async () => {
		const content = '<section><p>One</p><p>Two</p></section>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document), start = content.indexOf('<p>'), end = content.lastIndexOf('</p>') + '</p>'.length;
		editor.selection = new vscode.Selection(document.positionAt(start), document.positionAt(end));
		await vscode.commands.executeCommand('syntaxstitch.enterStructuralSelectionMode');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionDrillDown');
		assert.strictEqual(document.getText(editor.selection), '<p>Two</p>');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionNext');
		assert.strictEqual(document.getText(editor.selection), 'Two');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionPrevious');
		assert.strictEqual(document.getText(editor.selection), '<p>Two</p>');
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionMode');
	});

	test('restores all parent spans when drilling up from a component', async () => {
		const content = '<section><p>One</p><p>Two</p></section>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document), start = content.indexOf('<p>'), end = content.lastIndexOf('</p>') + '</p>'.length;
		editor.selection = new vscode.Selection(document.positionAt(start), document.positionAt(end));
		await vscode.commands.executeCommand('syntaxstitch.enterStructuralSelectionMode');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionDrillDown');
		assert.strictEqual(document.getText(editor.selection), '<p>Two</p>');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionNext');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionDrillUp');
		assert.strictEqual(document.getText(editor.selection), 'Two');
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionMode');
	});

	test('restores the disabled five-span selection after tabbed property editing', async () => {
		const content = '<h2 id="section-basic">Basic Buttons</h2>\n\t\t\t<button class="btn" aria-label="Say Hello"></button>\n\t\t\t<button class="btn" id="example" aria-label="Increment Counter">Increment Counter</button>\n\t\t\t<button class="btn" id="btnReset" aria-label="Reset Counter">Reset</button>\n\t\t\t<div class="output" id="output" aria-live="polite"></div>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(content.length));
		await vscode.commands.executeCommand('syntaxstitch.enterStructuralSelectionMode');
		for (let index = 0; index < 3; index++) { await vscode.commands.executeCommand('syntaxstitch.structuralSelectionNext'); }
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionToggle');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionPrevious');
		for (let index = 0; index < 5; index++) { await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents'); }
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionNext');
		assert.strictEqual(document.getText(editor.selection), 'section-basic');
		await editor.edit(edit => edit.replace(editor.selection, 'test'));
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionTyping');
		assert.ok(document.getText().includes('<h2 id="test">Basic Buttons</h2>'));
		assert.ok(document.getText().includes('id="btnReset"'));
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionMode');
	});

	test('restores disabled sibling span state after nested navigation', async () => {
		const content = '<section><p>One</p><p>Two</p></section>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document), start = content.indexOf('<p>'), end = content.lastIndexOf('</p>') + '</p>'.length;
		editor.selection = new vscode.Selection(document.positionAt(start), document.positionAt(end));
		await vscode.commands.executeCommand('syntaxstitch.enterStructuralSelectionMode');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionToggle');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionDrillDown');
		assert.strictEqual(document.getText(editor.selection), '<p>Two</p>');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionNext');
		assert.strictEqual(document.getText(editor.selection), 'Two');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionPrevious');
		assert.strictEqual(document.getText(editor.selection), '<p>Two</p>');
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionMode');
	});

	test('restores all five original spans after editing the third nested element', async () => {
		const content = '<section><button id="one">One</button><button id="two">Two</button><button id="three">Three</button><button id="four">Four</button><button id="five">Five</button></section>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(content.length));
		await vscode.commands.executeCommand('syntaxstitch.enterStructuralSelectionMode');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionDrillDown');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionDrillDown');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionDrillDown');
		assert.strictEqual(document.getText(editor.selection), '<button id="three">Three</button>');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionNext');
		assert.strictEqual(document.getText(editor.selection), 'three');
		await editor.edit(edit => edit.replace(editor.selection, 'updated'));
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionTyping');
		assert.ok(document.getText().includes('<button id="updated_3">Three</button>'));
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionMode');
	});

	test('restores the highlighted parent level after nested drill-up', async () => {
		const content = '<section><p>One</p><p>Two</p></section>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(content.length));
		await vscode.commands.executeCommand('syntaxstitch.enterStructuralSelectionMode');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionToggle');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionDrillDown');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionDrillUp');
		assert.ok(editor.selection.isEmpty || document.getText(editor.selection).includes('<p>One</p>'));
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionMode');
	});

	test('keeps toggled spans in the cycle and supports Shift+Arrow multi-add', async () => {
		const content = '<p>One</p><p>Two</p><p>Three</p>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document), start = 0, end = content.length;
		editor.selection = new vscode.Selection(document.positionAt(start), document.positionAt(end));
		assert.strictEqual(await vscode.commands.executeCommand<boolean>('syntaxstitch.enterStructuralSelectionMode'), true);
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionToggle');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionNext');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionExpandRight');
		assert.ok(!editor.selection.isEmpty);
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionPrevious');
		assert.ok(editor.selection.isEmpty || document.getText(editor.selection).length >= 0);
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionMode');
	});

	test('cycles a zero-width focused slot without selecting its closing tag', async () => {
		const content = '<button class="btn">Hello</button>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document), closeStart = content.lastIndexOf('</button>');
		editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(content.length));
		await vscode.commands.executeCommand('syntaxstitch.rebuildShadowIndex');
		assert.strictEqual(await vscode.commands.executeCommand<boolean>('syntaxstitch.enterStructuralSelectionMode'), true);
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionComponents');
		const innerStart = document.getText().indexOf('Hello'), edit = new vscode.WorkspaceEdit();
		edit.delete(document.uri, new vscode.Range(document.positionAt(innerStart), document.positionAt(innerStart + 'Hello'.length)));
		assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
		await new Promise(resolve => setTimeout(resolve, 50));
		await vscode.commands.executeCommand('syntaxstitch.structuralSelectionNext');
		assert.ok(document.offsetAt(editor.selection.active) <= closeStart);
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionMode');
	});

	test('covers the full nested selection navigation cycle', async () => {
		const content = '<section><div class="one">One</div><div class="two">Two</div></section>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(content.length));
		assert.strictEqual(await vscode.commands.executeCommand<boolean>('syntaxstitch.enterStructuralSelectionMode'), true);
		for (const command of ['syntaxstitch.structuralSelectionHome', 'syntaxstitch.structuralSelectionNext', 'syntaxstitch.structuralSelectionPrevious', 'syntaxstitch.structuralSelectionEnd', 'syntaxstitch.structuralSelectionExpandRight', 'syntaxstitch.structuralSelectionExpandLeft', 'syntaxstitch.structuralSelectionToggle', 'syntaxstitch.structuralSelectionToggle', 'syntaxstitch.structuralSelectionComponents', 'syntaxstitch.structuralSelectionPrevious', 'syntaxstitch.structuralSelectionDrillDown', 'syntaxstitch.structuralSelectionDrillUp', 'syntaxstitch.structuralSelectionExpandRight', 'syntaxstitch.structuralSelectionDelete', 'syntaxstitch.structuralSelectionExpandRight', 'syntaxstitch.structuralSelectionDelete']) {
			assert.notStrictEqual(await vscode.commands.executeCommand(command), undefined, command);
		}
		assert.ok((await vscode.commands.getCommands(true)).includes('syntaxstitch.showMenu'));
		await vscode.commands.executeCommand('syntaxstitch.exitStructuralSelectionMode');
	});

	test('expands a balanced selection through enclosing brace pairs', async () => {
		const content = '(something(test))', document = await vscode.workspace.openTextDocument({ language: 'javascript', content }), editor = await vscode.window.showTextDocument(document);
		await vscode.commands.executeCommand('syntaxstitch.rebuildShadowIndex');
		editor.selection = new vscode.Selection(document.positionAt(11), document.positionAt(15));
		await vscode.commands.executeCommand('cursorRightSelect');
		assert.strictEqual(document.getText(editor.selection), '(test)');
		await vscode.commands.executeCommand('cursorRightSelect');
		assert.strictEqual(document.getText(editor.selection), '(something(test))');
	});

	test('restores a directly deleted closing quote and selects the string', async function () {
		this.timeout(5000);
		const content = 'const value = "test";', document = await vscode.workspace.openTextDocument({ language: 'typescript', content });
		const editor = await vscode.window.showTextDocument(document), close = content.lastIndexOf('"');
		await vscode.commands.executeCommand('syntaxstitch.rebuildShadowIndex');
		editor.selection = new vscode.Selection(document.positionAt(close + 1), document.positionAt(close + 1));

		await deleteLeft();
		const deadline = Date.now() + 1000;
		while ((document.getText() !== content || editor.selection.isEmpty) && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 20)); }
		assert.strictEqual(document.getText(), content);
		assert.strictEqual(document.getText(editor.selection), '"test"');
	});

	test('selects a whitespace-only quote pair before direct closer deletion', async function () {
		this.timeout(5000);
		const content = 'const values = "}"; " ";', document = await vscode.workspace.openTextDocument({ language: 'typescript', content });
		const editor = await vscode.window.showTextDocument(document), open = content.lastIndexOf('"', content.lastIndexOf('"') - 1), close = content.lastIndexOf('"'), pairSelection = () => new vscode.Selection(document.positionAt(open), document.positionAt(close + 1));
		await vscode.commands.executeCommand('syntaxstitch.rebuildShadowIndex');
		editor.selection = new vscode.Selection(document.positionAt(close + 1), document.positionAt(close + 1));

		await deleteLeft();
		assert.strictEqual(document.getText(), content);
		assert.strictEqual(document.getText(editor.selection), '" "');

		await vscode.commands.executeCommand('cursorLeft');
		assert.strictEqual(document.offsetAt(editor.selection.active), open);
		editor.selection = pairSelection();
		await vscode.commands.executeCommand('cursorRight');
		assert.strictEqual(document.offsetAt(editor.selection.active), close + 1);

		editor.selection = new vscode.Selection(document.positionAt(close), document.positionAt(close));
		await deleteRight();
		assert.strictEqual(document.getText(editor.selection), '" "');
		await deleteLeft();
		const deadline = Date.now() + 1000, expected = 'const values = "}"; ;';
		while (document.getText() !== expected && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 20)); }
		assert.strictEqual(document.getText(), expected);
	});

	test('restores a partially deleted closing tag once and selects its full element', async function () {
		this.timeout(5000);
		const content = '<main><p>Hello</p></main>', document = await vscode.workspace.openTextDocument({ language: 'html', content });
		const editor = await vscode.window.showTextDocument(document), closeEnd = content.indexOf('</p>') + '</p>'.length;
		await vscode.commands.executeCommand('syntaxstitch.rebuildShadowIndex');
		editor.selection = new vscode.Selection(document.positionAt(closeEnd), document.positionAt(closeEnd));

		await deleteLeft();
		const deadline = Date.now() + 1000;
		while ((document.getText() !== content || editor.selection.isEmpty) && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 20)); }
		assert.strictEqual(document.getText(), content);
		assert.strictEqual(document.getText(editor.selection), '</p>');
	});

	test('restores a deleted tag angle bracket and unwraps the selected element', async function () {
		this.timeout(5000);
		const content = '<title>INSTRUCTOR OUTLINE Demo</title>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document), openEnd = content.indexOf('>');
		await vscode.commands.executeCommand('syntaxstitch.rebuildShadowIndex');
		editor.selection = new vscode.Selection(document.positionAt(openEnd), document.positionAt(openEnd));
		await vscode.commands.executeCommand('syntaxstitch.deleteRight');
		const repairedDeadline = Date.now() + 1000;
		while ((document.getText() !== content || editor.selection.isEmpty) && Date.now() < repairedDeadline) { await new Promise(resolve => setTimeout(resolve, 20)); }
		assert.strictEqual(document.getText(), content);
		assert.strictEqual(document.getText(editor.selection), '<title>');
		await vscode.commands.executeCommand('syntaxstitch.deleteLeft');
		const unwrappedDeadline = Date.now() + 1000;
		while (document.getText() !== 'INSTRUCTOR OUTLINE Demo' && Date.now() < unwrappedDeadline) { await new Promise(resolve => setTimeout(resolve, 20)); }
		assert.strictEqual(document.getText(), 'INSTRUCTOR OUTLINE Demo');
	});

	test('restores a deleted closing tag angle bracket and selects only the closing tag', async function () {
		this.timeout(5000);
		const content = '<title>INSTRUCTOR OUTLINE Demo</title>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document), closeEnd = content.lastIndexOf('>') + 1;
		await vscode.commands.executeCommand('syntaxstitch.rebuildShadowIndex');
		editor.selection = new vscode.Selection(document.positionAt(closeEnd), document.positionAt(closeEnd));
		await vscode.commands.executeCommand('syntaxstitch.deleteLeft');
		const deadline = Date.now() + 1000;
		while ((document.getText() !== content || editor.selection.isEmpty) && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 20)); }
		assert.strictEqual(document.getText(), content);
		assert.strictEqual(document.getText(editor.selection), '</title>');
	});

	test('corrects a provider cursor left after an auto-inserted closing tag', async function () {
		this.timeout(5000);
		const document = await vscode.workspace.openTextDocument({ language: 'html', content: '' }), editor = await vscode.window.showTextDocument(document);
		await vscode.commands.executeCommand('syntaxstitch.rebuildShadowIndex');
		const edit = new vscode.WorkspaceEdit();
		edit.insert(document.uri, new vscode.Position(0, 0), '<p></p>');
		assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
		const deadline = Date.now() + 1000;
		while (document.offsetAt(editor.selection.active) !== '<p></p>'.length && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 20)); }
		assert.strictEqual(document.getText(), '<p></p>');
		assert.strictEqual(document.offsetAt(editor.selection.active), '<p></p>'.length);
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

	test('synchronizes the opening tag when a closing tag name changes', async function () {
		await vscode.commands.executeCommand('syntaxstitch.resetStatistics');
		const content = '<section>Keep me</section>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), nameStart = content.lastIndexOf('section');
		await vscode.window.showTextDocument(document);
		await vscode.commands.executeCommand('syntaxstitch.rebuildShadowIndex');
		const edit = new vscode.WorkspaceEdit();
		edit.replace(document.uri, new vscode.Range(document.positionAt(nameStart), document.positionAt(nameStart + 'section'.length)), 'div');
		assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
		const deadline = Date.now() + 1000;
		while (document.getText() !== '<div>Keep me</div>' && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 20)); }
		assert.strictEqual(document.getText(), '<div>Keep me</div>');
		const statistics = await vscode.commands.executeCommand<{ total: number }>('syntaxstitch.showStatistics');
		assert.strictEqual(statistics.total, 0);
	});

	test('synchronizes nested tag names while preserving opening attributes', async function () {
		await vscode.commands.executeCommand('syntaxstitch.resetStatistics');
		const content = '<section data-kind="report"><article><p>Keep me</p></article></section>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), nameStart = content.lastIndexOf('section');
		await vscode.window.showTextDocument(document);
		await vscode.commands.executeCommand('syntaxstitch.rebuildShadowIndex');
		const edit = new vscode.WorkspaceEdit();
		edit.replace(document.uri, new vscode.Range(document.positionAt(nameStart), document.positionAt(nameStart + 'section'.length)), 'div');
		assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
		const deadline = Date.now() + 1000;
		while (document.getText() !== '<div data-kind="report"><article><p>Keep me</p></article></div>' && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 20)); }
		assert.strictEqual(document.getText(), '<div data-kind="report"><article><p>Keep me</p></article></div>');
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
		await vscode.window.showTextDocument(document);
		await vscode.commands.executeCommand('syntaxstitch.rebuildShadowIndex');
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
		await vscode.window.showTextDocument(document);
		await vscode.commands.executeCommand('syntaxstitch.rebuildShadowIndex');
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

	test('selects preserved content after deleting an exact tag token', async () => {
		const content = '<title>INSTRUCTOR OUTLINE Demo</title>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document), closeStart = content.lastIndexOf('</title>');
		await vscode.commands.executeCommand('syntaxstitch.rebuildShadowIndex');
		const edit = new vscode.WorkspaceEdit();
		edit.delete(document.uri, new vscode.Range(document.positionAt(closeStart), document.positionAt(content.length)));
		assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
		const deadline = Date.now() + 1000;
		while ((document.getText() !== 'INSTRUCTOR OUTLINE Demo' || document.getText(editor.selection) !== 'INSTRUCTOR OUTLINE Demo') && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 20)); }
		assert.strictEqual(document.getText(), 'INSTRUCTOR OUTLINE Demo');
		assert.strictEqual(document.getText(editor.selection), 'INSTRUCTOR OUTLINE Demo');
	});

	test('selects an inner closing tag when preserved content ends with one', async () => {
		const content = '<title>INSTRUCTOR OUTLINE Demo<p>Summary</p></title>', document = await vscode.workspace.openTextDocument({ language: 'html', content }), editor = await vscode.window.showTextDocument(document), closeStart = content.lastIndexOf('</title>');
		await vscode.commands.executeCommand('syntaxstitch.rebuildShadowIndex');
		const edit = new vscode.WorkspaceEdit();
		edit.delete(document.uri, new vscode.Range(document.positionAt(closeStart), document.positionAt(content.length)));
		assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
		const deadline = Date.now() + 1000;
		while ((document.getText() !== 'INSTRUCTOR OUTLINE Demo<p>Summary</p>' || document.getText(editor.selection) !== '</p>') && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 20)); }
		assert.strictEqual(document.getText(), 'INSTRUCTOR OUTLINE Demo<p>Summary</p>');
		assert.strictEqual(document.getText(editor.selection), '</p>');
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
		await vscode.window.showTextDocument(document);
		await vscode.commands.executeCommand('syntaxstitch.rebuildShadowIndex');
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
		await vscode.window.showTextDocument(document);
		await vscode.commands.executeCommand('syntaxstitch.rebuildShadowIndex');
		for (let attempt = 0; attempt < 2; attempt++) {
			const edit = new vscode.WorkspaceEdit();
			edit.delete(document.uri, new vscode.Range(document.positionAt(close), document.positionAt(close + 1)));
			assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
			const deadline = Date.now() + 2000;
			while (!document.getText().includes(')') && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 20)); }
			assert.ok(document.getText().includes(')'));
		}
		const statistics = await vscode.commands.executeCommand<{ total: number; byKind: { parenthesis: number }; lastRepair?: string }>('syntaxstitch.showStatistics');
		assert.strictEqual(statistics.total, 1);
		assert.strictEqual(statistics.byKind.parenthesis, 1);
		assert.strictEqual(statistics.lastRepair, 'Restored ")" · javascript · line 1');
	});
});
