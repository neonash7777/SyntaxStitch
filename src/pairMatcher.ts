/** Matches previous ownership without sorting every compatible pair for each token. */
export class PairMatcher<T extends { openIdx: number; closeIdx: number }> {
	readonly records: { value: T; order: number }[];
	readonly next: number[];
	readonly previous: number[];

	constructor(records: { value: T; order: number }[]) {
		this.records = records.sort((a, b) => a.value.openIdx - b.value.openIdx || a.order - b.order);
		this.next = Array.from({ length: records.length + 2 }, (_, index) => index);
		this.previous = [...this.next];
	}

	private find(links: number[], index: number): number {
		let root = index;
		while (links[root] !== root) { root = links[root]; }
		while (links[index] !== index) { const next = links[index]; links[index] = root; index = next; }
		return root;
	}

	take(openIdx: number, closeIdx: number): T | undefined {
		let low = 0, high = this.records.length;
		while (low < high) { const middle = (low + high) >>> 1; if (this.records[middle].value.openIdx < openIdx) { low = middle + 1; } else { high = middle; } }
		let left = this.find(this.previous, low), right = this.find(this.next, low + 1), best = -1, distance = Infinity;
		while (left > 0 || right <= this.records.length) {
			const leftGap = left > 0 ? Math.abs(this.records[left - 1].value.openIdx - openIdx) : Infinity;
			const rightGap = right <= this.records.length ? Math.abs(this.records[right - 1].value.openIdx - openIdx) : Infinity;
			if (Math.min(leftGap, rightGap) > distance || leftGap === Infinity && rightGap === Infinity) { break; }
			const index = leftGap <= rightGap ? left : right, candidate = this.records[index - 1];
			const score = Math.abs(candidate.value.openIdx - openIdx) + Math.abs(candidate.value.closeIdx - closeIdx);
			if (score < distance || score === distance && (best < 0 || candidate.order < this.records[best - 1].order)) { best = index; distance = score; }
			if (index === left) { left = this.find(this.previous, left - 1); } else { right = this.find(this.next, right + 1); }
		}
		if (best < 0) { return; }
		this.previous[best] = this.find(this.previous, best - 1);
		this.next[best] = this.find(this.next, best + 1);
		return this.records[best - 1].value;
	}
}
