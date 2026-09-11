import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ShadowStructure, type RepairPatch } from '../shadowStructure';

type PlannedChange = Parameters<ShadowStructure['planRepairs']>[0][number];
const deletion = (offset: number, length = 1): PlannedChange => ({ range: undefined as never, rangeOffset: offset, rangeLength: length, text: '' });
const deleteAndRepair = (source: string, offset: number, length = 1, languageId = 'typescript'): { result: string; patches: RepairPatch[] } => {
	const shadow = new ShadowStructure(source, languageId), change = deletion(offset, length), deleted = `${source.slice(0, offset)}${source.slice(offset + length)}`, patches = shadow.planRepairs([change], deleted);
	return { patches, result: patches.reduce((text, patch) => `${text.slice(0, patch.offset)}${patch.text}${text.slice(patch.offset + patch.deleteLength)}`, deleted) };
};

describe('repair decisions', () => {
	// Decision: meaningful structures keep their owner, so deleting only the closer restores it.
	for (const [name, source, close] of [
		['parentheses', 'call(value)', ')'],
		['square brackets', 'const values = [1, 2];', ']'],
		['curly braces', 'const value = { nested: true };', '}'],
		['double quotes', 'const value = "text";', '"'],
		['single quotes', "const value = 'text';", "'"],
		['template quotes', 'const value = `text`;', '`'],
	] as const) {
		test(`restores a meaningful ${name} closer`, () => {
			const { result, patches } = deleteAndRepair(source, source.lastIndexOf(close));
			assert.equal(result, source);
			assert.equal(patches[0]?.side, 'close');
		});
	}

	// Decision: empty pairs are one disposable unit; restoring either half would obstruct ordinary deletion.
	for (const source of ['()', '( )', '[]', '[ ]', '{}', '{ }', '""', '" "']) {
		test(`removes the empty pair ${JSON.stringify(source)}`, () => assert.equal(deleteAndRepair(source, source.length - 1).result, ''));
	}

	// Decision: deleting both boundaries is explicit intent and must never be repaired.
	for (const source of ['(value)', '[value]', '{value}', '"value"']) {
		test(`allows complete-pair deletion for ${JSON.stringify(source)}`, () => {
			const shadow = new ShadowStructure(source, 'typescript');
			assert.deepEqual(shadow.planRepairs([deletion(0, source.length)], ''), []);
		});
	}

	// Decision: deleting one complete tag unwraps meaningful content; damaging only its closer restores the tag.
	test('unwraps an element when its complete closing tag is deleted', () => assert.equal(deleteAndRepair('<section>content</section>', 16, 10, 'html').result, 'content'));
	test('restores a partially deleted closing tag', () => assert.equal(deleteAndRepair('<section>content</section>', 25, 1, 'html').result, '<section>content</section>'));
});

describe('default language permutations', () => {
	const codeLanguages = ['javascript', 'javascriptreact', 'typescript', 'typescriptreact', 'json', 'jsonc', 'css', 'scss', 'less', 'python', 'csharp', 'java', 'go', 'rust'];
	const markupLanguages = ['html', 'xml', 'vue', 'svelte', 'astro'];

	// Decision: every language enabled by default gets the same bracket protection contract.
	for (const languageId of codeLanguages) {
		test(`${languageId} restores each bracket family`, () => {
			for (const [source, close] of [['call(value)', ')'], ['values = [1]', ']'], ['value = { item }', '}']] as const) {
				assert.equal(deleteAndRepair(source, source.lastIndexOf(close), 1, languageId).result, source);
			}
		});
	}

	// Decision: markup-family languages protect paired elements and quoted attributes consistently.
	for (const languageId of markupLanguages) {
		test(`${languageId} indexes tags and attribute quotes`, () => {
			const source = '<section title="report"><span>value</span></section>', pairs = new ShadowStructure(source, languageId).pairs;
			assert.equal(pairs.filter(pair => pair.type === 'tag').length, 2);
			assert.equal(pairs.filter(pair => pair.type === 'quote').length, 1);
		});
	}
});

describe('quote boundaries', () => {
	// Decision: ordinary code strings cannot claim a quote on a later line; this keeps a stray `};"` deletable.
	for (const languageId of ['javascript', 'javascriptreact', 'typescript', 'typescriptreact', 'json', 'jsonc', 'css', 'scss', 'less', 'python', 'csharp', 'java', 'go', 'rust']) {
		test(`${languageId} does not pair ordinary quotes across lines`, () => {
			const source = 'type Group = {};"\nconst name = "primary";', quotes = new ShadowStructure(source, languageId).pairs.filter(pair => pair.type === 'quote');
			assert.equal(quotes.length, 1);
			assert.equal(source.slice(quotes[0].openIdx, quotes[0].closeIdx + 1), '"primary"');
		});
	}

	// Decision: language forms that explicitly support multiline text remain protected across line breaks.
	for (const [languageId, source] of [['python', 'value = """first\nsecond"""'], ['csharp', 'var value = @"first\nsecond";']] as const) {
		test(`${languageId} preserves its multiline string form`, () => {
			const quotes = new ShadowStructure(source, languageId).pairs.filter(pair => pair.type === 'quote');
			assert.equal(quotes.length, 1);
			assert.ok(quotes[0].closeIdx > source.indexOf('\n'));
		});
	}
});

describe('nested language ownership', () => {
	// Decision: delimiters belong to the language region that parsed them, preventing cross-language rebinding.
	for (const [name, source, languageId, expected] of [
		['HTML script and style', '<main><script>const value = { text: "x" };</script><style>.x { content: "}"; }</style></main>', 'html', ['html', 'javascript', 'css']],
		['TSX markup and expressions', 'const view = <section title="x">{items.map(item => <span>{item}</span>)}</section>;', 'typescriptreact', ['typescriptreact', 'html']],
		['JavaScript template markup', 'const view = `<section>${render({ ready: true })}</section>`;', 'javascript', ['javascript', 'html']],
		['Vue script', '<template><section title="x">value</section></template><script>const value = { ready: true };</script>', 'vue', ['vue', 'javascript']],
	] as const) {
		test(`tracks ${name}`, () => {
			const languages = new Set(new ShadowStructure(source, languageId).pairs.map(pair => pair.languageId));
			for (const expectedLanguage of expected) { assert.ok(languages.has(expectedLanguage), `${name} should include ${expectedLanguage}`); }
		});
	}
});