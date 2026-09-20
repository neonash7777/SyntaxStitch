import { it } from 'node:test';
import * as assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { ShadowStructure } from '../shadowStructure';

it('indexes a large sparse document and plans a localized repair within a broad regression budget', () => {
	// Sparse long comments exercise file size without thousands of duplicate pair candidates.
	const text = `/*${' large file fixture '.repeat(50000)}*/\ncall(value);`, start = performance.now();
	const shadow = new ShadowStructure(text, 'javascript'), close = text.lastIndexOf(')');
	const patches = shadow.planRepairs([{ range: undefined as never, rangeOffset: close, rangeLength: 1, text: '' }], text.slice(0, close) + text.slice(close + 1));
	assert.equal(patches.length, 1);
	assert.equal(patches[0].text, ')');
	assert.ok(performance.now() - start < 2000, 'Large-file indexing and repair planning exceeded 2 seconds');
});

it('reindexes dense code without a whole-bucket sort for every pair', () => {
	const text = 'call({ value: [1, 2] });\n'.repeat(4000), shadow = new ShadowStructure(text, 'javascript');
	const ids = shadow.pairs.map(pair => pair.id), start = performance.now();
	for (let offset = 1; offset <= 5; offset++) { shadow.reindex(' '.repeat(offset) + text, 'javascript'); }
	assert.deepEqual(shadow.pairs.map(pair => pair.id), ids);
	assert.ok(performance.now() - start < 1000, 'Five dense 12,000-pair reindexes exceeded one second');
});
