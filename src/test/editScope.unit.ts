import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { EditScope } from '../editScope';

describe('Mirrored edit scope', () => {
	it('keeps complete structures inside the selected bounds', () => {
		const scope = new EditScope({ start: 10, end: 40 }, { start: 0, end: 60 }, 'selection');
		assert.ok(scope.contains(10, 40));
		assert.ok(!scope.contains(9, 40));
		assert.ok(!scope.contains(10, 41));
		scope.kind = 'enclosing';
		assert.ok(scope.contains(0, 60));
		assert.ok(!scope.contains(0, 61));
		scope.kind = 'document';
		assert.ok(scope.contains(0, 1000));
	});
	it('tracks replacements before and within the original selection', () => {
		const scope = new EditScope({ start: 10, end: 40 }, { start: 0, end: 60 }, 'selection');
		scope.rebase(2, 3, 7);
		assert.deepEqual(scope.selection, { start: 14, end: 44 });
		scope.rebase(20, 5, 1);
		assert.deepEqual(scope.selection, { start: 14, end: 40 });
		assert.deepEqual(scope.enclosing, { start: 0, end: 60 });
		scope.rebase(80, 0, 5);
		assert.deepEqual(scope.selection, { start: 14, end: 40 });
	});
	it('keeps boundary insertions and clamps deleted bounds', () => {
		const scope = new EditScope({ start: 10, end: 40 }, { start: 0, end: 60 }, 'selection');
		scope.rebase(10, 0, 2);
		assert.deepEqual(scope.selection, { start: 10, end: 42 });
		scope.rebase(5, 50, 0);
		assert.deepEqual(scope.selection, { start: 5, end: 5 });
	});
});
