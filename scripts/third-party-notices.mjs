import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

const check = process.argv.includes('--check');
assert.ok(
	process.argv.slice(2).every((argument) => argument === '--check'),
	'Only --check is supported.',
);
const root = resolve('.');
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
const expected = new Map();
const rows = [];
const licensePattern = /^(licen[sc]e|copying|notice|copyright)([.\-_]|$)/i;

async function include(path, contents) {
	expected.set(path, contents);
	if (check) {
		assert.deepEqual(await readFile(join(root, path)), contents, `${path} is stale; run npm run licenses:generate.`);
	} else {
		await mkdir(resolve(root, path, '..'), { recursive: true });
		await writeFile(join(root, path), contents);
	}
}

for (const [location, metadata] of Object.entries(lock.packages)) {
	if (!location || metadata.dev || metadata.devOptional) {
		continue;
	}
	const directory = join(root, location);
	let installed;
	try {
		installed = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
	} catch (error) {
		if (error.code === 'ENOENT' && metadata.optional) {
			continue;
		}
		throw error;
	}
	assert.equal(installed.version, metadata.version, `${location} differs from the lockfile; run npm ci.`);
	assert.equal(installed.license, metadata.license, `${location} has conflicting license metadata.`);
	const files = (await readdir(directory, { withFileTypes: true }))
		.filter((entry) => entry.isFile() && licensePattern.test(entry.name))
		.sort((a, b) => a.name.localeCompare(b.name, 'en'));
	const notices = await Promise.all(files.map((entry) => readFile(join(directory, entry.name))));
	if (notices.length === 0) {
		const sources = JSON.parse(await readFile(join(root, 'resources/licenses/upstream/sources.json'), 'utf8'));
		const fallback = sources[installed.name];
		assert.equal(fallback?.version, installed.version, `Review the missing license for ${installed.name}@${installed.version}.`);
		notices.push(await readFile(join(root, 'resources/licenses/upstream', fallback.file)));
	}
	assert.ok(notices.length > 0, `${installed.name} has no license text; review the upstream license before regenerating.`);
	assert.ok(metadata.license, `${installed.name} has no declared license.`);
	const links = [];
	for (const contents of notices) {
		const digest = createHash('sha256').update(contents).digest('hex').slice(0, 16);
		const path = `resources/licenses/npm/${digest}.txt`;
		await include(path, contents);
		links.push(`[${installed.name === 'lucide-react' ? 'ISC + MIT (Feather)' : metadata.license}](${path})`);
	}
	rows.push(`| ${installed.name} | ${installed.version} | ${links.join(' · ')} |`);
}

const metadata = JSON.parse(
	execFileSync('cargo', ['metadata', '--locked', '--format-version', '1', '--filter-platform', 'aarch64-apple-darwin', '--manifest-path', 'src-tauri/Cargo.toml'], {
		encoding: 'utf8',
		maxBuffer: 32 * 1024 * 1024,
	}),
);
const used = new Set(metadata.resolve.nodes.map((node) => node.id));
const rustRows = [];
for (const pkg of metadata.packages.filter((pkg) => pkg.source && used.has(pkg.id)).sort((a, b) => a.name.localeCompare(b.name))) {
	const directory = dirname(pkg.manifest_path);
	const candidates = (await readdir(directory, { withFileTypes: true }))
		.filter((entry) => entry.isFile() && licensePattern.test(entry.name))
		.map((entry) => join(directory, entry.name))
		.sort();
	if (pkg.license_file && !candidates.includes(join(directory, pkg.license_file))) {
		candidates.push(join(directory, pkg.license_file));
	}
	const links = [];
	if (!candidates.length) {
		const license =
			pkg.name === 'alloc-stdlib'
				? 'alloc-stdlib-BSD-3-Clause.txt'
				: pkg.license?.includes('MIT')
					? 'standard-MIT-terms.txt'
					: pkg.license === 'MPL-2.0'
						? 'MPL-2.0.txt'
						: null;
		assert.ok(license, `${pkg.name} ${pkg.version} has no license text; inspect its upstream source.`);
		const headers = [];
		for (const filename of (await readdir(directory, { recursive: true })).sort()) {
			if (filename.endsWith('.rs')) {
				const lines = (await readFile(join(directory, filename), 'utf8')).split('\n').filter((line) => /copyright|SPDX-License-Identifier/i.test(line));
				if (lines.length) {
					headers.push(`${filename}:\n${lines.join('\n')}`);
				}
			}
		}
		const declaration = `Package: ${pkg.name} ${pkg.version}\nRepository: ${pkg.repository}\nLicense declared by upstream: ${pkg.license}\nAuthors (Cargo metadata): ${pkg.authors.join('; ')}\n\nThe published crate omits a standalone license file. Its original Cargo manifest, README and source copyright/license headers are retained below, followed by the declared license's standard terms. No copyright year is inferred.\n\n${await readFile(pkg.manifest_path, 'utf8')}\n\n${pkg.readme ? await readFile(join(directory, pkg.readme), 'utf8') : ''}\n\n${headers.join('\n\n')}\n\n${await readFile(join(root, 'resources/licenses/upstream', license), 'utf8')}`;
		const digest = createHash('sha256').update(declaration).digest('hex').slice(0, 16);
		const path = `resources/licenses/rust/${digest}.txt`;
		await include(path, Buffer.from(declaration));
		links.push(`[declaration, original notices and terms](${path})`);
	}
	for (const file of candidates) {
		const contents = await readFile(file);
		const digest = createHash('sha256').update(contents).digest('hex').slice(0, 16);
		const path = `resources/licenses/rust/${digest}.txt`;
		await include(path, contents);
		links.push(`[${basename(file)}](${path})`);
	}
	rustRows.push(`| ${pkg.name} | ${pkg.version} | ${pkg.license ?? 'See license file'} | ${links.join(' · ')} |`);
	if (pkg.license === 'MPL-2.0') {
		const archive = join(directory, '..', '..', '..', 'cache', basename(dirname(directory)), `${pkg.name}-${pkg.version}.crate`);
		await include(`resources/licenses/sources/${pkg.name}-${pkg.version}.crate`, await readFile(archive));
	}
}
const nativeRoot = 'resources/svn/darwin-arm64';
const nativeManifest = JSON.parse(await readFile(join(root, nativeRoot, 'manifest.json'), 'utf8'));
const nativeRows = [];
for (const item of [{ name: 'subversion', version: nativeManifest.version, url: nativeManifest.sourceUrl }, ...nativeManifest.dependencies]) {
	const directory = join(root, nativeRoot, 'licenses', item.name);
	const links = [];
	for (const name of (await readdir(directory)).sort()) {
		const path = `resources/licenses/native/${item.name}/${name}`;
		await include(path, await readFile(join(directory, name)));
		links.push(`[${name}](${path})`);
	}
	assert.ok(links.length, `Missing native license: ${item.name}`);
	nativeRows.push(`| [${item.name}](${item.url}) | ${item.version} | ${links.join(' · ')} |`);
}
const contents = `# Third-party notices / 第三方声明

svnbox retains the original licenses and copyrights of the components below. Its source-available license and sales restriction do not relicense these components or restrict rights granted for their independent use and distribution.

仓盒保留下列组件的原许可证和著作权。本项目的源码可用许可及销售限制不重新授权这些组件，也不限制其原许可证允许的独立使用和分发。

## Frontend dependencies / 前端依赖

Locked production npm dependencies and transitive dependencies are listed conservatively; bundling may remove unused code. Original notices are preserved at the local links below. Native application bundles contain the compiled frontend rather than a Node.js runtime.

下表保留锁定的前端依赖及传递依赖的许可全文；构建可能移除未使用代码。安装包仅包含编译后的前端，不内置 Node.js 运行时。

| Package / 软件包 | Version / 版本 | License and notices / 许可与声明 |
| --- | --- | --- |
${rows.join('\n')}

## Rust dependencies / Rust 依赖

The locked macOS arm64 Cargo dependency graph is listed conservatively, including build tools and procedural macros. System WebKit, system libraries and fonts are provided by macOS. This application does not bundle Electron or Chromium.

下表覆盖 Cargo.lock 锁定的 macOS arm64 Rust 依赖，也列出构建工具与过程宏。系统 WebKit、系统库与字体由 macOS 提供，应用不内置 Electron 或 Chromium。

If a crate omits standalone license files, its license declaration, authors, original manifest, README and source copyright headers are preserved alongside the declared license terms. No copyright year is invented. The alloc-stdlib BSD notice is preserved from the upstream [commit](https://github.com/dropbox/rust-alloc-no-stdlib/blob/0a81fd6928ea3b33c8cd484aa4575d50ffb98012/LICENSE). Unmodified sources of MPL-2.0 crates are included under resources/licenses/sources/.

| Crate | Version / 版本 | Declared license / 声明许可 | Full texts / 完整原文 |
| --- | --- | --- | --- |
${rustRows.join('\n')}

## Bundled SVN runtime / 内置 SVN 运行时

Subversion and its native dependencies retain their original LICENSE and NOTICE files. Subversion's LICENSE includes the embedded LZ4, utf8proc, Unicode and other notices. The runtime manifest records source URLs and checksums. The local TCP compatibility modification is supplied as [svn-client-first.patch](resources/native-patches/svn-client-first.patch); upstream authentication and greeting handling remain intact.

Subversion 及原生依赖保留原始 LICENSE、NOTICE；其中包含内嵌 LZ4、utf8proc、Unicode 等组件的声明。运行时清单保存源码地址与校验值，本地 TCP 兼容补丁随源码提供。

| Component / 组件 | Version / 版本 | Original texts / 原文 |
| --- | --- | --- |
${nativeRows.join('\n')}

## Adapted UI and distribution / 改编界面与分发

The UI controls in src/renderer/src/components/ui/ adapt shadcn/ui patterns. Its [MIT license](resources/licenses/upstream/shadcn-ui.txt), Copyright (c) 2023 shadcn, is retained. Lucide includes both ISC notices and MIT notices for Feather-derived portions. Missing npm license files use reviewed upstream texts recorded in [sources.json](resources/licenses/upstream/sources.json); no copyright year is inferred for lazy-val.

界面控件保留 shadcn/ui 的 MIT 许可，Lucide 保留 ISC 与源自 Feather 部分的 MIT 声明。未随 npm 包附带的许可由已核对的上游文本补齐，来源记录在 sources.json 中。

File and folder icons and associations in src/renderer/src/assets/file-icons/symbols/ come from [Symbols](https://github.com/miguelsolorio/vscode-symbols/tree/2c95b15b0a8ef95ac62855e3784a6024ee6e5d2e), Copyright (c) 2020-22 Miguel Solorio. Its original [MIT license](resources/licenses/upstream/symbols-icons.txt) is retained. SVG artwork is unmodified; association JSON is formatted, and svnbox supplies the resolver and symbolic-link overlay composition.

文件、文件夹图标及关联规则来自 Symbols，保留 Miguel Solorio 的原始著作权及 MIT 许可全文。SVG 图形保持原样，关联 JSON 仅调整格式，仓盒提供文件类型解析及符号链接叠层组合。

svnbox's original code, documentation and artwork use the root [LICENSE](LICENSE). The Electron SVNBox project supplies the original frontend and artwork; the Tauri Diffolio project is the native migration reference. No third-party project endorses this application. External SVN and merge tools selected by the user retain their own licenses and are not redistributed by this project.

仓盒原创代码、文档与图形适用根目录 LICENSE。原有界面与图形来自 Electron 版 SVNBox，原生迁移参考 Tauri 版 Diffolio。用户自行指定的外部 SVN 或合并工具由各自提供方授权，本项目不重新分发。

Application bundles retain LICENSE, this notice and resources/licenses/ under 仓盒.app/Contents/Resources/ with the same relative layout. Original SVN runtime notices are also retained under Contents/Resources/svn/licenses/.
`;
await include('THIRD_PARTY_NOTICES.md', Buffer.from(contents));
for (const group of ['npm', 'rust']) {
	const directory = join(root, 'resources/licenses', group);
	await mkdir(directory, { recursive: true });
	for (const filename of await readdir(directory)) {
		const path = `resources/licenses/${group}/${filename}`;
		if (!expected.has(path)) {
			assert.ok(!check, `${path} is obsolete; run npm run licenses:generate.`);
			await rm(join(root, path));
		}
	}
}
console.log(`${check ? 'Verified' : 'Generated'} notices for ${rows.length} npm packages and ${rustRows.length} Rust crates.`);
