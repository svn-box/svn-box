# svnbox · 仓盒

面向 macOS 的本地 SVN 图形客户端。Electron + React + TypeScript + Vite + Tailwind CSS，组件以 shadcn/ui 的 Button、Dialog、DropdownMenu、Combobox、Select 与 Sonner 结构及 Radix 为基础。

首版已接入真实 SVN，无默认演示数据。建议先添加自己的已有工作副本，或通过“仓库浏览与检出”获取一份新副本。

## 安装与启动

Apple Silicon 构建产物：

- `release/svnbox-0.1.0-arm64.dmg`：拖动“仓盒”到 Applications。
- `release/svnbox-0.1.0-arm64.zip`：压缩的应用程序。
- `release/mac-arm64/仓盒.app`：可直接启动。

**发行状态：本地预览版，未使用 Developer ID 签名、未公证。** macOS 可能要求通过“隐私与安全性”允许打开。尚未构建或验证 Intel 安装包。

应用附带 Apache Subversion 1.15.0 和所需动态库，默认使用内置版本，无需安装 Homebrew SVN。内置运行时对等待客户端首字节的 TCP 转发器作连接兼容处理；保留原来的地址、仓库 UUID 和认证流程，不修改代理、路由或工作副本 URL。也可在设置中指定其他 SVN 1.10+ 的绝对路径；自定义工具使用其自身连接行为。

## 开发与验证

本次验证环境：Apple Silicon、macOS 27.0.1、Node 26.12.1、npm 11.20.0。锁文件固定本次使用的版本：Electron 45.0.0、React 19.3.1、TypeScript 7.0.2、Vite 8.3.5、electron-vite 6.0.0、Tailwind CSS 4.3.3。

渲染进程使用 TanStack Query 5.104.5 管理异步查询，Zustand 5.0.16 管理工作副本会话。

```sh
npm ci
npm run svn:build       # 从固定版本、校验 SHA-256 的开源源码构建内置 SVN（首次需要几分钟）
npm run dev             # Electron + Vite 热更新
npm run typecheck       # 主进程、preload、共享协议与 React 类型检查
npm test                # 临时仓库的真实集成/边界测试及 Diff 解析测试
npm run test:e2e        # 构建并运行真实 Electron 界面测试
npm run build           # 输出 out/
npm start               # 启动构建后的应用
npm run icons:build     # 用用户原图生成原生外观与兼容 ICNS
npm run themes:build    # 从 src/shared/themes.ts 生成完整主题 CSS（build/dev/test 自动调用）
npm run package:dir     # 生成 arm64 .app
npm run package:mac     # 生成 arm64 .app、DMG 与 ZIP
npm run format          # 使用项目 Prettier 配置格式化
```

构建内置 SVN 需要 Xcode Command Line Tools、`scons` 和 `pkg-config`（可通过 `brew install scons pkgconf` 安装）。APR、APR-util、OpenSSL 及 Serf 自动从固定源码版本构建，缓存位于 `.cache/svn-runtime/`，发行版没有 Homebrew 动态库依赖；源码出处、校验值和许可证随 App 的 `Contents/Resources/svn/` 一起保存。

测试使用独立系统临时目录、`svnadmin`、两个以上工作副本和本地 `svnserve`；结束自动清理，不会选择现有业务仓库写入。测试服务器工具来自本机 Homebrew 的 `/opt/homebrew/bin/`，应用默认使用自己的 SVN。UI 测试截图保存于 `test-results/`。

对最终安装包运行同一组界面测试：

```sh
SVNBOX_PACKAGED_APP="$PWD/release/mac-arm64/仓盒.app/Contents/MacOS/仓盒" node scripts/e2e.mjs
# 同时验证原生 FileMerge 窗口（需要 Xcode）
SVNBOX_TEST_FILEMERGE=1 SVNBOX_PACKAGED_APP="$PWD/release/mac-arm64/仓盒.app/Contents/MacOS/仓盒" node scripts/e2e.mjs
```

连接认证的真实桌面测试（本地 svnserve，使用打包版）：

```sh
SVNBOX_PACKAGED_APP="$PWD/release/mac-arm64/仓盒.app/Contents/MacOS/仓盒" node scripts/e2e-auth.mjs
# 将整个认证界面测试放在等待客户端首字节的转发器后运行
SVNBOX_TEST_LAZY_FORWARDER=1 SVNBOX_PACKAGED_APP="$PWD/release/mac-arm64/仓盒.app/Contents/MacOS/仓盒" node scripts/e2e-auth.mjs
```

首次使用系统安全存储时，macOS 可能要求授权应用访问钥匙串；在系统弹窗中完成即可。不要把系统登录密码填写到 SVN 认证表单。

文件树布局验证（真实 14 层路径、500 文件，截图保存在 test-results/）：

```sh
SVNBOX_PACKAGED_APP="$PWD/release/mac-arm64/仓盒.app/Contents/MacOS/仓盒" node scripts/e2e-files.mjs
# 历史时间线、分页、600 路径、提交内 Diff、停止读取及会话恢复
SVNBOX_PACKAGED_APP="$PWD/release/mac-arm64/仓盒.app/Contents/MacOS/仓盒" node scripts/e2e-history.mjs
# 侧栏右键、键盘菜单、焦点和满宽选中验证
SVNBOX_PACKAGED_APP="$PWD/release/mac-arm64/仓盒.app/Contents/MacOS/仓盒" node scripts/e2e-navigation-menu.mjs
# 更新即时反馈、慢扫描期间连续点击/快捷键防重及失败后重试
SVNBOX_PACKAGED_APP="$PWD/release/mac-arm64/仓盒.app/Contents/MacOS/仓盒" node scripts/e2e-update-feedback.mjs
# 设置分页、工具校验、分页输入保留与重启恢复
SVNBOX_PACKAGED_APP="$PWD/release/mac-arm64/仓盒.app/Contents/MacOS/仓盒" node scripts/e2e-settings.mjs
# 六套配色、原生明暗外观、系统切换隔离、真实文件/Diff/菜单与主题恢复
SVNBOX_PACKAGED_APP="$PWD/release/mac-arm64/仓盒.app/Contents/MacOS/仓盒" node scripts/e2e-themes.mjs
# 操作日志：真实4000文件更新、筛选/复制、取消、按范围清空与重启恢复
SVNBOX_PACKAGED_APP="$PWD/release/mac-arm64/仓盒.app/Contents/MacOS/仓盒" node scripts/e2e-operations.mjs
```

## 已实现

- macOS 经典分栏外观：顶部文件/历史分段控件、系统侧栏材质、统一浅深色、紧凑文件树、独立检查器与任务弹窗；扫描时间位于状态栏，文件状态使用 shadcn Combobox 筛选。减少透明度及增强对比度时使用实色表面。
- 多仓库与多副本：真实根目录和 UUID 识别、仓库关联、分组、收藏、搜索、排序；移除记录不删除文件。
- 独立会话：草稿、选择、筛选、展开目录、当前文件、历史路径及版本；重启恢复，刷新后核对文件选择。
- 紧凑文件树：26px 行高、16px 固定缩进、类型图标、独立展开箭头、稳定交替底色、深层横向滚动和表头同步。
- 状态与文件：XML 状态、内容/属性区分、移动/复制/缺失、忽略、冲突；本地扫描时间与数量。
- 差异：内置预览及系统 FileMerge（需安装 Xcode）；本地文本和属性、指定提交差异、统一/并排、行号、变更段跳转；Worker 解析和虚拟行。
- 提交：逐文件范围、近期说明、实际路径审阅、明确新增父目录/结构目录/移动两端；执行前状态和内容校验；失败保留草稿。
- 更新、添加、重命名/移动、删除、忽略、还原、清理；危险操作明确列出影响并在界面确认。
- 点击更新立即显示准备提示并禁用重复触发，扫描和连接检查也在保护范围内；点击和 ⌘U 共用按副本隔离的准备锁。准备、执行、结果更新同一条 toast，准备失败或取消认证后恢复操作入口。
- 设置分为「通用设置」「工具」：外观提供白色、灰色、墨蓝、松绿、茄紫、铜橙六套完整配色，缩略卡片预览并即时保存；采用浓色导航、暖纸工作区与黄铜强调色，导航和内容分别校验文字/控件对比度；已移除跟随系统，旧配置加载为白色；工具页检测 SVN、配置外部合并工具，切换分页保留未保存输入。语言入口目前仅显示简体中文，多语言尚未接入。
- 仓库树统一组织远端路径与本地副本；精确路径书签支持重命名、排序和重启恢复。远端 list 分层浏览，选择 URL 和深度检出，拒绝覆盖已有目标，成功自动加入管理。
- 仓库/文件/目录历史：按日期分组的可折叠时间线，提交内展开路径及统一/并排 Diff；逐路径查看或通过 FileMerge 比较。50 条一页，分页追加合并日期组，明确区分已加载筛选与服务器查询。历史筛选、折叠和预览按副本保存并在重启后恢复。
- 文本/属性/树冲突识别与详情，外部工具入口、刷新检查、明确接受工作文件后标记解决。
- 操作日志：紧凑记录表格与独立输出详情，按状态/项目筛选、搜索原始输出、键盘导航和右键复制；输出行虚拟化、行号、自动跟随及完整复制。清空需确认当前筛选范围内的已结束记录，保留进行中任务和确认后新增的日志，清空结果重启后仍生效。
- 后台操作队列、实际输出、取消、部分成功提示、错误分型与待核实结果；其他副本仍可查看。
- 连接认证：左侧连接身份、右侧登录表单的分栏布局；认证范围按需展开，使用无搜索的 shadcn Select。没有已保存认证时，在连接前弹窗，也可明确选择使用已有 SVN 认证缓存。连接登录时用户名已知则聚焦密码框，服务器拒绝后不回填错误密码。从连接菜单编辑时，已有密码通过受限 IPC 载入当前 password 表单，可修改并保存；取消不修改原认证。编辑保存仅更新本机配置，连接登录保存后继续原请求；服务器无响应不会阻塞本机保存。同一连接根的子路径复用，协议/主机/端口隔离，可限定仓库或路径。支持 URL 中的用户名，不接受 URL 密码。连接中可停止或修改认证，关闭浏览窗口会终止旧请求；全局设置不保存密码。
- Finder 显示、复制绝对路径、打开终端；六套固定配色主题。侧栏仓库、副本、收藏、路径和分组使用右键管理菜单，支持菜单键和 Shift+F10；满宽选中背景、无子项连接线。
- 安全 IPC、沙箱渲染、连接根范围内的加密凭据、日志脱敏、受限路径、external 和嵌套副本边界。

## 状态与模块边界

| 模块                           | 职责                                                                          |
| ------------------------------ | ----------------------------------------------------------------------------- |
| `src/main/`                    | SVN 子进程、写队列、受控读取并发、凭据与磁盘持久化                            |
| `src/preload/`、`src/shared/`  | 受限的类型化 IPC、输入校验、共享领域类型                                      |
| `src/renderer/src/queries/`    | 状态、属性、信息、Diff、远端目录缓存与历史分页，操作事件订阅                  |
| `src/renderer/src/state/`      | 按副本隔离的草稿、选择、筛选、展开目录、历史上下文和共享面板状态              |
| `src/renderer/src/components/` | 导航、文件、历史、详情、提交与操作记录面板；弹窗输入等使用组件本地状态        |
| `src/renderer/src/styles/`     | 由共享主题定义生成的设计变量、macOS 控件与表面样式；基础布局位于 `styles.css` |
| `src/renderer/src/App.tsx`     | 应用壳、菜单与操作审阅流程                                                    |

查询键包含工作副本、路径和读取模式；历史 Diff 带修订号，本地 Diff 和文件信息带扫描代次。历史分页使用 `useInfiniteQuery`，游标为上一页最小修订号减一。缓存只存在内存中，默认保留五分钟；重新挂载时复用新鲜数据，失效数据重新读取。不自动重试、聚焦刷新或联网刷新，IPC 查询在离线状态也能执行。Query 的 `AbortSignal` 通过请求 ID 接到主进程取消机制。

写操作的完成以主进程 `Operation` 终态为准。收到任务 ID 只表示进入队列。写操作结束后刷新目标副本的本地状态，使其预览缓存失效；成功后才使历史缓存失效。其他副本的缓存和会话保持独立。“刷新并核实历史”会明确使历史缓存失效并重新查询服务器。

会话通过 IPC 立即保存，由主进程统一写入磁盘；没有额外的 localStorage 持久化。审阅提交前等待会话保存，重启后的文件选择依据真实状态重新校验。提交成功只清理本次提交对应的草稿与选择，提交期间继续编辑的新草稿保留。组件通过细粒度 selector 订阅会话，完整命令日志只在操作面板打开时订阅。

## 常用键盘操作

| 操作                            | 快捷键                                     |
| ------------------------------- | ------------------------------------------ |
| 添加已有工作副本                | ⌘O                                         |
| 浏览与检出                      | ⌘⇧O                                        |
| 本地刷新 / 更新                 | ⌘R / ⌘U                                    |
| 变更 / 文件 / 历史              | ⌘1 / ⌘2 / ⌘3                               |
| 提交 / 操作记录 / 设置          | ⌘↵ / ⌘J / ⌘,                               |
| 文件和历史列表浏览              | ↑↓、Home、End                              |
| 文件差异预览开关 / 目录展开收起 | 空格 / →←                                  |
| 历史日期与提交折叠 / 激活当前项 | ←→ / Enter 或空格                          |
| 文件或侧栏导航项右键菜单        | Shift+F10 或菜单键                         |
| 调整侧栏宽度                    | 聚焦分隔条后 ←/→；Home/End 到最小/最大宽度 |

## 已知限制

- FileMerge 支持普通 UTF-8 文本的 BASE/工作文件及指定提交前后比较；快照只读，启动时清理超过 7 天的比较缓存。属性差异仍使用内置预览。
- 首版使用外部工具打开当前冲突文件，没有自研三方合并器，也未自动组织 base/mine/theirs 参数。属性和树冲突可能仍需 SVN 命令行处理；清除标记前必须人工核实。
- 目录 external 可以单独添加管理；文件 external 在父副本中仅供查看，不参与父副本写操作。更新与检出跳过 externals。
- SVN 标记为二进制的文件不强制按文本解释。没有图片/Office 预览。路径含换行会明确拒绝。
- 历史以当前工作副本 URL 查询；可从父目录的提交记录查看已删除文件差异；直接查询已删除路径或复杂复制/重建历史时，可能仍需选择父目录。没有任意双版本比较、blame、分支合并向导或远端文件写操作。
- 并排 Diff 的极长行可能被列宽裁切，可切换统一视图横向查看。单命令最多 32 MiB 输出、Diff 预览 120000 行、一次审阅 2000 个目标。尚未做超大型仓库压力基准。
- 不自动轮询文件系统；本地更改后使用刷新。写操作始终重新检查。外部编辑器仍可能在最终校验后修改文件，无法提供跨进程文件事务锁。
- 认证已用本地 svnserve 验证。公网 HTTPS、代理、企业证书和 SSH/SASL 的组合环境尚未全面实测；证书失败会报错，不自动信任。
- 未提供自动更新、签名/公证、Intel/Windows/Linux 发行验证。没有 Finder 集成。

图标以用户提供的 `resources/icon.png` 为正式素材，通过 Icon Composer 的 `.icon` 文档接入原生默认/深色/单色外观，同时保留 `.icns`。图标构建需要 Xcode / Icon Composer 27+，详见 [图标说明](docs/ICONS.md)。

详细设计见 [架构说明](docs/ARCHITECTURE.md)、[验证记录](docs/VERIFICATION.md) 、[界面复核](docs/UI-REVIEW.md) 与 [交互参考](replica/recon.md)。

## 官方资料

[Electron 安全建议](https://www.electronjs.org/docs/latest/tutorial/security)、[Electron 稳定发布](https://releases.electronjs.org/release?channel=stable)、[electron-vite](https://electron-vite.org/guide/)、[Vite](https://vite.dev/guide/)、[shadcn/Vite](https://ui.shadcn.com/docs/installation/vite)。
