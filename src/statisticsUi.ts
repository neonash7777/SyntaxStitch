import { REPAIR_KINDS, type RepairSource, type RepairStatistics } from './repairStatistics';
import type { RepairKind } from './shadowStructure';

const timestampParts = (value: string): { date: string; time: string; milliseconds: number } => {
	const date = new Date(value), pad = (part: number): string => String(part).padStart(2, '0');
	return { date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`, time: `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`, milliseconds: date.getTime() };
};
const repairPeriod = (firstAt?: string, lastAt?: string): string => {
	if (!firstAt || !lastAt) { return 'Never'; }
	const first = timestampParts(firstAt), last = timestampParts(lastAt), elapsed = Math.max(0, last.milliseconds - first.milliseconds), totalSeconds = Math.floor(elapsed / 1000), days = Math.floor(totalSeconds / 86400), hours = Math.floor(totalSeconds % 86400 / 3600), minutes = Math.floor(totalSeconds % 3600 / 60), seconds = totalSeconds % 60, duration = `${days ? `${days}d ` : ''}${hours ? `${hours}h ` : ''}${minutes ? `${minutes}m ` : ''}${seconds}s`.trim();
	return `${first.date === last.date ? `${first.date} ${first.time} - ${last.time}` : `${first.date} ${first.time} - ${last.date} ${last.time}`} (${duration})`;
};
const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
export const statisticsHtml = (statistics: Readonly<RepairStatistics>): string => {
	const bySource = { direct: 0, indirect: 0, ...statistics.bySource }, byKindSource = Object.fromEntries(REPAIR_KINDS.map(kind => [kind, { direct: 0, indirect: 0, ...statistics.byKindSource?.[kind] }])) as Record<RepairKind, Record<RepairSource, number>>, labels: Record<RepairKind, string> = { square: 'Square brackets []', parenthesis: 'Parentheses ()', curly: 'Curly braces {}', tag: 'Tags', quote: 'Quotes', indent: 'Indentation \\tab' }, rows = REPAIR_KINDS.filter(kind => statistics.byKind[kind] > 0).map(kind => `<tr><td>${escapeHtml(labels[kind])}</td><td>${statistics.byKind[kind]}</td><td>${byKindSource[kind].direct}</td><td>${byKindSource[kind].indirect}</td></tr>`).join(''), lastRepair = statistics.lastRepair ? escapeHtml(statistics.lastRepair) : '';
	return `<!doctype html><html><head><meta charset="UTF-8"><style>
	:root { color-scheme: light dark; --border: #d1d5db; --muted: #6b7280; }
	body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.5; max-width: 760px; margin: 0 auto; padding: 28px 32px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
	h { text-align: left; font-weight: 600; } td, th { border-bottom: 1px solid var(--border); padding: 9px 12px; } td:not(:first-child), th:not(:first-child) { text-align: right; } table { border-collapse: collapse; width: 100%; margin: 12px 0 28px; } h1 { font-size: 1.45rem; margin: 0 0 24px; } h2 { font-size: 1rem; margin: 24px 0 8px; } .cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; } .card { border: 1px solid var(--border); padding: 14px; } .value { display: block; font-size: 1.35rem; font-weight: 650; } .label { color: var(--muted); font-size: .82rem; }
	</style></head><body><h1>SyntaxStitch Repair Statistics</h1><div class="cards"><div class="card"><span class="label">Total repairs</span><span class="value">${statistics.total}</span></div><div class="card"><span class="label">Direct</span><span class="value">${bySource.direct}</span></div><div class="card"><span class="label">Indirect</span><span class="value">${bySource.indirect}</span></div></div><h2>Repair Types</h2><table><thead><tr><th>Type</th><th>Total</th><th>Direct</th><th>Indirect</th></tr></thead><tbody>${rows || '<tr><td colspan="4">No repair types recorded.</td></tr>'}</tbody></table><h2>Period</h2><p>${escapeHtml(repairPeriod(statistics.firstAt, statistics.lastAt))}</p>${lastRepair ? `<h2>Last Repair</h2><p>${lastRepair}</p>` : ''}</body></html>`;
};
export const repairStatusPresentation = (statistics: Readonly<RepairStatistics>, enabled: boolean): { text: string; tooltip: string; accessibilityLabel: string } => {
	const state = enabled ? 'enabled' : 'disabled', { total, byKind, unclassified, lastRepair } = statistics, bySource = { direct: 0, indirect: 0, ...statistics.bySource }, byKindSource = Object.fromEntries(REPAIR_KINDS.map(kind => [kind, { direct: 0, indirect: 0, ...statistics.byKindSource?.[kind] }])) as Record<RepairKind, Record<RepairSource, number>>;
	const labels: Record<RepairKind, string> = { square: '[]  Square brackets', parenthesis: '()  Parentheses', curly: '{}  Curly braces', tag: '<>  Tags', quote: '""  Quotes', indent: '\\tab  Indentation' };
	const details = [`Direct: ${bySource.direct}`, `Indirect: ${bySource.indirect}`, ...REPAIR_KINDS.filter(kind => byKind[kind] > 0).map(kind => `${labels[kind]}: ${byKind[kind]} (direct ${byKindSource[kind].direct}, indirect ${byKindSource[kind].indirect})`), `Period: ${repairPeriod(statistics.firstAt, statistics.lastAt)}`];
	if (unclassified) { details.push(`?  Legacy unclassified: ${unclassified}`); }
	return { text: `{S} ${total}`, tooltip: `SyntaxStitch is ${state}.\n\n${total} repairs\n${details.join('\n')}${lastRepair ? `\n\nLast repair\n${lastRepair}` : ''}\n\nClick for actions.`, accessibilityLabel: `SyntaxStitch is ${state} with ${total} repairs.${lastRepair ? ` Last repair: ${lastRepair}.` : ''} Activate for actions.` };
};
export const STATUS_ACTIVITY_PREFIX = '$(sync~spin) ';
export const animatedRepairStatusText = (text: string): string => `${STATUS_ACTIVITY_PREFIX}${text}`;
