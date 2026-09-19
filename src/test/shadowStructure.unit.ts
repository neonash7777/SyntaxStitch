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

	test('allows an inserted opener to rebind to a later unmatched JSON closer', () => {
		const source = `{
	"emojiPlatformSupport": {
		"15.0": [
			{
				"target": "windows",
				"version": "11-22H2"
			},
			{}
				"target": "ubuntu",
				"version": "22.04"
			}
		]
	}
}`;
		const generatedClose = source.indexOf('{}') + 1;
		assert.equal(deleteAndRepair(source, generatedClose, 1, 'json').result, `${source.slice(0, generatedClose)}${source.slice(generatedClose + 1)}`);
	});

	test('removes unmatched closing braces introduced by an edit', () => {
		const source = 'declare global { namespace JSX { interface IntrinsicElements {} } }', inserted = '\n}\n}\n}', change: PlannedChange = { range: undefined as never, rangeOffset: source.length, rangeLength: 0, text: inserted }, resulting = source + inserted;
		const shadow = new ShadowStructure(source, 'typescriptreact'), patches = shadow.planRepairs([change], resulting);
		const repaired = patches.reduce((text, patch) => `${text.slice(0, patch.offset)}${patch.text}${text.slice(patch.offset + patch.deleteLength)}`, resulting);
		assert.equal(repaired, source + '\n\n\n');
		assert.equal(patches.length, 3);
	});

	test('unwraps a document-level brace wrapper when its opener is deleted', () => {
		const source = '{export default defineConfig([test(process.env.VSCODE_TEST_VERSION ?? \'stable\')]);)}', open = 0, change = deletion(open), resulting = source.slice(1), shadow = new ShadowStructure(source, 'javascript'), patches = shadow.planRepairs([change], resulting);
		const repaired = patches.reduce((text, patch) => `${text.slice(0, patch.offset)}${patch.text}${text.slice(patch.offset + patch.deleteLength)}`, resulting);
		assert.equal(repaired, source.slice(1, -1));
	});

	test('restores a valid document-level brace opener', () => {
		const source = '{export default defineConfig([]);}', open = 0, change = deletion(open), resulting = source.slice(1), shadow = new ShadowStructure(source, 'javascript');
		assert.equal(shadow.planRepairs([change], resulting)[0]?.text, '{');
	});

	test('removes mismatched closing delimiters introduced by an edit', () => {
		const source = 'const value = [];', inserted = ')', change: PlannedChange = { range: undefined as never, rangeOffset: source.length - 1, rangeLength: 0, text: inserted }, resulting = `${source.slice(0, -1)}${inserted}${source.slice(-1)}`;
		const shadow = new ShadowStructure(source, 'typescript'), patches = shadow.planRepairs([change], resulting);
		assert.equal(patches.length, 1);
		assert.equal(patches[0]?.deleteLength, 1);
		assert.equal(`${resulting.slice(0, patches[0]!.offset)}${resulting.slice(patches[0]!.offset + 1)}`, source);
	});

	test('ignores delimiters inside JavaScript regex literals', () => {
		const source = 'const pattern = /[{}()]/; const value = { ready: true };', pairs = new ShadowStructure(source, 'typescript').pairs.filter(pair => pair.type === 'brace');
		assert.equal(pairs.length, 1);
		assert.equal(source.slice(pairs[0]!.openIdx, pairs[0]!.closeIdx + 1), '{ ready: true }');
	});

	// Decision: deleting one complete tag unwraps meaningful content; damaging only its closer restores the tag.
	test('unwraps an element when its complete closing tag is deleted', () => assert.equal(deleteAndRepair('<section>content</section>', 16, 10, 'html').result, 'content'));
	test('restores a partially deleted closing tag', () => assert.equal(deleteAndRepair('<section>content</section>', 25, 1, 'html').result, '<section>content</section>'));
	test('restores the final angle bracket of either tag boundary', () => {
		const source = '<title>INSTRUCTOR OUTLINE Demo</title>';
		assert.equal(deleteAndRepair(source, source.indexOf('>'), 1, 'html').result, source);
		assert.equal(deleteAndRepair(source, source.lastIndexOf('>'), 1, 'html').result, source);
	});
	test('unwraps a selected complete tag while preserving its content', () => {
		const source = '<title>INSTRUCTOR OUTLINE Demo</title>', shadow = new ShadowStructure(source, 'html'), change: PlannedChange = { range: undefined as never, rangeOffset: 0, rangeLength: source.length, text: '' }, patches = shadow.planRepairs([change], '');
		const repaired = patches.reduce((text, patch) => `${text.slice(0, patch.offset)}${patch.text}${text.slice(patch.offset + patch.deleteLength)}`, '');
		assert.equal(repaired, 'INSTRUCTOR OUTLINE Demo');
	});
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


	test('keeps nested template expressions in their JavaScript owner', () => {
		const source = 'const view = `${items.map(item => `${item.value}`)}`;', pairs = new ShadowStructure(source, 'javascript').pairs;
		assert.equal(pairs.filter(pair => pair.type === 'quote').length, 2);
		assert.equal(pairs.filter(pair => pair.type === 'brace' && pair.openToken === '{').length, 2);
		assert.equal(pairs.filter(pair => pair.type === 'brace' && pair.openToken === '(').length, 1);
		assert.ok(pairs.every(pair => pair.languageId === 'javascript'));
	});
	test('selects all sibling brace bodies inside a highlighted CSS region', () => {
		const text = 'body { color: red; } .btn { padding: 1em; } .output { margin: 0; }', shadow = new ShadowStructure(text, 'css');
		assert.deepEqual(shadow.innerSelectionSpans(0, text.length).map(span => text.slice(span.start, span.end)), [' color: red; ', ' padding: 1em; ', ' margin: 0; ']);
	});
	test('selects mixed sibling delimiter bodies without choosing the first family', () => {
		const text = '{alpha}(beta)[gamma]{delta}', shadow = new ShadowStructure(text, 'javascript');
		assert.deepEqual(shadow.innerSelectionSpans(0, text.length).map(span => text.slice(span.start, span.end)), ['alpha', 'beta', 'gamma', 'delta']);
	});
	test('selects sibling HTML element bodies at one level', () => {
		const text = '<section>One</section><article>Two</article><p>Three</p>', shadow = new ShadowStructure(text, 'html');
		assert.deepEqual(shadow.innerSelectionSpans(0, text.length).map(span => text.slice(span.start, span.end)), ['One', 'Two', 'Three']);
	});
	test('pairs JSX fragments as HTML structures', () => {
		const source = 'const view = <><span>{value}</span></>;', pairs = new ShadowStructure(source, 'typescriptreact').pairs;
		assert.ok(pairs.some(pair => pair.type === 'tag' && pair.openToken === '<>' && pair.closeToken === '</>'));
	});
});
