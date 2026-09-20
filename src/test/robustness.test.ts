import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
const wait = (ms = 170): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const command = (name: string, ...args: unknown[]) => vscode.commands.executeCommand(`syntaxstitch.${name}`, ...args);

async function selectedAttribute(content: string, value = true, selectionEnd = content.length, existing?: vscode.TextDocument): Promise<vscode.TextEditor> {
	const document = existing ?? await vscode.workspace.openTextDocument({ language: 'html', content });
	const editor = await vscode.window.showTextDocument(document, { preview: false });
	await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
	await wait(40);
	editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(selectionEnd));
	await command('enterStructuralSelectionMode');
	await command('structuralSelectionComponents');
	await command('structuralSelectionComponents');
	if (value) { await command('structuralSelectionNext'); }
	return editor;
}

suite('Automatic edit robustness', () => {
	suiteSetup(async () => { await vscode.extensions.all.find(extension => extension.packageJSON.name === 'syntaxstitch')!.activate(); });
	setup(async () => { await vscode.commands.executeCommand('workbench.action.closePanel'); });
	teardown(async () => { await command('exitStructuralSelectionMode'); await command('exitStructuralSelectionMode'); });

	test('streamed whole-document replacements cancel pending mirrors', async () => {
		const editor = await selectedAttribute('<span class="one">One</span><span class="two">Two</span>');
		await editor.edit(edit => edit.replace(editor.selection, 'pending'));
		for (const text of ['<section>', '<section>Generated', '<section>Generated</section>']) {
			const edit = new vscode.WorkspaceEdit();
			edit.replace(editor.document.uri, new vscode.Range(editor.document.positionAt(0), editor.document.positionAt(editor.document.getText().length)), text);
			await vscode.workspace.applyEdit(edit);
		}
		await wait();
		assert.equal(editor.document.getText(), '<section>Generated</section>');
	});

	test('multi-cursor typing preserves independently edited values', async () => {
		const content = '<span class="one">One</span><span class="two">Two</span>';
		const editor = await selectedAttribute(content);
		editor.selections = ['one', 'two'].map(value => {
			const start = content.indexOf(value);
			return new vscode.Selection(editor.document.positionAt(start), editor.document.positionAt(start + value.length));
		});
		await vscode.commands.executeCommand('default:type', { text: 'both' });
		await wait();
		assert.equal(editor.document.getText(), content.replace('one', 'both').replace('two', 'both'));
	});

	test('snippet insertion outside the focused value cancels pending mirrors', async () => {
		const editor = await selectedAttribute('<span class="one">One</span><span class="two">Two</span>');
		await editor.edit(edit => edit.replace(editor.selection, 'primary'));
		await editor.insertSnippet(new vscode.SnippetString('<!-- ${1:note} -->'), editor.document.positionAt(editor.document.getText().length));
		await wait();
		assert.equal(editor.document.getText(), '<span class="primary">One</span><span class="two">Two</span><!-- note -->');
		await vscode.commands.executeCommand('leaveSnippet');
	});

	test('a competing paired tag rename remains authoritative', async () => {
		const editor = await selectedAttribute('<span class="one">One</span><span class="two">Two</span>');
		await editor.edit(edit => edit.replace(editor.selection, 'primary'));
		const text = editor.document.getText();
		await editor.edit(edit => {
			for (const offset of [text.indexOf('span'), text.indexOf('/span') + 1]) {
				edit.replace(new vscode.Range(editor.document.positionAt(offset), editor.document.positionAt(offset + 4)), 'strong');
			}
		});
		await wait();
		assert.equal(editor.document.getText(), '<strong class="primary">One</strong><span class="two">Two</span>');
	});

	test('renames by original key across reordered attributes, including subsequent keystrokes', async () => {
		const content = '<span class="one" id="first">One</span><span id="second" class="two">Two</span>';
		const editor = await selectedAttribute(content, false);
		assert.equal(editor.document.getText(editor.selection), 'class');
		await editor.edit(edit => edit.replace(editor.selection, 'data-class'));
		await wait();
		assert.equal(editor.document.getText(), '<span data-class="one" id="first">One</span><span id="second" data-class="two">Two</span>');
		await editor.edit(edit => edit.insert(editor.selection.active, '-extra'));
		await wait();
		assert.equal(editor.document.getText(), '<span data-class-extra="one" id="first">One</span><span id="second" data-class-extra="two">Two</span>');
	});

	test('selects and mirrors quoted angle brackets without losing later attributes', async () => {
		const editor = await selectedAttribute('<span title="a > b" class="one">One</span><span title="c > d" class="two">Two</span>');
		assert.equal(editor.document.getText(editor.selection), 'a > b');
		await editor.edit(edit => edit.replace(editor.selection, 'x > y'));
		await wait();
		assert.equal(editor.document.getText(), '<span title="x > y" class="one">One</span><span title="x > y" class="two">Two</span>');
	});

	test('mirrors a multiword value equally when pasted or typed in separate bursts', async () => {
		const content = '<span title="one">One</span><span title="two">Two</span>';
		const pasted = await selectedAttribute(content);
		await pasted.edit(edit => edit.replace(pasted.selection, 'hello world'));
		await wait();
		const typed = await selectedAttribute(content);
		await typed.edit(edit => edit.replace(typed.selection, 'hello'));
		await wait();
		await typed.edit(edit => edit.insert(typed.selection.active, ' '));
		await wait();
		await typed.edit(edit => edit.insert(typed.selection.active, 'world'));
		await wait();
		assert.equal(pasted.document.getText(), '<span title="hello world">One</span><span title="hello world">Two</span>');
		assert.equal(typed.document.getText(), pasted.document.getText());
	});

	test('applies to captured targets after navigation, not the newly focused attribute', async () => {
		const editor = await selectedAttribute('<span class="one" id="first">One</span><span class="two" id="second">Two</span>');
		await editor.edit(edit => edit.replace(editor.selection, 'primary'));
		await command('exitStructuralSelectionMode'); // Leave typing without flushing.
		await command('structuralSelectionNext');
		await wait();
		assert.equal(editor.document.getText(), '<span class="primary" id="first">One</span><span class="primary" id="second">Two</span>');
	});

	test('undo before automatic apply cancels the queue and repeated redo never replays it', async function () {
		this.timeout(6000);
		const content = '<span class="one">One</span><span class="two">Two</span>', editor = await selectedAttribute(content);
		await vscode.commands.executeCommand('default:type', { text: 'primary' });
		assert.ok(editor.document.getText().includes('class="primary"'));
		await vscode.commands.executeCommand('undo');
		await wait();
		assert.equal(editor.document.getText(), content);
		for (let n = 0; n < 3; n++) {
			await vscode.commands.executeCommand('redo');
			await wait();
			assert.equal(editor.document.getText(), '<span class="primary">One</span><span class="two">Two</span>');
			await vscode.commands.executeCommand('undo');
			await wait();
			assert.equal(editor.document.getText(), content);
		}
	});

	test('automatically applied edits undo together and stay undone across repeated cycles', async function () {
		this.timeout(6000);
		const content = '<span class="one">One</span><span class="two">Two</span>', editor = await selectedAttribute(content);
		await vscode.commands.executeCommand('default:type', { text: 'primary' });
		await wait(); // No Enter required.
		const edited = '<span class="primary">One</span><span class="primary">Two</span>';
		assert.equal(editor.document.getText(), edited);
		for (let n = 0; n < 3; n++) {
			await vscode.commands.executeCommand('undo');
			await wait();
			assert.equal(editor.document.getText(), content);
			await vscode.commands.executeCommand('redo');
			await wait();
			assert.equal(editor.document.getText(), edited);
		}
	});

	test('an edit in another pane cancels the first pane pending transaction', async () => {
		const content = '<span class="one">One</span><span class="two">Two</span>', first = await selectedAttribute(content);
		const second = await vscode.window.showTextDocument(first.document, { viewColumn: vscode.ViewColumn.Beside, preview: false });
		await vscode.window.showTextDocument(first.document, first.viewColumn);
		// Re-enter after opening the split so the original pane owns the session.
		first.selection = new vscode.Selection(first.document.positionAt(0), first.document.positionAt(content.length));
		await command('enterStructuralSelectionMode');
		await command('structuralSelectionComponents'); await command('structuralSelectionComponents'); await command('structuralSelectionNext');
		await first.edit(edit => edit.replace(first.selection, 'primary'));
		await vscode.window.showTextDocument(second.document, second.viewColumn);
		await second.edit(edit => edit.insert(second.document.positionAt(second.document.getText().length), '<!-- from second pane -->'));
		await wait();
		assert.equal(first.document.getText(), '<span class="primary">One</span><span class="two">Two</span><!-- from second pane -->');
		await vscode.commands.executeCommand('workbench.action.joinAllGroups');
	});

	test('restoring a boundary does not repair undo or redo back into a loop', async () => {
		const document = await vscode.workspace.openTextDocument({ language: 'javascript', content: 'call(value);' });
		const editor = await vscode.window.showTextDocument(document);
		await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
		await wait(40);
		editor.selection = new vscode.Selection(0, 11, 0, 11);
		await command('deleteLeft');
		assert.equal(document.getText(), 'call(value);');
		await vscode.commands.executeCommand('undo');
		const undone = document.getText();
		await wait();
		assert.equal(document.getText(), undone);
		await vscode.commands.executeCommand('redo');
		const redone = document.getText();
		await wait();
		assert.equal(document.getText(), redone);
		await vscode.commands.executeCommand('undo');
		await wait();
		assert.equal(document.getText(), undone);
	});

	test('skips a rename when the target already has the new attribute', async () => {
		const editor = await selectedAttribute('<span class="one">One</span><span class="two" data-class="keep">Two</span>', false);
		await editor.edit(edit => edit.replace(editor.selection, 'data-class'));
		await wait();
		assert.equal(editor.document.getText(), '<span data-class="one">One</span><span class="two" data-class="keep">Two</span>');
	});

	test('encodes destination quotes and quotes unquoted peer values', async () => {
		const editor = await selectedAttribute(`<span title="one">One</span><span title='two'>Two</span><span title=three>Three</span>`);
		await editor.edit(edit => edit.replace(editor.selection, "it's ready"));
		await wait();
		assert.equal(editor.document.getText(), `<span title="it's ready">One</span><span title='it&#39;s ready'>Two</span><span title="it's ready">Three</span>`);
	});

	test('ID numbering avoids untouched void elements and encoded IDs outside scope', async () => {
		const selected = '<span id="one">One</span><span id="two">Two</span>';
		const outside = '<input id="shared_1"><div id="shared&lowbar;2">Outside</div>';
		const editor = await selectedAttribute(selected + outside, true, selected.length);
		await editor.edit(edit => edit.replace(editor.selection, 'shared'));
		await command('exitStructuralSelectionTyping');
		assert.equal(editor.document.getText(), '<span id="shared_3">One</span><span id="shared_4">Two</span>' + outside);
	});
});
