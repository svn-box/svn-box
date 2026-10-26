import { translate } from '../shared/i18n';
import { spawn, type ChildProcess } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppError } from '../shared/types';
export class SvnError extends Error {
	readonly info: AppError;

	constructor(info: AppError) {
		super(info.message);
		this.info = info;
	}
}

export function classify(detail: string): AppError {
	if (/E160028|out of date/i.test(detail)) {
		return {
			kind: 'outdated',
			message: translate('runner.theWorkingCopyIsOutOfDateUpdate'),
			detail: redact(detail),
		};
	}
	const kind = /E170001|E215004|E170013.*auth|Authentication failed|authorization failed/i.test(detail)
		? 'auth'
		: /certificate|E230001/i.test(detail)
			? 'certificate'
			: /E155004|E155037|locked/i.test(detail)
				? 'locked'
				: /E155007|E155010|ENOENT|not found|does not exist|not a working copy/i.test(detail)
					? 'path'
					: /E170013|E175002|E7300|connection|resolve hostname|network|timed out/i.test(detail)
						? 'network'
						: /E155015|conflict/i.test(detail)
							? 'conflict'
							: 'command';
	const message = {
		auth: translate('runner.authenticationFailedCheckTheRepositorySCredentials'),
		certificate: translate('runner.serverCertificateVerificationFailedVerifyTheCertificateBefore'),
		locked: translate('runner.theWorkingCopyIsLockedRunCleanupFrom'),
		path: translate('runner.thePathIsInvalidOrIsNotA'),
		network: translate('runner.unableToConnectToTheRepositoryCheckYour'),
		conflict: translate('runner.resolveTheWorkingCopyConflictsFirst'),
		command: translate('runner.svnCommandFailed'),
	}[kind];
	return { kind, message, detail: redact(detail) };
}

export function redact(value: string): string {
	return value.replace(/(https?:\/\/)[^/@\s]+@/g, translate('runner.credentialsHidden')).replace(/(password|passwd|token)([=: ]+)\S+/gi, translate('runner.hidden'));
}

export class Runner {
	executable = '';
	private children = new Set<ChildProcess>();
	private shuttingDown = false;
	private bundledExecutable: string;

	constructor(bundledExecutable = join(process.cwd(), `resources/svn/darwin-${process.arch}/bin/svn`)) {
		this.bundledExecutable = bundledExecutable;
	}

	async detect(configured?: string): Promise<{ path: string; version: string; ok: boolean; error?: string }> {
		const candidates = configured ? [configured] : [this.bundledExecutable, this.executable, '/opt/homebrew/bin/svn', '/usr/local/bin/svn', '/usr/bin/svn'].filter(Boolean);
		let last = '';
		for (const candidate of candidates) {
			try {
				await access(candidate);
				const { stdout } = await this.run(['--version', '--quiet'], { executable: candidate, timeout: 10000 });
				if (!/^1\.\d+\.\d+/.test(stdout.trim())) {
					throw new Error(translate('runner.theExecutableIsNotARecognizedSvnClient'));
				}
				this.executable = candidate;
				return { path: candidate, version: stdout.trim(), ok: true };
			} catch (error) {
				last = String(error);
			}
		}
		return {
			path: configured ?? '',
			version: '',
			ok: false,
			error: last || translate('runner.svnWasNotFoundInstallSubversionOrSpecify'),
		};
	}

	run(
		args: string[],
		options: { cwd?: string; signal?: AbortSignal; timeout?: number; onData?: (text: string) => void; executable?: string; password?: string } = {},
	): Promise<{ stdout: string; stderr: string }> {
		if (this.shuttingDown) {
			return Promise.reject(
				new SvnError({
					kind: 'cancelled',
					message: translate('runner.theAppIsShuttingDown'),
				}),
			);
		}
		const executable = options.executable ?? this.executable;
		if (!executable) {
			return Promise.reject(
				new SvnError({
					kind: 'path',
					message: translate('runner.configureTheSvnExecutableInSettingsFirst'),
				}),
			);
		}
		return new Promise((resolve, reject) => {
			if (options.signal?.aborted) {
				reject(
					new SvnError({
						kind: 'cancelled',
						message: translate('runner.operationCancelledCompletedChangesWillNotBeUndone'),
					}),
				);
				return;
			}
			const child = spawn(executable, args, {
				cwd: options.cwd,
				shell: false,
				env: { ...process.env, LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' },
				stdio: ['pipe', 'pipe', 'pipe'],
			});
			this.children.add(child);
			let stdout = '';
			let stderr = '';
			let cancelled = false;
			let timedOut = false;
			let oversized = false;
			let killTimer: ReturnType<typeof setTimeout> | undefined;

			const stop = (): void => {
				child.kill('SIGTERM');
				killTimer ??= setTimeout(() => child.kill('SIGKILL'), 2000);
			};

			const abort = (): void => {
				cancelled = true;
				stop();
			};

			const timeout = setTimeout(() => {
				timedOut = true;
				stop();
			}, options.timeout ?? 120000);
			options.signal?.addEventListener('abort', abort, { once: true });
			child.stdout.setEncoding('utf8');
			child.stderr.setEncoding('utf8');

			const consume = (chunk: string, isError: boolean): void => {
				if (isError) {
					stderr += chunk;
				} else {
					stdout += chunk;
				}
				options.onData?.(redact(chunk));
				if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 32 * 1024 * 1024) {
					oversized = true;
					stop();
				}
			};

			child.stdout.on('data', (chunk: string) => consume(chunk, false));
			child.stderr.on('data', (chunk: string) => consume(chunk, true));
			child.stdin.on('error', () => {});
			child.stdin.end(options.password === undefined ? undefined : `${options.password}\n`);

			const cleanup = (): void => {
				clearTimeout(timeout);
				clearTimeout(killTimer);
				options.signal?.removeEventListener('abort', abort);
				this.children.delete(child);
			};

			child.on('error', (error) => {
				cleanup();
				reject(new SvnError(classify(String(error))));
			});
			child.on('close', (code) => {
				cleanup();
				if (cancelled) {
					reject(
						new SvnError({
							kind: 'cancelled',
							message: translate('runner.operationCancelledCompletedChangesWillNotBeUndone'),
							detail: redact(stderr),
						}),
					);
				} else if (timedOut) {
					reject(
						new SvnError({
							kind: 'network',
							message: translate('runner.theSvnCommandTimedOutAndItsProcess'),
							detail: redact(stderr),
						}),
					);
				} else if (oversized) {
					reject(
						new SvnError({
							kind: 'command',
							message: translate('runner.outputExceedsMibNarrowTheQueryScope'),
						}),
					);
				} else if (code !== 0) {
					reject(
						new SvnError(
							classify(
								stderr ||
									stdout ||
									translate('runner.processExitedWithCode', {
										code: code,
									}),
							),
						),
					);
				} else {
					resolve({ stdout, stderr });
				}
			});
		});
	}

	shutdown(): void {
		this.shuttingDown = true;
		for (const child of this.children) {
			child.kill('SIGTERM');
			const timer = setTimeout(() => child.kill('SIGKILL'), 1500);
			timer.unref();
		}
	}
}
