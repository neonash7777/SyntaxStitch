import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { RepairHistory } from '../repairHistory';
import { TUTORIAL_EXAMPLE, tutorialContent } from '../practice';
import type { SelectionSpan } from '../shadowStructure';

const delay = (ms = 180): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const command = (name: string, ...args: unknown[]) => vscode.commands.executeCommand(`syntaxstitch.${name}`, ...args);
const open = async (content: string, language = 'html') => {
	const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language, content }));
	await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
	await delay(40);
	return editor;
};
const focusClass = async (editor: vscode.TextEditor, start: number, end: number) => {
	editor.selection = new vscode.Selection(editor.document.positionAt(start), editor.document.positionAt(end));
	await command('enterStructuralSelectionMode');
	await command('structuralSelectionComponents');
	await command('structuralSelectionComponents');
	await command('structuralSelectionNext');
	assert.equal(editor.document.getText(editor.selection), 'one');
};

suite('Editing controls and scope', () => {
	suiteSetup(async () => { await vscode.extensions.all.find(extension => extension.packageJSON.name === 'syntaxstitch')!.activate(); });
	setup(async () => { await vscode.commands.executeCommand('workbench.action.closePanel'); });
	teardown(async () => {
		await command('exitStructuralSelectionMode');
		await command('exitStructuralSelectionMode');
	});

	test('pauses a file and resumes with a fresh index', async () => {
		const editor = await open('call(value); other(value);', 'javascript');
		assert.equal(await command('toggleFilePause'), true);
		await editor.edit(edit => edit.delete(new vscode.Range(0, 10, 0, 11)));
		await delay();
		assert.equal(editor.document.getText(), 'call(value; other(value);');
		assert.equal(await command('toggleFilePause'), false);
		const offset = editor.document.getText().lastIndexOf(')');
		await editor.edit(edit => edit.delete(new vscode.Range(editor.document.positionAt(offset), editor.document.positionAt(offset + 1))));
		await delay();
		assert.equal(editor.document.getText(), 'call(value; other(value);');
	});

	test('skips exactly one text edit, including direct deletion of an empty quote', async () => {
		const editor = await open('const x = ""; other(value);', 'javascript');
		await command('skipNextRepair');
		editor.selection = new vscode.Selection(0, 11, 0, 11);
		await command('deleteRight');
		await delay();
		assert.equal(editor.document.getText(), 'const x = "; other(value);');
		// A separate document remains protected.
		const other = await open('call(value);', 'javascript');
		await other.edit(edit => edit.delete(new vscode.Range(0, 10, 0, 11)));
		await delay();
		assert.equal(other.document.getText(), 'call(value);');
	});

	test('consumes skip on one batch and protects the next edit in the same file', async () => {
		const editor = await open('one(value); two(value);', 'javascript');
		await command('skipNextRepair');
		await editor.edit(edit => edit.delete(new vscode.Range(0, 9, 0, 10)));
		await delay();
		assert.equal(editor.document.getText(), 'one(value; two(value);');
		const offset = editor.document.getText().lastIndexOf(')');
		await editor.edit(edit => edit.delete(new vscode.Range(editor.document.positionAt(offset), editor.document.positionAt(offset + 1))));
		await delay();
		assert.equal(editor.document.getText(), 'one(value; two(value);');
	});

	for (const scope of ['selection', 'enclosing', 'document'] as const) {
		test(`previews and applies ${scope} scope across rapid attribute edits`, async () => {
			const first = '<button class="one">A</button>', second = '<button class="two">B</button>', third = '<button class="three">C</button>';
			const content = `<section>${first}${second}</section>${third}`, editor = await open(content);
			await focusClass(editor, content.indexOf(first), content.indexOf(first) + first.length);
			if (scope !== 'selection') { await command('chooseMirroringScope', scope); }
			const preview = await command('inspectMirroredEdits') as { scope: string; targets: SelectionSpan[] };
			assert.equal(preview.scope, scope);
			assert.equal(preview.targets.length, scope === 'selection' ? 1 : scope === 'enclosing' ? 2 : 3);
			await editor.edit(edit => edit.replace(editor.selection, 'p'));
			await editor.edit(edit => edit.insert(editor.selection.active, 'rimary'));
			await command('exitStructuralSelectionTyping');
			assert.equal((editor.document.getText().match(/class="primary"/g) ?? []).length, preview.targets.length);
			if (scope !== 'document') { assert.ok(editor.document.getText().endsWith(third)); }
		});
	}

	test('keeps HTML ID numbering inside the enclosing scope', async () => {
		const first = '<button id="one">A</button>', second = '<button id="two">B</button>', outside = '<button id="outside">C</button>';
		const content = `<section>${first}${second}</section>${outside}`, editor = await open(content);
		await focusClass(editor, content.indexOf(first), content.indexOf(first) + first.length);
		await command('chooseMirroringScope', 'enclosing');
		await editor.edit(edit => edit.replace(editor.selection, 'shared'));
		await command('exitStructuralSelectionTyping');
		assert.equal(editor.document.getText(), `<section><button id="shared_1">A</button><button id="shared_2">B</button></section>${outside}`);
	});

	test('consumes skip for all changes in one multi-cursor batch', async () => {
		const content = 'one(value); two(value); three(value);', editor = await open(content, 'javascript');
		await command('skipNextRepair');
		await editor.edit(edit => {
			for (const start of [content.indexOf(')'), content.indexOf(')', content.indexOf(')') + 1)]) {
				edit.delete(new vscode.Range(editor.document.positionAt(start), editor.document.positionAt(start + 1)));
			}
		});
		await delay();
		assert.equal(editor.document.getText(), 'one(value; two(value; three(value);');
		const offset = editor.document.getText().lastIndexOf(')');
		await editor.edit(edit => edit.delete(new vscode.Range(editor.document.positionAt(offset), editor.document.positionAt(offset + 1))));
		await delay();
		assert.equal(editor.document.getText(), 'one(value; two(value; three(value);');
	});

	test('pause cancels already queued attribute edits', async () => {
		const content = '<button class="one">A</button><button class="two">B</button>', editor = await open(content);
		await focusClass(editor, 0, content.length);
		await editor.edit(edit => edit.replace(editor.selection, 'primary'));
		await command('toggleFilePause');
		await delay();
		assert.ok(editor.document.getText().includes('class="two"'));
		await command('toggleFilePause');
	});

	test('undo and redo do not trigger fresh mirrored changes', async () => {
		const content = '<button class="one">A</button><button class="two">B</button>', editor = await open(content);
		await focusClass(editor, 0, content.length);
		await vscode.commands.executeCommand('default:type', { text: 'primary' });
		await command('exitStructuralSelectionTyping');
		const edited = editor.document.getText();
		assert.equal(edited, '<button class="primary">A</button><button class="primary">B</button>');
		await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
		await delay(40);
		await vscode.commands.executeCommand('undo');
		await delay();
		assert.equal(editor.document.getText(), content);
		await vscode.commands.executeCommand('redo');
		await delay();
		assert.equal(editor.document.getText(), edited);
	});

	test('preserves a balanced formatter-style workspace replacement', async () => {
		const editor = await open('call({value:1});', 'javascript');
		const formatted = 'call({\n  value: 1\n});\n';
		const edit = new vscode.WorkspaceEdit();
		edit.replace(editor.document.uri, new vscode.Range(0, 0, 0, editor.document.getText().length), formatted);
		assert.ok(await vscode.workspace.applyEdit(edit));
		await delay();
		assert.equal(editor.document.getText(), formatted);
	});

	test('bounds repair history without keeping source snippets', async () => {
		const editor = await open('secretSource();', 'javascript'), history = new RepairHistory();
		for (let n = 0; n < 110; n++) { history.record(editor.document, [{ offset: 0, deleteLength: 0, text: 'secretSource', pairId: 'pair', side: 'close', blockType: 'brace', kind: 'parenthesis', rule: 'restore-closer' }], []); }
		assert.equal(history.entries.length, 100);
		assert.ok(!JSON.stringify(history.entries).includes('secretSource'));
		assert.ok(history.entries[0].reason.includes('surviving opening'));
		history.clear();
		assert.equal(history.entries.length, 0);
	});

	test('opens an unsaved practice file with an actionable selection', async () => {
		await command('openPractice');
		const editor = vscode.window.activeTextEditor!;
		assert.equal(editor.document.languageId, 'html');
		assert.equal(editor.document.uri.scheme, 'untitled');
		assert.equal(editor.document.getText(editor.selection), TUTORIAL_EXAMPLE);
		assert.equal((TUTORIAL_EXAMPLE.match(/<div>/g) ?? []).length, 3);
		assert.equal((TUTORIAL_EXAMPLE.match(/<span /g) ?? []).length, 6);
		assert.ok(tutorialContent('darwin').includes('PRESS OPT+CMD+RETURN'));
		assert.ok(tutorialContent('win32').includes('PRESS CTRL+ALT+S'));
		assert.equal(await command('enterStructuralSelectionMode'), true);
		assert.ok(editor.document.getText(editor.selection).startsWith('<div>'));
		await command('structuralSelectionNext');
		assert.ok(editor.document.getText(editor.selection).startsWith('<span class="outer-one"'));
		await command('structuralSelectionNext');
		assert.ok(editor.document.getText(editor.selection).startsWith('<span class="inner-one"'));
	});
});
