export type PendingEdit = { version: number; session: object; apply: () => Promise<boolean>; valid: () => boolean };
type Entry = { edit: PendingEdit; timer?: ReturnType<typeof setTimeout>; promise: Promise<boolean>; resolve: (applied: boolean) => void; cancelled: boolean };

/** One queued transaction per document. Cancellation never reschedules an edit. */
export class PendingEdits {
	private readonly entries = new Map<string, Entry>();
	has(key: string): boolean { return this.entries.has(key); }

	queue(key: string, edit: PendingEdit, delayMs = 100): Promise<boolean> {
		this.cancel(key);
		let resolve!: (applied: boolean) => void;
		const promise = new Promise<boolean>(done => { resolve = done; });
		const entry: Entry = { edit, promise, resolve, cancelled: false };
		entry.timer = setTimeout(() => { void this.run(key, entry); }, delayMs);
		this.entries.set(key, entry);
		return promise;
	}

	private async run(key: string, entry: Entry): Promise<boolean> {
		if (entry.timer) { clearTimeout(entry.timer); entry.timer = undefined; }
		let applied = false;
		try { if (!entry.cancelled && entry.edit.valid()) { applied = await entry.edit.apply(); } }
		catch (error) { console.error('SyntaxStitch: automatic edit failed', error); }
		finally {
			if (this.entries.get(key) === entry) { this.entries.delete(key); }
			entry.resolve(applied);
		}
		return applied;
	}

	async flush(key: string): Promise<boolean> {
		const entry = this.entries.get(key);
		if (!entry) { return false; }
		if (entry.timer) { return this.run(key, entry); }
		return entry.promise;
	}

	cancel(key: string): void {
		const entry = this.entries.get(key);
		if (!entry) { return; }
		entry.cancelled = true;
		if (entry.timer) { clearTimeout(entry.timer); entry.resolve(false); }
		this.entries.delete(key);
	}

	cancelAll(): void { for (const key of this.entries.keys()) { this.cancel(key); } }
}
