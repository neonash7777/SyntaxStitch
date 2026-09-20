import type { SelectionSpan } from './shadowStructure';

export type StructuralSelectionRole = 'structure' | 'property' | 'value' | 'value-part' | 'attribute';
export type StructuralSelectionSpan = SelectionSpan & { active: boolean; highlighted?: boolean; role: StructuralSelectionRole; attributeName?: string };
export type StructuralSelectionStage = 'structure' | 'inner' | 'components';
export type StructuralSelectionLevel = { scope: SelectionSpan; spans: StructuralSelectionSpan[]; focused: number; stage: StructuralSelectionStage };
export type StructuralSelectionMode = StructuralSelectionLevel & { ancestors?: StructuralSelectionLevel[]; typing?: boolean };
