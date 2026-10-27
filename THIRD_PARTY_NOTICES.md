# 第三方声明 / Third-party notices

仓盒包含下列第三方软件和资源。各组件的著作权归原权利人所有，并继续适用其各自的许可证。仓盒 [LICENSE](LICENSE) 中的销售限制仅适用于仓盒受该协议约束的内容，不限制独立使用或分发这些第三方组件时由其原许可证授予的权利。

svnbox includes the third-party software and resources below. Copyright remains with the respective owners, and each component retains its own license. The sales restriction in the svnbox [LICENSE](LICENSE) applies only to material covered by that license; it does not restrict rights granted by third-party licenses when those components are used or distributed independently.

## 组件与许可证 / Components and licenses

| 组件 / Component                                      | 用途 / Purpose                                           | 许可证 / License                                                             | 上游 / Upstream                                                                                                                       |
| ----------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Electron 45.0.0                                       | 桌面运行时 / Desktop runtime                             | MIT; included projects retain their own licenses                             | [Electron](https://github.com/electron/electron)                                                                                      |
| Chromium, Node.js and Electron's bundled dependencies | Electron 内置组件 / Components supplied by Electron      | Multiple upstream licenses                                                   | [Electron](https://github.com/electron/electron)                                                                                      |
| React, React DOM, Scheduler                           | 用户界面 / User interface                                | MIT                                                                          | [React](https://github.com/facebook/react)                                                                                            |
| Radix UI, Floating UI                                 | 无障碍控件和浮层 / Accessible controls and positioning   | MIT                                                                          | [Radix](https://github.com/radix-ui/primitives), [Floating UI](https://github.com/floating-ui/floating-ui)                            |
| TanStack Query, TanStack Virtual                      | 查询和列表 / Queries and lists                           | MIT                                                                          | [TanStack](https://github.com/TanStack)                                                                                               |
| shadcn/ui                                             | 适配的界面组件 / Adapted UI components                   | MIT                                                                          | [shadcn/ui](https://github.com/shadcn-ui/ui)                                                                                          |
| Tailwind CSS, tailwind-merge                          | 样式 / Styling                                           | MIT                                                                          | [Tailwind CSS](https://github.com/tailwindlabs/tailwindcss), [tailwind-merge](https://github.com/dcastil/tailwind-merge)              |
| Lucide React; Feather-derived portions                | 图标 / Icons                                             | ISC; MIT for Feather-derived portions                                        | [Lucide](https://github.com/lucide-icons/lucide)                                                                                      |
| class-variance-authority                              | 控件样式变体 / Component variants                        | Apache-2.0                                                                   | [cva](https://github.com/joe-bell/cva)                                                                                                |
| clsx, cmdk, Sonner                                    | 界面工具 / UI utilities                                  | MIT                                                                          | [clsx](https://github.com/lukeed/clsx), [cmdk](https://github.com/pacocoursey/cmdk), [Sonner](https://github.com/emilkowalski/sonner) |
| Zustand, Zod                                          | 状态和校验 / State and validation                        | MIT                                                                          | [Zustand](https://github.com/pmndrs/zustand), [Zod](https://github.com/colinhacks/zod)                                                |
| i18next, react-i18next                                | 国际化 / Localization                                    | MIT                                                                          | [i18next](https://github.com/i18next/i18next), [react-i18next](https://github.com/i18next/react-i18next)                              |
| electron-updater and its dependencies                 | 应用更新 / Application updates                           | MIT and dependencies' own licenses                                           | [electron-builder](https://github.com/electron-userland/electron-builder)                                                             |
| fast-xml-parser and its dependencies                  | SVN XML 解析 / SVN XML parsing                           | MIT and dependencies' own licenses                                           | [fast-xml-parser](https://github.com/NaturalIntelligence/fast-xml-parser)                                                             |
| Apache Subversion 1.15.0                              | 内置 SVN 客户端 / Bundled SVN client                     | Apache-2.0 and notices for included code                                     | [Subversion](https://subversion.apache.org/)                                                                                          |
| Apache Portable Runtime 1.7.6; APR-util 1.6.5         | SVN 运行库 / SVN runtime libraries                       | Apache-2.0 and notices for included code                                     | [APR](https://apr.apache.org/)                                                                                                        |
| Apache Serf 1.3.10                                    | SVN HTTP 通信 / SVN HTTP transport                       | Apache-2.0                                                                   | [Serf](https://serf.apache.org/)                                                                                                      |
| OpenSSL 3.5.9                                         | SVN TLS 通信 / SVN TLS transport                         | Apache-2.0                                                                   | [OpenSSL](https://openssl-library.org/)                                                                                               |
| LZ4 and utf8proc embedded in Subversion               | 压缩和 Unicode 处理 / Compression and Unicode processing | BSD-2-Clause; MIT and Unicode notices, as reproduced in Subversion's LICENSE | [Subversion source](https://svn.apache.org/repos/asf/subversion/trunk/subversion/libsvn_subr/)                                        |

上表是主要组件概览。[THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt) 收录锁定依赖的名称、版本、许可证原文、著作权和上游 NOTICE，包括表中未逐项列出的传递依赖；也包含构建环境中存在的可选对等依赖和 Tailwind 样式来源，不表示这些包的全部内容均随应用分发。纯开发工具若未分发，其许可随各工具提供。

The table summarizes the main components. [THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt) contains locked dependency names, versions, full license texts, copyright notices and upstream NOTICE files, including transitive dependencies not individually listed above. It also includes optional peer dependencies present in the build environment and Tailwind styling sources; listing a package does not imply that all of its files are distributed. Development-only tools that are not distributed retain the licenses provided with those tools.

## 安装包中的声明 / Notices in application bundles

macOS 应用内保留以下文件，可在 Finder 中对应用选择“显示包内容”后查看：

The following files are preserved inside the macOS application, accessible through Finder's **Show Package Contents**:

- `Contents/Resources/LICENSE` — 仓盒自身许可 / svnbox's own license.
- `Contents/Resources/THIRD_PARTY_NOTICES.md` and `THIRD_PARTY_LICENSES.txt` — 本声明及第三方许可证全文 / This notice and full third-party license texts.
- `Contents/Resources/LICENSE.electron.txt` and `LICENSES.chromium.html` — Electron 随附的许可与 Chromium、Node.js 等组件声明 / Electron's supplied license and notices for Chromium, Node.js and other bundled components.
- `Contents/Resources/svn/licenses/` — SVN 及原生依赖的原始 LICENSE、NOTICE / Original LICENSE and NOTICE files for SVN and its native dependencies.
- `Contents/Resources/svn/manifest.json` and `svn-client-first.patch` — 固定版本、源码下载地址、校验值与本项目补丁 / Pinned versions, source download locations, checksums and this project's patch.

macOS 系统库和用户自行配置的外部 SVN、比较或合并工具由其提供方授权，本项目不重新分发或重新授权这些工具。Apple、macOS、Subversion 等名称和标识的权利归各自权利人所有；本声明不表示其为仓盒背书。

macOS system libraries and externally configured SVN, comparison or merge tools are licensed by their providers; svnbox does not redistribute or relicense those tools. Names and marks such as Apple, macOS and Subversion belong to their respective owners. Their inclusion here does not imply endorsement of svnbox.

## 维护声明 / Maintaining notices

安装锁定依赖并构建 SVN 运行时后，运行 `npm run licenses:build` 更新许可证汇总。脚本从实际安装的包及内置 SVN 运行时读取原文，使用 `licenses/upstream/` 补齐未随 npm 包发布的许可证。新增或升级依赖时应一并检查、更新并提交声明。打包命令与正式发布流程均会重新生成汇总。

After installing locked dependencies and building the SVN runtime, run `npm run licenses:build` to refresh the license bundle. The script reads notices from installed packages and the bundled SVN runtime, using `licenses/upstream/` for license texts omitted from npm packages. Review, update and commit notices when adding or upgrading dependencies. Packaging commands and the release pipeline regenerate the bundle.
