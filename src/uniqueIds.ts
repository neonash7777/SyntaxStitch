import { decodeHTMLAttribute } from 'entities';

/** Generate suffixes without changing or colliding with IDs outside this transaction. */
export function numberedIds(base: string, count: number, reserved: ReadonlySet<string>): string[] {
	const used = new Set(reserved), result: string[] = [];
	for (let suffix = 1; result.length < count; suffix++) {
		const candidate = `${base}_${suffix}`;
		if (!used.has(candidate)) { used.add(candidate); result.push(candidate); }
	}
	return result;
}

export const decodeAttribute = decodeHTMLAttribute;
