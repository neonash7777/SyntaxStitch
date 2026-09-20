import type { SelectionSpan } from './shadowStructure';

export type MirroringScope = 'selection' | 'enclosing' | 'document';

/** Bounds are captured on entry, independently of navigation, then follow edits. */
export class EditScope {
	constructor(public selection: SelectionSpan, public enclosing: SelectionSpan, public kind: MirroringScope) {}

	contains(start: number, end: number): boolean {
		if (this.kind === 'document') { return true; }
		const bounds = this.kind === 'enclosing' ? this.enclosing : this.selection;
		return bounds.start <= start && end <= bounds.end;
	}

	rebase(offset: number, removed: number, inserted: number): void {
		const delta = inserted - removed, oldEnd = offset + removed;
		const shift = (span: SelectionSpan): SelectionSpan => {
			if (oldEnd <= span.start && offset < span.start) { return { start: span.start + delta, end: span.end + delta }; }
			if (offset > span.end) { return span; }
			return { start: Math.min(span.start, offset), end: Math.max(Math.min(span.start, offset), span.end >= oldEnd ? span.end + delta : offset + inserted) };
		};
		this.selection = shift(this.selection);
		this.enclosing = shift(this.enclosing);
	}
}
