import type { SelectionSpan, TokenPair } from './shadowStructure';
import type { StructuralSelectionMode, StructuralSelectionSpan } from './selectionTypes';

type ComponentContext = {
	text: string;
	pairs: readonly TokenPair[];
	mode: StructuralSelectionMode;
	contains: (pair: TokenPair) => boolean;
	componentsOf: (pair: TokenPair) => StructuralSelectionSpan[];
	tagName: (pair: TokenPair) => string | undefined;
};

/** One resolver supplies both the preview and the actual mirrored replacements. */
export function planComponentEdit({ text, pairs, mode, contains, componentsOf, tagName }: ComponentContext): { source: SelectionSpan; targets: SelectionSpan[] } | undefined {
	const focused = mode.spans[mode.focused];
	if (!focused || !['property', 'value', 'attribute'].includes(focused.role)) { return; }
	const current = pairs.filter(pair => pair.type === 'tag' && pair.openIdx <= focused.start && focused.start < pair.openIdx + pair.openToken.length).sort((a, b) => b.openIdx - a.openIdx)[0];
	if (!current) { return; }
	const components = componentsOf(current);
	const componentIndex = components.findIndex(component => component.role === focused.role && component.start <= focused.start && focused.start <= component.end);
	const propertyIndex = focused.role === 'attribute' ? components.findIndex(component => component.role === 'property' && text.slice(component.start, component.end).toLowerCase() === focused.attributeName) : focused.role === 'property' ? componentIndex : components.map((component, index) => component.role === 'property' && component.start < focused.start ? index : -1).filter(index => index >= 0).at(-1) ?? -1;
	if (propertyIndex < 0 && focused.role !== 'attribute') { return; }
	const property = components[propertyIndex], propertyName = focused.attributeName ?? (property ? text.slice(property.start, property.end).toLowerCase() : undefined);
	if (!propertyName) { return; }
	const disabled = [mode, ...(mode.ancestors ?? [])].flatMap(level => level.spans).filter(span => span.role === 'structure' && (span.highlighted === false || !span.active));
	const name = tagName(current);
	if (!name) { return; }
	const targets = pairs.filter(pair => pair.type === 'tag' && contains(pair) && tagName(pair) === name && !disabled.some(span => span.start === pair.openIdx && span.end === pair.closeIdx + pair.closeToken.length)).flatMap(pair => {
		const peers = componentsOf(pair), properties = peers.filter(component => component.role === 'property');
		const key = pair === current && property ? peers.find(component => component.role === 'property' && component.start === property.start) : properties.find(component => text.slice(component.start, component.end).toLowerCase() === propertyName);
		if (!key) { return []; }
		if (focused.role === 'property' && pair !== current && properties.some(candidate => candidate !== key && text.slice(candidate.start, candidate.end).toLowerCase() === text.slice(focused.start, focused.end).toLowerCase())) { return []; }
		if (focused.role === 'property') { return [key]; }
		const value = peers[peers.indexOf(key) + 1];
		if (focused.role === 'value') { return value?.role === 'value' ? [value] : []; }
		const end = value?.role === 'value' ? value.end + ((text[value.start - 1] === '"' || text[value.start - 1] === "'") && text[value.end] === text[value.start - 1] ? 1 : 0) : key.end;
		return [{ start: key.start, end }];
	});
	const source = focused.role === 'attribute' ? focused : components[componentIndex] ?? focused;
	if (source.start !== focused.start || source.end !== focused.end) { return; }
	return { source, targets };
}
