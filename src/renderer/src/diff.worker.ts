export interface DiffRow {
	old: string;
	next: string;
	oldLine?: number;
	newLine?: number;
	type: 'meta' | 'hunk' | 'context' | 'delete' | 'add' | 'pair';
}
self.onmessage = (event: MessageEvent<{ id: number; text: string; split: boolean }>) => {
	const { id, text, split } = event.data;
	const rows: DiffRow[] = [];
	let oldLine = 0;
	let newLine = 0;
	const lines = text.split('\n');
	let truncated = false;
	for (let i = 0; i < lines.length; i++) {
		if (rows.length >= 120000) {
			truncated = true;
			break;
		}
		const line = lines[i];
		const match = /^(?:@@|##) -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? (?:@@|##)/.exec(line);
		if (match) {
			oldLine = Number(match[1]);
			newLine = Number(match[2]);
			rows.push({ old: line, next: line, type: 'hunk' });
		} else if (
			line.startsWith('---') ||
			line.startsWith('+++') ||
			/^(Index:|===|Property|___|Modified:|Added:|Deleted:)/.test(line) ||
			(!line.startsWith(' ') && !line.startsWith('+') && !line.startsWith('-'))
		) {
			rows.push({ old: line, next: line, type: 'meta' });
		} else if (line.startsWith('-')) {
			if (split) {
				const deleted: string[] = [line.slice(1)];
				while (lines[i + 1]?.startsWith('-') && !lines[i + 1].startsWith('---')) {
					deleted.push(lines[++i].slice(1));
				}
				const added: string[] = [];
				while (lines[i + 1]?.startsWith('+') && !lines[i + 1].startsWith('+++')) {
					added.push(lines[++i].slice(1));
				}
				for (let j = 0; j < Math.max(deleted.length, added.length); j++) {
					rows.push({
						old: deleted[j] ?? '',
						next: added[j] ?? '',
						oldLine: j < deleted.length ? oldLine++ : undefined,
						newLine: j < added.length ? newLine++ : undefined,
						type: 'pair',
					});
				}
			} else {
				rows.push({ old: line, next: line, oldLine: oldLine++, type: 'delete' });
			}
		} else if (line.startsWith('+')) {
			rows.push({ old: '', next: split ? line.slice(1) : line, newLine: newLine++, type: 'add' });
		} else {
			rows.push({ old: split ? line.slice(1) : line, next: split ? line.slice(1) : line, oldLine: oldLine++, newLine: newLine++, type: 'context' });
		}
	}
	self.postMessage({ id, rows, truncated });
};
