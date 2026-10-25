const outputLimit = 1024 * 1024;
const omitted = '[仓盒] 较早的命令输出已省略，仅保留最近约 100 万字符。\n';

export function appendOperationLog(logs: string[], text: string): void {
	let truncated = logs[0] === omitted;
	if (truncated) {
		logs.shift();
	}
	const last = logs.length - 1;
	if (last >= 0 && logs[last].length + text.length <= 8192) {
		logs[last] += text;
	} else {
		logs.push(text);
	}
	let excess = logs.reduce((size, chunk) => size + chunk.length, 0) - outputLimit;
	while (excess > 0 && logs.length) {
		truncated = true;
		if (logs[0].length <= excess) {
			excess -= logs.shift()!.length;
		} else {
			let cut = excess;
			// Keep a complete Unicode code point at the retained boundary.
			const next = logs[0].charCodeAt(cut);
			if (next >= 0xdc00 && next <= 0xdfff) {
				cut++;
			}
			logs[0] = logs[0].slice(cut);
			excess = 0;
		}
	}
	if (truncated) {
		logs.unshift(omitted);
	}
}
