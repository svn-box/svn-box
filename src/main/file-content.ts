import { z } from 'zod';
import { constants } from 'node:fs';
import { readRecord, writeRecord } from './local-records';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { access, lstat, mkdir, readFile, readdir, writeFile, rename, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { Action, DiffResult, FileBackup } from '../shared/types';
import { translate } from '../shared/i18n';
import { SvnError } from './runner';
const exec = promisify(execFile);
export const contentLimit = 32 * 1024 * 1024;
const backupRecord = z.object({
	id: z.uuid(),
	wcId: z.string().min(1),
	path: z.string().min(1),
	createdAt: z.iso.datetime(),
	reason: z.enum(['recover', 'restore-backup', 'resolve-local', 'resolve-incoming', 'merge', 'apply-merge']),
	bytes: z.number().int().nonnegative().max(contentLimit),
	hash: z.string().regex(/^[a-f0-9]{64}$/),
});

export function contentHash(bytes: Buffer): string {
	return createHash('sha256').update(bytes).digest('hex');
}

export function textContent(bytes: Buffer): string | undefined {
	if (bytes.includes(0)) {
		return undefined;
	}
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		return undefined;
	}
}

export async function regularContent(target: string): Promise<Buffer> {
	const info = await lstat(target);
	if (!info.isFile() || info.size > contentLimit) {
		throw new SvnError({ kind: 'validation', message: translate('fileVersions.regularOnly') });
	}
	return readFile(target);
}

export async function assertWritableContent(target: string): Promise<void> {
	try {
		const info = await lstat(target);
		if (!info.isFile() || !(info.mode & 0o222)) {
			throw new Error('read-only target');
		}
		await access(target, constants.W_OK);
	} catch {
		throw new SvnError({ kind: 'path', message: translate('fileVersions.readOnly') });
	}
}

export async function contentDiff(directory: string, before: Buffer, after: Buffer, signal?: AbortSignal): Promise<DiffResult> {
	if (textContent(before) === undefined || textContent(after) === undefined) {
		return { text: '', unsupported: translate('fileVersions.binaryPreview') };
	}
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const id = randomUUID();
	const left = join(directory, `${id}-before`);
	const right = join(directory, `${id}-after`);
	try {
		await writeFile(left, before, { mode: 0o600 });
		await writeFile(right, after, { mode: 0o600 });
		try {
			const result = await exec('/usr/bin/diff', ['-u', '-L', 'current', '-L', 'selected', left, right], { maxBuffer: contentLimit, signal });
			return { text: result.stdout };
		} catch (error) {
			const result = error as { code?: number; stdout?: string };
			if (result.code === 1 && typeof result.stdout === 'string') {
				return { text: result.stdout };
			}
			throw error;
		}
	} finally {
		await Promise.all([rm(left, { force: true }), rm(right, { force: true })]);
	}
}

export class FileBackups {
	private directory: string;

	constructor(directory: string) {
		this.directory = join(directory, 'file-backups');
	}

	async create(wcId: string, path: string, reason: Action, bytes: Buffer): Promise<FileBackup> {
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		const record = { id: randomUUID(), wcId, path, reason, bytes: bytes.length, createdAt: new Date().toISOString() };
		await writeFile(join(this.directory, `${record.id}.data`), bytes, { mode: 0o600 });
		await writeRecord(join(this.directory, `${record.id}.json`), { ...record, hash: contentHash(bytes) });
		return record;
	}

	async list(wcId: string, path: string): Promise<FileBackup[]> {
		const names = await readdir(this.directory).catch((error: NodeJS.ErrnoException) => {
			if (error.code === 'ENOENT') {
				return [];
			}
			throw error;
		});
		const result: FileBackup[] = [];
		for (const name of names) {
			if (/^[a-f0-9-]{36}\.json$/.test(name)) {
				const record = await readRecord(join(this.directory, name), backupRecord);
				if (record?.wcId === wcId && record.path === path) {
					result.push(record);
				}
			}
		}
		return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}

	async content(wcId: string, path: string, id: string): Promise<Buffer> {
		if (!/^[a-f0-9-]{36}$/.test(id)) {
			throw new SvnError({ kind: 'validation', message: translate('fileVersions.backupInvalid') });
		}
		const record = await readRecord(join(this.directory, `${id}.json`), backupRecord);
		if (!record) {
			throw new SvnError({ kind: 'stale', message: translate('fileVersions.backupInvalid') });
		}
		const bytes = await regularContent(join(this.directory, `${id}.data`));
		if (record.wcId !== wcId || record.path !== path || contentHash(bytes) !== record.hash) {
			throw new SvnError({ kind: 'stale', message: translate('fileVersions.backupInvalid') });
		}
		return bytes;
	}
}

export async function replaceContent(target: string, bytes: Buffer, validate: (temporary?: string) => Promise<void>): Promise<void> {
	await assertWritableContent(target);
	const info = await lstat(target);
	const temporary = join(dirname(target), `.svnbox-${randomUUID()}.tmp`);
	try {
		await writeFile(temporary, bytes, { mode: info.mode & 0o777, flag: 'wx' });
		await validate(temporary);
		await assertWritableContent(target);
		await rename(temporary, target);
	} finally {
		await rm(temporary, { force: true });
	}
}
