import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseTagAt, markupTags } from '../markup';
import { PairMatcher } from '../pairMatcher';
import { numberedIds, decodeAttribute } from '../uniqueIds';
import { PendingEdits } from '../pendingEdits';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
describe('shared markup boundaries', () => {
	it('keeps quoted angle brackets, empty values and boolean attributes intact', () => {
		const text = '<span title="a > b" class=\'badge\' empty="" hidden>text</span>', tag = parseTagAt(text, 0)!;
		assert.equal(tag.token, '<span title="a > b" class=\'badge\' empty="" hidden>');
		assert.deepEqual(tag.attributes.map(a => [a.name, a.value && text.slice(a.value.start, a.value.end)]), [['title', 'a > b'], ['class', 'badge'], ['empty', ''], ['hidden', undefined]]);
		assert.equal(tag.quotes.length, 3);
	});
	it('treats a backslash before an HTML closing quote as literal text', () => {
		const text = '<span data-path="C:\\" class="badge">', tag = parseTagAt(text, 0)!;
		assert.equal(tag.attributes[0].value!.end, text.indexOf('" class'));
		assert.equal(tag.attributes[1].name, 'class');
	});
	it('skips JSX expressions without exposing their string literals as attributes', () => {
		const text = '<Widget title={x > 1 ? "large" : "small"} {...props} className="badge" />', tag = parseTagAt(text, 0)!;
		assert.ok(tag.selfClosing);
		assert.deepEqual(tag.attributes.map(a => a.name), ['classname']);
	});
	it('finds void element IDs but ignores comments and raw script text', () => {
		const tags = markupTags('<!-- <input id="fake"> --><script>const s = "<input id=\'fake\'>";</script><input id="real"><textarea><input id="fake"></textarea>');
		assert.deepEqual(tags.flatMap(tag => tag.attributes.map(a => a.name)), ['id']);
	});
});

describe('pair ownership matching', () => {
	it('preserves the greedy nearest-boundary decisions and original-order ties', () => {
		let seed = 1024;
		const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
		for (let trial = 0; trial < 30; trial++) {
			const previous = Array.from({ length: 100 }, (_, order) => ({ value: { openIdx: Math.floor(random() * 600), closeIdx: Math.floor(random() * 600), id: order }, order }));
			const matcher = new PairMatcher([...previous]);
			for (let n = 0; n < 100; n++) {
				const open = Math.floor(random() * 800), close = Math.floor(random() * 800);
				previous.sort((a, b) => Math.abs(a.value.openIdx - open) + Math.abs(a.value.closeIdx - close) - Math.abs(b.value.openIdx - open) - Math.abs(b.value.closeIdx - close) || a.order - b.order);
				assert.equal(matcher.take(open, close)?.id, previous.shift()!.value.id);
			}
			assert.equal(matcher.take(0, 0), undefined);
		}
	});
});

it('allocates unused IDs including numeric and named entity equivalents', () => {
	const reserved = new Set(['shared_1', 'shared&#95;2', 'shared&lowbar;3'].map(decodeAttribute));
	assert.deepEqual(numberedIds('shared', 2, reserved), ['shared_4', 'shared_5']);
});

describe('automatic pending edits', () => {
	it('applies automatically, without an Enter or flush command', async () => {
		const queue = new PendingEdits(); let count = 0;
		await queue.queue('file', { version: 1, session: {}, valid: () => true, apply: async () => { count++; return true; } });
		assert.equal(count, 1);
	});
	it('flushes immediately before the automatic timer', async () => {
		const queue = new PendingEdits(); let count = 0;
		const pending = queue.queue('file', { version: 1, session: {}, valid: () => true, apply: async () => { count++; return true; } }, 1000);
		assert.equal(await queue.flush('file'), true);
		assert.equal(await pending, true);
		assert.equal(count, 1);
	});
	it('cancels an undo before the timer fires without replaying', async () => {
		const queue = new PendingEdits(); let count = 0;
		const pending = queue.queue('file', { version: 1, session: {}, valid: () => true, apply: async () => { count++; return true; } });
		queue.cancel('file');
		assert.equal(await pending, false);
		await delay(130);
		assert.equal(count, 0);
	});
	it('rejects stale document versions and replaced selection sessions', async () => {
		const queue = new PendingEdits(); let version = 1, session = {};
		const original = session;
		const pending = queue.queue('file', { version, session, valid: () => version === 1 && session === original, apply: async () => { assert.fail('stale edit applied'); } });
		version++; session = {};
		assert.equal(await pending, false);
	});
});
