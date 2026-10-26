import { randomUUID } from 'node:crypto';
import { lstat, readFile, writeFile, rename, rm } from 'node:fs/promises';
import type { z } from 'zod';

export async function readRecord<T>(path: string, schema: z.ZodType<T>): Promise<T | undefined> {
	try {
		const info = await lstat(path);
		if (!info.isFile() || info.size > 64 * 1024) {
			return undefined;
		}
		const result = schema.safeParse(JSON.parse(await readFile(path, 'utf8')));
		return result.success ? result.data : undefined;
	} catch (error) {
		if (error instanceof SyntaxError || ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
			return undefined;
		}
		throw error;
	}
}

export async function writeRecord(path: string, value: object): Promise<void> {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}
