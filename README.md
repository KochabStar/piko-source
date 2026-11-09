# Piko 软件源

独立于 `../piko/` 客户端项目维护的软件源目录，对应 `../piko/docs/replacement-gaps.md` 的 P0 软件源工作。

**当前共 68 个包、123 个版本**，新增 Claude Code、OpenCode、QQNT、NVIDIA App、Nushell、Lertaro、x64dbg、百度网盘、CloudDrive2、Bun、Steam、Epic 商城、Godot、Blender、RetroArch、ares、mGBA、medusa、shadPS4、VS Code，并将已有 Codex 追加至 0.166.0（见 [新增软件](#新增软件2026-10-31)、[新增逆向与云盘工具](#新增逆向与云盘工具2026-11-04)、[CloudDrive2](#clouddrive22026-11-05)、[Bun](#bun2026-11-05)、[Steam](#steam2026-11-07)、[Epic 商城](#epic-商城2026-11-07)、[Godot](#godot2026-11-07)、[Blender](#blender2026-11-07) 与 [模拟器与编辑器](#模拟器与编辑器2026-11-08)）。此前新增 Pi 1.4.0 原生 Windows x64 包（见 [Pi](#pi-原生-cli)）。原 38 包覆盖已盘点的 33 个 Scoop 迁移目标（排除管理器自身）和 5 个 mise 工具入口；本轮再登记 Orca、Tabbit、钉钉、微信、企业微信、Listary、ToDesk、向日葵共 8 包。新增 8 包均通过隔离安装、默认选择与命令入口校验，主程序版本和 Windows 签名状态检查通过；另验证两款远控软件的配置留存模型。证据见 [桌面软件验证](verification/desktop-apps-20261029.json)。原 19→38 包扩充的 30 项检查见 [历史覆盖记录](verification/coverage-20261029.json)。本页前三阶段的旧数量与待办保留为历史记录，当前范围以第四、第五阶段、Pi 原生 CLI 与新增软件章节为准。

## 目录

- `index.json`：软件、已登记版本与清单路径索引。
- `packages/<name>/package.json`：Windows x64 模板包清单；同包多个版本共用文件，版本表保存逐版本摘要与配方引用。
- 模板源需要新版客户端；原 schema 1 完整清单仍可由新版客户端读取。迁移说明见 [模板包清单](#模板包清单)。
- [TortoiseSVN 升级与 DLL 占用处理](guides/tortoise-svn.md)：版本化 Shell 配方、旧版本延后清理，以及旧 Scoop 安装的一次性撤销边界。修订 `1.15.0.29830-piko.1` 保留原载荷，后续上游更新自动继承新配方；历史阶段说明中的旧配方行为不适用于此修订。
- [向日葵快捷方式打开安装器的修复](guides/sunlogin.md)：`16.8.0.33445-piko.1` 将快捷方式及 `sunlogin`／`awesun` 命令改为提取后的 `flutter/AweSun.exe`，保留载荷及配置声明，不安装服务或驱动。
- [CloudDrive2 快捷方式打开黑窗口](guides/clouddrive2-shortcut.md)：`1.1.3.3` 改打 WinUI 桌面版（GUI 子系统 `CloudDrive.exe`），只解包捆绑链里的应用 MSI；旧服务版 `1.1.3` 保留。
- [Godot 装完没有快捷方式](guides/godot-shortcut.md)：`4.7.2-piko.1` 补上指向 GUI 主程序（非 `_console.exe`）的开始菜单入口，载荷与命令表不变；含已有安装的收据修复流程。

原始两份清单复制自客户端的 `examples/source/`：Node 26.12.1、ripgrep 15.2.0。现已增加 Lua 5.5.0、z.lua 1.8.26、Starship 1.27.0、fzf 0.74.5、PSFzf 2.7.12、sudo 0.2020.01.26、Snipaste 2.11.3；已在第六阶段加入 GitHub Actions 上游更新配置；推送并启用仓库权限后运行，正式 HTTPS 托管仍未部署。后续清单在此维护，客户端示例不自动同步。

## 模板包清单

现有 **116 份版本清单存于 68 个包文件**，保留全部已登记版本；未启用删除历史版本的保留策略。普通更新复用 URL／安装配方模板，仅在版本表追加版本、SHA-256、可选下载配额，再更新索引 `latest`。主题、持久化、Shell 和管理员配方等布局发生变化时，增加独立 recipe，避免改动旧版本含义。

- 模板文件使用 `schemaVersion: 2`；`index.json` 仍为 schema 1，各版本指向相同包文件。客户端只允许已登记并带校验值的版本，不通过拼 URL 随意安装未知版本。
- 仅替换声明式下载和路径字段中的 `{version}`，不替换配置正文、Shell／执行脚本及 `{root}`、`{persist}` 等既有占位符。多下载分别保存 SHA-256。
- 迁移逐版本核对完整展开结果及 `manifestHash`，所有历史版本与原清单完全一致；旧包文件由 Git 历史保留。更新仍下载并检查载荷摘要、大小和布局，不能仅替换 URL 就发布。
- **先升级客户端，再刷新或发布此源。** 新客户端兼容旧完整清单；旧客户端不能解析模板包。当前改动未自动替换本机 Piko。
- `npm run compact:check` 预览完整清单转换，`npm run compact` 执行无损合并；已迁移文件再次运行不产生变化。普通自动更新不会再新增同包版本文件。

## Shell 与配置支持（需要新版客户端）

- z.lua、Starship、PSFzf 在清单中提供 `shell.powershell`。客户端安装时不执行，用户在 `use` 后用 `integrate --shell pwsh --dry-run` 预览，再用 `--approve-shell --binding <真实摘要>` 接入 Profile。
- Lua 的 Tools ZIP 已含运行所需 DLL；不叠加会产生同名 DLL 的开发库 ZIP。下载 SHA-256 已重新计算，并与 Scoop 原 SHA-1 逐字节核对。
- z.lua 显式使用受管理 Lua，初始化时检测已有 `z` 避免静默覆盖。Starship 会接管所选 Shell 的提示符，应人工核对原初始化；不自动删除 Scoop／手工 Profile 内容。
- PSFzf 初始化显式导入包内模块，只在导入期间将受管理 fzf 目录置于 PATH 首部，随后还原；保留用户已有同名模块，不静默强行替换。未额外声明用户按键绑定，模块自身行为需纳入初始化审核。
- Snipaste 以持久化配置种子和 `configTemplates` 重定向配置，`history` 仍为目录；已验证包解压和布局，GUI 保存配置与重启升级行为尚未验收。
- sudo 使用 PowerShell 脚本入口，不在安装时执行，不改变执行策略。该版本实际提权／UAC 交互尚未验收。
- 隔离根目录的编译 CLI 已验证 Lua／z.lua、Starship、PSFzf 在 PowerShell 5.1／7 中初始化，`z` 实际改变当前目录，PSFzf 使用 Piko fzf。未接管本机 Scoop 或日常 Profile。
- LocalSend 的文件硬链接保存行为未验收，尚未发布清单；字体与系统集成仍属后续阶段。

## 安装载荷扩展（第二阶段）

已增加 7-Zip 26.05、LLVM 23.1.4、Beyond Compare 中文版 5.2.6.32774、Obsidian 1.14.5、Tabby 1.0.238 清单；总计 14 个软件。参考本机 Scoop 布局，但不执行其安装脚本。

- `7zip`／`llvm` 用 `msi` 只解包：lessmsi 仅查询数据库表，CAB 由固定完整 7-Zip 经标准输出提取；不调用 msiexec、安装动作或注册表。
- Beyond Compare 用确切 `files` 映射选 x64 `,2` 副本；未选文件不安装，未执行任何补丁／授权工具、Shell 扩展或 GUI。抽取成功不代替合法许可证与便携运行验收。
- Obsidian／Tabby 用 `nsis` + `nested` 选择 `$PLUGINSDIR/app-64.7z`，不执行外层 EXE，不复制用户 APPDATA／vault／登录状态。Tabby 的 `data` 目录单独持久化。
- LLVM 使用 1 GiB 下载／4 GiB 展开配额（默认仍为 512 MiB／2 GiB）；只有少量主要命令公开，`LIBCLANG_PATH`／`LLVM_LIB_DIR` 仅注入受管理程序，不注册全局环境，不自动安装 MSVC／SDK。
- 隔离实际安装已完成。7-Zip 原生命令、clang 版本输出通过；关键载荷文件摘要与同版原安装一致。GUI 使用、文件关联、快捷方式、TortoiseSVN Shell 扩展、后续配置迁移仍未验收。
- 外部 CAB／MSI 安装动作、任意 NSIS、自解压安装器执行、字体／服务／驱动等不在这次扩展中。

当前脚本与文件持久化使用 state schema >=5；桌面／引导／管理员集成使用 schema 6，不要用旧 EXE 打开升级后的状态。正式字段说明、权限风险及撤销命令见客户端 README。

## 桌面、字体和引导（第三阶段）

- 新增 `firacode-nf`、`hack-nf-mono`、`rustup`、`flclash`、`tortoise-svn`，共 19 个包。字体名单精确列出，与下载 ZIP 摘要核对；rustup 默认只引导管理器，不安装工具链或接管原 CARGO_HOME。
- 7zip／Snipaste／Obsidian／Tabby／Beyond Compare／FlClash／TortoiseSVN 提供当前用户快捷方式声明；LLVM 提供显式用户环境和 PATH；7zip 提供独立右键命令，Obsidian 提供 `.md` Open With，不强抢默认应用。
- 安装不执行外部集成。`integrate --desktop --dry-run` 预览后用 `--yes --binding` 应用；`bootstrap` 用独立 `--approve-exec`，`system` 用独立 `--approve-admin` 且必须自行提升终端。不降低执行策略，不自动装驱动／重启系统。
- 真实字体的复制、专用 HKCU 测试注册和临时 GDI 加载／卸载通过；真实 rustup 在临时根目录引导及 shim 版本运行通过；TortoiseSVN 本体解包和 svn 命令通过。
- FlClash 服务与 TortoiseSVN COM／overlay 提供源侧拥有记录、冲突拒绝与撤销配方。未在宿主执行提升权限步骤，尚不能视为实际服务／Shell 扩展／TUN 工作流已验收。
- 配方不接管本机 Scoop 的同名服务或注册值，需先由原安装方撤销。LocalSend 保存行为、Snipaste GUI 保存、sudo UAC、其他本机安装软件及 Appx 完整迁移仍待独立验收。

## 本机清单补齐（第四阶段）

新增版本按本机当前使用版本固定，不把 `latest` 解释成自动发现上游新版：

| 分类                 | 新增包与版本                                                                     |
| -------------------- | -------------------------------------------------------------------------------- |
| 开发／构建           | git 2.56.0.4、gh 2.103.3、lazygit 0.66.2、cmake 4.4.5、ninja 1.13.2、xmake 3.1.2 |
| 下载／媒体／安装工具 | aria2 1.37.0-1、ffmpeg 9.0.2、inno-setup 7.1.0、innounp 2.71.2                   |
| 桌面软件             | dbgate 7.3.2、localsend 1.18.2、sublime-text 4-4215、wave-terminal 0.14.5        |
| 运行时／CLI          | go 1.27.3、uv 0.13.5、pixi 0.83.0、oh-my-pi 18.13.2、codex 0.164.0               |

- 使用官方发布资源和 SHA-256。GitHub 提供摘要时逐项比对，其他分发重新从官方 HTTPS 下载核对。lazygit 使用发布页的确切小写 windows 文件名；LocalSend 同版本资源与旧本机缓存不同，采用当前官方摘要重新下载，不沿用旧缓存。
- PortableGit 直接解出完整载荷，不执行自解压 EXE 或 post-install.bat；Git 配置仍按上游原生用户位置保存，不复制旧 Scoop 版本目录。gh／lazygit 声明对受管理 Git 默认命令的依赖。
- LocalSend 使用 settings.json 硬链接持久化。上游 v1.18.2 的写入实现为原文件写入；本轮验证了同类写入的文件身份、卸载／重装保留。应用若改为原子替换，客户端仍检测分叉并拒绝破坏性操作。**本轮没有启动 GUI，实际设置页面保存仍需验收。**
- Sublime Text 持久化 Data；uv 的缓存、Python 与工具目录、pixi 的 home 保存在各自 persist。不自动迁移旧用户数据、环境或凭据。DbGate／Wave 沿用其原生用户配置路径，Piko 不拥有这些外部数据。
- xmake 提供 xmake 和保留退出码的 xrepo PowerShell 子进程入口；需要改变当前 Shell 的 xrepo env shell／quit 仍须上游当前会话 hook，子进程入口对此明确拒绝。
- codex 使用官方完整 Windows 原生包，保留 bin、codex-resources、codex-path 等完整布局；不是只复制一个 EXE。它对应本机原 npm:@openai/codex 的 CLI，可选择原生安装或 npm 安装，但同名命令不能同时归属两个包。未登录、未调用模型、未安装管理员 sandbox 服务。
- 普通安装不选默认；用户桌面环境、快捷方式和右键菜单仍需单独 integrate 预览／确认，不从 Scoop 清单执行安装脚本。
- 隔离验证包含 Git init/status、CMake＋Ninja 自定义目标、Go 编译运行、FFmpeg 生成音频、Codex 版本／帮助和 LocalSend 数据保留。GUI／真实管理员服务与数据迁移不据此视为完成。

验证使用本轮新版客户端。为大型 solid 归档复用有界 stdout 批处理，保留路径、类型、配额和精确输出长度校验；旧版逐文件解压 PortableGit 很慢，建议先更新客户端。第六阶段已补齐独立的上游更新流水线配置，正式 HTTPS 托管仍需单独部署。

## 额外桌面软件（第五阶段）

| 包名     | 清单版本        | 命令／入口                                             |
| -------- | --------------- | ------------------------------------------------------ |
| orca     | 1.4.243         | `orca` 指向官方原生 CLI；`orca-gui` 和快捷方式启动 GUI |
| tabbit   | 1.19.25.0       | `tabbit`                                               |
| dingtalk | 8.2.5.260113006 | `dingtalk`                                             |
| wechat   | 4.2.0.9         | `wechat`、`weixin`                                     |
| wecom    | 5.0.13.6005     | `wecom`、`wxwork`                                      |
| listary  | 6.3.5.94        | `listary`                                              |
| todesk   | 4.9.8.0         | `todesk`                                               |
| sunlogin | 16.8.0.33445-piko.1 | `sunlogin`、`awesun`（`flutter/AweSun.exe`）         |

- 全部使用官方分发站点或官方发布仓库的载荷，并固定 SHA-256。Orca 对照发布资源的官方 SHA-256；向日葵另比对官方 API 的 MD5，最终仍以 SHA-256 作为 Piko 校验值。其他载荷由官方 HTTPS 获取并独立计算摘要；提取后的 8 款主程序均检查 Windows 签名状态为 Valid。
- 优先匹配实际程序版本，不能只信卸载注册表：Listary 真实版本为完整四段版本，钉钉原注册表版本落后于其实际程序。微信、向日葵旧版官方载荷无法可靠获取，本次固定可核验的官方新版；添加清单不会升级既有安装。
- Orca 仅提取明确的 NSIS 内层包，保留完整资源布局；CLI 使用 `resources/bin/orca.exe`，避免误把 GUI 当 CLI。Tabbit 依次选择 `updater.7z`、精确 GUID 路径的 `mini_installer.exe`、`chrome.7z`，最终只发布 `Chrome-bin` 应用布局，不执行更新器或安装器。
- 钉钉使用官方完整 updater ZIP 的程序载荷，不运行 updater、提权助手或安装动作。企业微信以 NSIS `files` 精确声明程序文件，排除安装插件和卸载器；微信只提取明确的 `install.7z`。不自动注册应用协议、微盘驱动或其他系统集成。
- Listary 使用 Inno 只解包。ToDesk 只选择 `app64.7z`。向日葵以 `pe` 精确提取 `.rsrc/2052/SUN_SKIN/111` 中的 ZIP 资源。原清单误将外层 `AweSun.exe` 安装器作为入口；修订 `16.8.0.33445-piko.1` 将快捷方式及两条命令改为 `flutter/AweSun.exe`，外层文件仅保留为原始载荷／辅助程序，不自动执行其安装／服务逻辑。历史载荷／签名检查不代表启动入口正确。
- ToDesk／向日葵的 `config.ini` 使用硬链接持久化，日志与声明的数据目录独立保留。已验证模拟原位写入、文件身份及卸载／重装保留；真实 GUI 保存、原子替换行为、设备身份迁移和跨版本兼容仍未认证，分叉时客户端继续拒绝破坏性操作。其他程序沿用原生用户数据位置，不自动复制聊天记录、浏览器资料、账户或凭据。
- 所有快捷方式仍需单独 `integrate --desktop` 预览与确认；不改默认浏览器，不创建远控服务、无人值守、启动项、虚拟屏／音频／USB 驱动。本轮没有启动 GUI 或接管现有服务，后续真实业务与系统集成验收须分别进行。
- 需要本轮新版客户端，尤其是企业微信的显式 NSIS 文件映射、Tabbit 的大中间层和向日葵的 PE 资源选择。中间层最多 2 GiB 且计入共享预算，最终应用文件仍限 512 MiB；源清单使用有上限的 4 GiB 展开预算。
- 初次在活动工作区内验证 Orca 时遇到 Windows EPERM 目录发布错误，未视为通过；保留失败现场后，在独立临时根完成全部验证。验证脚本只为元数据读取显式导入 Windows PowerShell 自身的 Security 模块，没有修改宿主模块配置，也没有管理或安装 PowerShell。

客户端最终全量回归 **165 项测试、1,660 次断言、0 失败**，类型、构建、格式、示例源及本源 46 包校验通过；构建与清单摘要记录在 `../piko/docs/verification/desktop-apps-20261029.json`。

PowerShell 7 不在本轮管理范围；WPS Office、安妮Office、Perplexity 未加入。上游版本发现已由下节的独立源流水线配置覆盖；应用自更新器和跨版本数据迁移未据此认证。

## Pi 原生 CLI

- 新增 `pi` **1.4.0**，来自官方 `earendil-works/pi` 的 `pi-windows-x64.zip`；SHA-256 与发布资源摘要及 `SHA256SUMS` 核对。完整保留主题、WASM、Windows 原生辅助模块、文档与示例，不只复制 `pi.exe`。
- 使用独立原生发行包，无需 Node/npm，不执行官方安装脚本。`pi` 与 `oh-my-pi`（`omp`）是不同包；若已有 npm 安装提供 `pi` 命令，须先显式处理命令归属，不静默覆盖。
- 配置、凭据、会话和扩展沿用 Pi 原生用户目录 `~/.pi/agent/`；不复制、迁移或接管现有数据，不在清单中强制改写该目录。Windows Bash 工具需要 Git Bash 或自行配置 `shellPath`，本包不修改 PATH、PowerShell Profile 或用户 Shell 配置。
- 自动更新仅匹配官方稳定版的 Windows x64 ZIP，并检查主题、WASM 和原生模块等必要资源。通过 Piko 管理版本，不运行官方安装器或自更新流程。
- 隔离验证通过官方双重摘要、211 个文件的布局校验、Piko 安装后不选默认、`use @latest`、原生及 shim 的版本／帮助输出。未启动交互会话、登录或调用模型；既有外部 Pi 启动器保持不变。证据见 [Pi 验证记录](verification/pi-20261031.json)。

已有 `main` 源时：

```sh
piko source refresh main
piko install main/pi@1.4.0
piko use main/pi@latest
piko which pi
pi --version
```

若已有独立安装的 Pi，先用 `Get-Command -All pi` 检查 PATH 遮蔽；`piko which pi` 显示受管理入口，不代表当前 Shell 已优先使用该入口。本清单不删除旧启动器、不自动调整宿主 PATH。

## 新增软件（2026-10-31）

| 包名 | 版本 | 入口 |
| --- | --- | --- |
| `claude-code` | 2.1.316 | `claude`，官方 Windows 原生单文件，无需 npm |
| `opencode` | 1.19.5 | `opencode`，官方 x64 baseline ZIP，避免强制 AVX2 |
| `codex` | 0.166.0 | `codex`，保留完整原生包与旧版 0.164.0 |
| `qqnt` | 9.9.36.53644 | `qq`、`qqnt`，仅提取 PE 中明确的应用 7z 载荷 |
| `nvidia-app` | 11.0.9.565 | **仅 `nvidia-app-setup` 官方安装器入口，非便携应用** |
| `nushell` | 0.116.1 | `nu`，保留官方插件与 less，但不抢占 `less` 命令 |
| `lertaro` | 5.12.2 | `lertaro`、`lff`，官方便携 ZIP，持久化 `Data` |

- 已从官方渠道实际下载七个载荷并计算 SHA-256；Claude Code 对照官方版本清单，GitHub 发布包对照官方资源摘要，QQNT／NVIDIA 安装器校验 Windows Authenticode 为 `Valid`。布局检查覆盖所有命令、快捷方式及必要资源。七项隔离安装、命令选择及入口解析通过，四款 CLI 的原生和 shim 版本输出通过；Lertaro 的持久化目录在卸载／重装后保留测试数据。源检查、历史清单保护、106 项回归测试通过；证据见 [新增软件验证](verification/software-additions-20261031.json)。尚未据此认证 GUI、模型登录、服务／驱动安装或真实用户数据迁移。
- Claude Code 设置进程环境 `DISABLE_UPDATES=1`，OpenCode 设置 `OPENCODE_DISABLE_AUTOUPDATE=1`，由 Piko 管理版本；不改写已有配置、会话或凭据。Claude Code 的 Bash 功能仍需 Git Bash，不自动更改宿主 PATH／Profile。
- QQNT 已追加 **9.9.36.53644**，保留 9.9.33.52230。**先升级 Piko 至 0.4.1**：客户端和源更新器在下载前调用官网免登录 `GetSign`，签名仅留内存，清单／状态仍保存固定无签名资源身份和 SHA-256；支持内置及 aria2 分段，不采用第三方中转。空缓存真实安装、摘要、完整资源布局与命令解析通过，未启动 GUI、注册扩展／服务或迁移账户数据。见 [实现与升级顺序](guides/qqnt.md)、[原生安装证据](verification/qqnt-native-install-20261102.json)。
- NVIDIA App 依赖系统安装与配套组件。此包只下载、校验、保存官方完整安装器；`piko install` 不安装系统应用，`nvidia-app-setup` 仅在用户主动调用时打开安装向导。没有 `nvidia-app` 伪便携入口、自动 UAC、管理员配方、服务／驱动／启动项操作；Piko 卸载此包也不会撤销用户另行完成的 NVIDIA 系统安装。
- Lertaro 需要外部 **x64 .NET 10 Desktop Runtime**，本包不自动安装运行库，也不运行随包安装脚本。`Data` 在首次启动前由 Piko 持久化创建，避免便携程序自动沿用既有系统安装的数据。**上游 GUI 首次启动可能请求 UAC、注册或重装 `Lertaro.Service`；便携不等于无系统副作用。** 此源不自动注册服务，不启动 GUI、不接管现有服务；使用前应审核上游服务行为。真实 GUI 保存、跨版本数据迁移和服务兼容性未验收。
- Nushell 不改默认登录 Shell、不注入 Profile、不自动注册插件；配置仍使用上游原生用户位置。新版客户端可能在安装时自动登记 QQ／Lertaro 的 Start Menu 入口；旧版客户端或额外桌面集成须按 `integrate --desktop` 预览确认。安装不自动选择默认 CLI 命令。

## 新增逆向与云盘工具（2026-11-04）

| 包名 | 版本 | 入口 |
| --- | --- | --- |
| `x64dbg` | 2026.05.27 | `x64dbg`、`x32dbg`，官方 GitHub 快照 ZIP，保留 release 完整布局与 pluginsdk |
| `baidu-netdisk` | 8.9.7.101 | `baidunetdisk`，官方 issuepcdn 完整 NSIS 安装器只解包 |

- x64dbg 的 SHA-256 与 GitHub 发布资源官方 digest 一致；ZIP 全量解出，不执行任何安装动作。配置为各调试器 exe 同目录的 `release/x64/x64dbg.ini`／`release/x32/x32dbg.ini`（上游确认便携模型），以硬链接持久化；快捷方式等桌面集成仍需单独 `integrate --desktop` 预览确认。
- 百度网盘安装器校验 Windows Authenticode 为 `Valid`（PE FileVersion 8.9.7.101），SHA-256 与独立 Scoop bucket 发布值逐字节一致。按 NSIS 显式 `files` 映射解出 972 个程序文件（含 UTF-8 中文资源名），仅排除 `$PLUGINSDIR` 与 `uninst.exe`；不执行安装器，不注册 `BaiduNetdiskService`／壳扩展／Appx 组件，安装目录 `users` 目录硬链接持久化，其余配置沿用原生用户目录，不迁移既有账户或下载数据。
- 自动更新：x64dbg 匹配官方 stable 快照 ZIP 资产；百度网盘以官网 `pan.baidu.com/disk/cmsdata?do=client` 的 `guanjia.url` 为版本来源，载荷固定 `issuepcdn` 官方直链并重新校验签名与布局。未来版本载荷增删由 `layout: "baidu"` 重建显式映射（wecom 同款机制），布局校验失败只保留旧版。
- 两包均通过 `checkLayout` 隔离校验（220／972 个文件、0 个未知大小），自动发现规则实测命中当前版本；`npm run check` 与 116 项测试通过。未启动 GUI、未登录、未触发网盘服务或驱动安装，真实 GUI 运行与数据迁移不据此视为验收。

## CloudDrive2（2026-11-05，2026-11-08 修订）

| 包名 | 版本 | 入口 |
| --- | --- | --- |
| `clouddrive2` | 1.1.3.3 | `clouddrive`，官网签名的 WinUI 桌面版 Burn 捆绑包只解包应用 MSI |

- **1.1.3.3 起改为桌面版应用。** 原 `1.1.3` 打的是官网同一页面上的「核心服务」安装包 `CloudDrive2Setup-X64-1.1.3.exe`，它的 `clouddrive.exe` 是控制台程序（PE `Subsystem=3`），要靠终端启动、只提供 WebUI，快捷方式双击会开一个黑窗口，这就是报告的问题。现在打的 `app-v1.1.3-24` 频道里的 `CloudDrive2-1.1.3-3-windows-x64.exe` 是 WinUI 桌面客户端，`CloudDrive.exe` 为 GUI 子系统（`Subsystem=2`），双击即出窗口。
- 载荷是 WiX Burn 捆绑包（180,618,616 字节，SHA-256 `5be3f546…a776db`，与 GitHub 官方 release digest 逐字节一致）。捆绑链里既有 WinFsp 驱动 MSI 又有应用 MSI；清单用 `payload: "CloudDriveApp"` 只选应用 MSI，再用 `stripPrefix: "PFiles64/CloudDrive"` 剥掉 MSI 的安装前缀，显式 `files` 映射出 **752 个文件**（`CloudDrive.exe`、`cloudapi.dll`、`wwwroot` 等，排除两个 `.pdb`）。**不安装 WinFsp 驱动、不写 `Program Files`、不注册服务**。
- `desktop.shortcuts` 指向 `CloudDrive.exe`（GUI），`bin.clouddrive` 同样指向它；`1.1.3` 的 `piko-service.ps1` 管理员服务脚本、`shawl.exe` 与 WebUI 载荷随该产品一并退出新版本，旧版本行原样保留可精确安装。
- 状态位置沿用官方原生路径：`%LOCALAPPDATA%\CloudDrive.WinUI`（sqlite、`config.toml`、日志）与 `%USERPROFILE%\Waytech\CloudDrive2`（服务端共享数据），清单**不声明** `persist`／`configTemplates`，Piko 不拥有、不迁移这份外部数据。
- 自动更新的版本来源仍是官网 `download.html`，但改为匹配桌面版频道：一条正则同时抓 `app-v<app>-<build>` 的 tag 与 `CloudDrive2-<app>-<build>-windows-x64.exe` 的资产名，`versionTemplate: "{assetver}.{appbuild}"` 把两者合成 `1.1.3.3`——只用资产名会漏掉同一 `1.1.3-3` 资产的不同 bundle build。URL 模板同时重建 tag 与文件名，`required: ["CloudDrive.exe"]` 与签名校验仍把住入口。
- 验证：`checkLayout` 用同版本官方载荷隔离校验（752 个文件、526,032,129 字节、0 个未知大小、Authenticode 为 `Valid`，PE `FileVersion 1.1.3.3`）；`node scripts/update.mjs --check --packages clouddrive2` 返回 `current`。隔离 Piko 安装后从生成的 `Piko Apps\CloudDrive2.lnk` 启动，进程路径为版本目录下的 `CloudDrive.exe`，窗口标题 `CloudDrive`、显示登录页，无控制台窗口。旧 `1.1.3` 服务的 WebUI 行为、WinFsp 挂载、登录与真实数据迁移**未验收**；证据见 [CloudDrive2 验证记录](verification/clouddrive2-20261108.json) 与 [快捷方式修订说明](guides/clouddrive2-shortcut.md)。

## Bun（2026-11-05）

| 包名 | 版本 | 入口 |
| --- | --- | --- |
| `bun` | 1.4.4 | `bun`，官方 `oven-sh/bun` 的 `bun-windows-x64.zip` 单文件发行包 |

- 载荷为 `bun-v1.4.4` 的 `bun-windows-x64.zip`，SHA-256 与 GitHub 发布资源官方 digest 逐字节一致；解出单个 `bun.exe`（115,281,496 字节，Authenticode `Valid`，PE `FileVersion 1.4.4.0`），`stripPrefix bun-windows-x64`，不执行任何安装脚本。另有 `-baseline` 变体（无 AVX2 CPU 用）未登记，需要时另建独立配方。
- **只提供 `bun` 命令，不提供 `bunx`**：bun 依赖 argv[0] 分发 bunx，而 Piko shim 以目标路径启动 `bun.exe`（argv[0] 是 bun.exe），实测首参未知包报 `Script not found`；临时 `bunx.exe` 副本可正常工作，但清单无法复制文件。需要执行器语义时使用 `bun x <pkg>`。
- 状态模型：客户端把 `BUN_` 前缀环境变量列入保护名单（管理器自身基于 Bun 运行），清单无法像 uv 那样把 `BUN_INSTALL`／`BUN_INSTALL_CACHE_DIR` 重定向到 persist。全局安装与包缓存沿用原生 `~/.bun`，Piko 不拥有该目录、不迁移既有数据；隔离验证前后本机既有 `~/.bun`（138 项条目）指纹未变。清单不声明 `persist`／`env`。
- 隔离验证：`checkLayout` 通过（1 个文件、115,281,496 字节、0 个未知大小）；隔离 `PIKO_HOME` 安装后经 `__shim` 原生分发实测 `bun --version`、`bun -e`、`bun x --version` 均为 1.4.4；卸载／重装循环通过，不选默认命令。`update.mjs --check --packages bun` 在带 `GITHUB_TOKEN` 时返回 `current`（匿名 GitHub API 限流只会把该包标为 blocked，不会误报成功；发布资产 digest 仍强制核对）。
- **未验收**：真实项目构建／测试负载、`bun add -g` 与既有 `~/.bun` 的长期共存、`bun upgrade` 自更新行为。证据见 [Bun 验证记录](verification/bun-20261105.json)。

## Steam（2026-11-07）

| 包名 | 版本 | 入口 |
| --- | --- | --- |
| `steam` | 1769731672 | `steam`，官方 CDN 国际版引导包 `steam_win32.zip`（单文件 `steam.exe`） |

- 版本号取官方引导清单 `steam_client_win32` 的 `win32` 通道时间戳（1769731672 = 2026-01-30T00:07:52Z）。该清单经 cloudflare／akamai／eccdnx 三个官方 CDN 主机核对逐字节一致，为 `steam_win32` 固定内容寻址文件名与 `sha2` 摘要，且与国际版 `steamrow` 变体的哈希后缀、摘要一致；本包固定该 ZIP（2,307,664 字节，SHA-256 `1369615c…`）与清单摘要逐字节一致，不执行官方 `SteamSetup.exe`。安装器（NSIS）内置 2024-05 的旧 `Steam.exe`、`SteamService.exe` 与引导文案，仅作参照：CDN 引导 ZIP 即安装器首启下载的同一引导载荷，且更新。
- 解出单个 `steam.exe`（4,718,744 字节，Authenticode `Valid`，`CN=Valve Corp.`）。其 PE 资源同时含 `10.41.26.25` 与 `1.0.0.2` 两个 FileVersion，故不用 PE 版本做版本源。`checkLayout` 通过（1 个文件、4,718,744 字节展开、0 个未知大小）；签名规则新增载荷路径形式（`"signature": "steam.exe"`），对未签名容器内声明的已签名主程序校验，而不是容器本身。
- 首次运行由 `steam.exe` 自举下载完整客户端（与官方安装器首启行为一致，约 200 MB），本包不预置也不运行该流程（与 rustup 只引导管理器同模型）。`steamapps`／`config`／`userdata` 三个用户数据目录在首次启动前由 Piko 持久化创建，卸载／重装已验证保留测试数据；安装根目录的 `ssfn*` Steam Guard 令牌、`HKCU\Software\Valve\Steam` 注册表与 Steam 服务（`SteamService.exe`，本包不含）不由本包接管。Steam 会在安装目录内自更新，Piko 检测分叉时拒绝破坏性操作，需按客户端流程处理。
- 自动更新解析官方引导清单：仅当国际版引导 ZIP 的内容哈希变化时，才以新通道时间戳登记新版本（通道时间戳随任意包更新前进，不据此制造同载荷的新版本）；`steamrow` 与顶层载荷哈希／摘要不一致、`IsBootstrapperPackage` 缺失或时间戳异常时保留旧版；`steamchina` 渠道不打包。
- 隔离验证：本地 HTTP 源副本 + 独立 `PIKO_HOME`（piko 0.4.8）安装 1769731672，`steam.exe` 与官方载荷逐字节一致，未选默认命令，`piko use` 后 `which steam` 解析到受管理入口，卸载／重装持久化标记保留。`npm run check`（59 包／95 版本）通过；131 项测试 130 项通过，1 项失败为既有的 tortoise-recipe 真实 `.ps1` 用例受本机执行策略限制，与本包无关（暂存本改动前后失败一致）。未启动 GUI、未触发引导下载、未登录或迁移账户数据。证据见 [Steam 验证记录](verification/steam-20261107.json)。

## Epic 商城（2026-11-07）

| 包名 | 版本 | 入口 |
| --- | --- | --- |
| `epic-games-launcher` | 20.3.3 | `epic`，官方 WiX MSI 按显式 `files` 映射只解包 |

- 载荷取自 Epic 官方稳定端点 `launcher-public-service-prod06.ol.epicgames.com/launcher/api/installer/download/EpicGamesLauncherInstaller.exe` 的 303 重定向目标（2026-09-24 发布的 `EpicInstaller-20.3.3.msi`，264,237,056 字节）。MSI 的 SHA-256 与 winget 发布值逐字节一致；同端点的 `.exe` 引导载荷另行核对了 Epic 官方 Linux 引导清单（`linux-manifest-Prod-20.3.3.txt`）发布的 `egl_installer_sha512`。MSI 与解出的 `EpicGamesLauncher.exe`（43,809,208 字节）Authenticode 均为 `Valid`（`CN=Epic Games Inc.`），exe `FileVersion 20.3.3-0+UE5`（MSI ProductVersion 为 1.3.210.0，版本以官方分发的 CDN 构建号 20.3.3 为准）。
- 按 MSI 显式 `files` 映射解出 **4,450 个** `Epic Games/Launcher/**` 程序文件（572,175,748 字节展开，1 GiB 展开配额）；**排除** `DirectXRedist`（DXSETUP 运行时安装器）、`GameInputRedist.msi`、目标为系统目录的 VC++ 2010/2012/2013 运行库 DLL（`Win/System*`、`System*`）与目标为 ProgramData 的 EMS 配置。不调用 msiexec、不执行安装器、不写系统目录或注册表；系统运行库缺失时由用户自行安装，便携不等于无系统副作用（EGL 首次运行可能自行请求安装 Epic Online Services 或 DirectX 组件）。
- 配置与数据沿用 EGL 原生位置（`%LocalAppData%\EpicGamesLauncher`、`%ProgramData%\Epic`、用户自选的游戏库目录），本源不声明 `persist`、不迁移既有账户、游戏或凭据；EGL 会在安装目录内自更新，Piko 检测分叉时拒绝破坏性操作。
- 自动更新以官方稳定重定向端点发现版本（重定向至 `EpicInstaller-<version>.exe`），载荷固定为同版本官方 `.msi` 直链；无 MSI 的未来构建只会验证失败并保留旧版。`layout: "epic"` 按同款过滤重建显式映射，载荷增删时映射校验失败仅保留旧版，需人工确认后更新配方。
- **先升级客户端至包含 MSI 复合文档修复的版本**：0.4.8 及更早客户端在列举 MSI 复合文档时拒绝无尺寸存储（语言转换 `1025`／`1026`），导致任何含内嵌转换的 MSI（含本包）安装报 `Missing container entry size`。客户端 `../piko` 已修复（无尺寸存储按目录条目列出、不可提取），本包隔离安装用修复后客户端完成：4,450 个文件、排除项确认缺失、不选默认命令、`piko use` 后 `which epic` 解析到受管理入口。证据见 [Epic 验证记录](verification/epic-games-launcher-20261107.json)。未启动 GUI、未登录、未安装 EOS／DirectX 或迁移游戏库。

## Godot（2026-11-07）

| 包名 | 版本 | 入口 |
| --- | --- | --- |
| `godot` | 4.7.2-piko.1 | `godot`、`godot-console`，官方 `godotengine/godot` 的 `Godot_v4.7.2-stable_win64.exe.zip` |

- 载荷为稳定 tag `4.7.2-stable`（2026-08-18 发布）的 `Godot_v4.7.2-stable_win64.exe.zip`（86,013,866 字节），SHA-256 与 GitHub 发布资产官方 digest 逐字节一致（独立下载与更新器下载两次核对）。ZIP 内两个可执行文件均在归档根部，无需 `stripPrefix`；主程序与 `_console.exe` 均为 Authenticode `Valid`（`CN=Prehensile Tales B.V.`），PE `FileVersion 4.7.2` 与清单版本一致，并纳入 `verifyPEVersion` 在每次更新时强制核对。
- 命令模型：`godot` 指向主程序，`godot-console` 指向上游随包的 `_console.exe` 转发器（4.3 起上游不再单独发布 `_console.exe.zip`，控制台包装并入同一归档）；两个命令在原生与 Piko shim 下 `--version` 均输出 `4.7.2.stable.official.ed1daf0bf`。约 1.2 GB 的 export templates `.tpz` 为独立官方资产，不打包。
- **`4.7.2-piko.1`：补上开始菜单入口。** 原 `4.7.2` 清单没有 `desktop` 声明，安装后既无桌面也无开始菜单快捷方式，GUI 编辑器只能靠 `godot` 命令拉起。修订仅新增 `shortcuts: [{name: "Godot", path: "Godot_v4.7.2-stable_win64.exe"}]`：目标必须是 GUI 子系统的主程序（PE `Subsystem=2`），不能选 `_console.exe`（`Subsystem=3`，会先弹出控制台窗口）；`name` 只是标签，不参与模板替换。载荷、URL、SHA-256、命令表与持久化声明全部不变，属于只改入口的修订。
- 修订把上游版本写死在 URL、`bin` 和快捷方式路径里（`Godot_v4.7.2-stable_win64.exe`），因为上游不存在 `-piko.N` 资产。更新器为此增加一条规则：从 `-piko.N` 修订派生的候选先按基础上游版本替换，再按完整修订版本替换，避免下一个上游版本继承 `4.7.2` 的载荷名。
- 状态模型：不声明 `persist`／`env`；编辑器设置与 `app_userdata` 沿用 `%APPDATA%\Godot\` 原生位置，项目及其 `.godot` 目录由用户自定，Piko 不拥有、不迁移。
- 隔离验证：`checkLayout` 通过（2 个文件、181,057,040 字节、0 个未知大小）；隔离 `PIKO_HOME`（piko 0.4.9）安装后载荷与归档条目逐字节一致、不选默认命令、`use` 后 `which` 解析受管理入口、卸载清空载荷、重装循环通过。匿名 GitHub API 限流仅把 `update --check` 标为 blocked（bun 同款已知行为，不误报成功），发现语义已对照 live `releases/latest` 响应逐项核对。修订的快捷方式用 piko 0.4.11 在隔离 `PIKO_HOME` 中生成并实际启动 GUI 验证。
- **未验收**：编辑器 GUI 工作流（仅验证到项目管理器窗口出现）、导出模板安装与跨平台导出、win32／arm64／mono 变体。证据见 [Godot 验证记录](verification/godot-20261107.json)、[快捷方式修订记录](guides/godot-shortcut.md)。

## Blender（2026-11-07）

| 包名 | 版本 | 入口 |
| --- | --- | --- |
| `blender` | 5.2.3 | `blender`，官方 `download.blender.org` 便携 ZIP `blender-5.2.3-windows-x64.zip` |

- 版本与载荷取自官方 `release/Blender5.2/` 目录清单（5.2.3 LTS，2026-10-22 发布）及其随附 `blender-5.2.3.sha256`，SHA-256 三方一致（官方清单值、独立下载重算、清单登记值）；405,839,452 字节 ZIP 使用显式 395 MiB 下载／2 GiB 展开配额，`stripPrefix blender-{version}-windows-x64`。
- 布局：6,524 个文件、945,021,611 字节全量解出，完整保留版本化 `5.2/` 数据与脚本、`blender.shared/` 编解码与渲染 DLL、`blender.crt/` VC 运行库及捆绑 CPython（`required` 断言 `blender-launcher.exe` 与 `5.2/python/bin/python.exe` 存在）。`blender.exe` 与 `blender-launcher.exe` Authenticode `Valid`（`CN=Blender Foundation`），签名规则按 steam 同款形式对容器内已签名的 `blender.exe` 校验。
- 命令模型：仅注册 `blender`；`blender.exe` 为 CONSOLE 子系统二进制，`blender --version` 原生与 shim 均输出 `Blender 5.2.3 LTS`（构建 `e13b728c6880`）。`blender-launcher.exe`（更新感知启动器，语义未验收）与 `blender_debug_*.cmd` 等调试脚本保留为载荷文件、不注册命令。PE `FileVersion` 仅含主次版本 `5.2`，故不使用 `verifyPEVersion`，版本锚定官方目录清单与 `.sha256` 文件。
- 状态模型：不声明 `persist`／`env`；用户偏好、启动文件与已装插件沿用 `%APPDATA%\Blender Foundation\Blender\` 原生位置，Piko 不拥有、不迁移。
- 自动更新：regex provider 解析官方目录清单并按发现版本渲染 `Blender{major}.{minor}/blender-{version}-windows-x64.zip` 直链，`update --check` 实测返回 `current`；**大版本／次版本目录升级（如 Blender6.0）需手动更新规则 URL**，目录不匹配时发现失败仅 blocked，不会误报。`.msi`／`.msix`／windows-arm64 变体不打包。
- 隔离验证：`checkLayout` 通过（6,524 个文件、0 个未知大小；405 MB 载荷的首次重复下载超过更新器 HTTP 超时，改用已核对本地副本完成布局校验，隔离安装路径由客户端重新完整下载成功）；隔离 `PIKO_HOME`（piko 0.4.9）安装后 6,524 个载荷文件、不选默认命令、`use` 后 `which` 解析受管理入口、卸载清空载荷、重装＋shim 通过。
- **未验收**：编辑器 GUI 与渲染后端（Cycles／OptiX 等）、插件安装、launcher 语义、既有 Blender 安装的数据迁移。证据见 [Blender 验证记录](verification/blender-20261107.json)。

## 模拟器与编辑器（2026-11-08）

| 包名 | 版本 | 入口 |
| --- | --- | --- |
| `retroarch` | 1.22.2 | `retroarch`，官方 buildbot 稳定版 `RetroArch.7z` |
| `ares` | 148 | `ares`，官方 GitHub `ares-windows-x64.zip` |
| `mgba` | 0.10.5 | `mgba`、`mgba-sdl`，官方 `mGBA-0.10.5-win64.7z` |
| `medusa` | a2 | `medusa`，官方 `medusa-a2-win64.7z`（mGBA 作者的 NDS 预览版） |
| `shadps4` | 0.21.0 | `shadps4`，官方 `shadps4-win64-sdl-0.21.0.zip` |
| `vscode` | 1.145.2 | `code`、`code-gui`，官方 `win32-x64-archive` 便携 ZIP |

- 六个载荷均从官方渠道下载并独立重算 SHA-256；`checkLayout` 全量解出核对：RetroArch 14,808 个文件／541,900,046 字节、ares 4,971／110,831,256、mGBA 67／50,791,622、medusa 32／36,211,211、shadPS4 1／60,364,288、VS Code 3,280／1,087,039,357，未知大小文件均为 0。
- **RetroArch** 的 `saves`／`states`／`screenshots`／`system` 等目录由程序按 `:\saves` 这类相对应用程序目录的写法解析（`frontend/drivers/platform_win32.c`），因此这些目录必须是指向 `persist` 的联接，否则升级到新版本目录会丢存档、状态、BIOS 与已下载核心；同时用 `configTemplates` 生成 `retroarch.cfg`，把 `savefile_directory` 等七项指向 `persist`。`config_file_write()` 会先在同目录写 `.tmp` 再改名覆盖（`libretro-common/file/config_file_io.c`），所以该配置是普通文件而非硬链接，避免 Piko 检出链接漂移。随包分发的 `info/` 核心元数据**不纳入** `persist`，否则旧版本文件会遮蔽新版本自带的元数据。
- **ares** 从可执行文件目录读取 `settings.bml`，写入方式为 `fopen("wb+")` 原地截断，因此使用 `hardlink`；`Systems/` 存放用户自行 dump 的固件，一并纳入 `persist`。
- **mGBA** 分发包内含空的 `portable.ini`，配置因此落在程序目录。`config.ini` 由 `ConfigurationWrite()` 以 `O_TRUNC` 原地写，可用 `hardlink`；**`qt.ini` 是 QSettings 输出，经临时文件重命名落盘，硬链接会立刻失效，因此不纳入 `persist`**。`savestates`／`screenshots`／`cheats` 三个目录按目录联接持久化。
- **medusa** 只有预发布标签（`medusa-a1`／`a2`，2017），官方稳定渠道不存在；`a2` 是最后一个 Windows x64 预览版，版本与载荷固定，自动发现改从 `mgba.io/downloads.html` 读取 `medusa-<tag>-win64.7z`。解包目录名内嵌构建日期（`medusa-medusa-2017-04-26-win64`），跨版本无法模板化，故 `stripPrefix` 为字面值。
- **shadPS4** 只发布 SDL CLI 内核，无参数运行时仅弹提示框，因此快捷方式带 `-b` 进入 Big Picture；程序把可执行文件旁的 `user` 目录当作便携根，`persist: ["user"]` 一次性覆盖设置、密钥、补丁与逐游戏配置。官方 Qt 启动器是独立仓库的另一个包，本轮未登记。
- **VS Code** 用便携 ZIP：`bin/` 内只有 `code.cmd`，而 Piko 原生命令只能指向 `.exe`／`.com`，所以 `code` 是转发到该批处理的 PowerShell 入口，`code-gui` 直接启动 `Code.exe`。便携模式由 `data` 目录触发，`persist: ["data"]` 覆盖设置、扩展与工作区状态；ZIP 版不支持自动更新，版本由 Piko 管理。
- 全部六个包都不执行安装器、不注册服务／驱动、不写系统目录；快捷方式等桌面集成仍需单独 `integrate --desktop` 预览确认。
- **未验收**：六个模拟器的 GUI 运行与手柄／BIOS／ROM 路径配置、RetroArch 在线下载核心与着色器、shadPS4 固件 `sys_modules` 与游戏启动、VS Code 扩展安装与真实工作区。证据见 [模拟器验证记录](verification/emulators-20261108.json)。

## GitHub 自动更新（第六阶段）

- 已为登记的全部包（当前 68 包）提供自动发现策略。`innounp` 从上游发布说明发现版本；`dingtalk` 使用社区目录作为版本提示，但载荷固定取国内完整 updater ZIP 并通过现有摘要、PE 版本和布局校验，国际版 `-Release` 后缀不匹配。`qqnt` 自动发现官网新渠道、实时签名后验证原生 PE 版本与资源布局。`steam` 解析官方引导清单，仅在引导载荷哈希变化时登记新版本；`blender` 以官方 `download.blender.org` 目录清单发现版本，大版本目录变更需人工更新规则 URL。
- 每天 **03:17 UTC** 定时检查，也支持手动选择包名。校验官方摘要、分发签名及载荷布局后，只追加版本记录（需要时增加独立配方）并生成 PR；**已验证更新通过源整体校验、测试及远端完整文件树比对后自动 squash 合并；单包失败仅保留该包旧版，不阻止其他成功项**。不会升级本机软件；失败包仍在摘要报告，整体校验或合并失败时保留 PR 待处理。
- 同版本摘要变化、布局缺项、超出配额或源在验证期间被修改时拒绝覆盖。旧版本记录保留；PR 校验逐版本保护已发布清单的展开内容与安装哈希，不允许模板改动影响历史版本。
- `oh-my-pi` 已补入 **18.14.1**，保留 `18.13.2`。2026-10-31 的旧工作流已验证该版本，但同轮 Inno Setup 解包失败阻止整份 PR 合并；本地恢复的是该 PR 中逐字节相同的清单。现已改为只合并成功项，仍保留摘要、历史版本、索引边界和精确文件树校验。见 [诊断证据](verification/oh-my-pi-update-20261031.json) 与 [未合并排查](automation/README.md#已发现新版但主分支版本没变)。
- 脚本只依赖 Node.js 24.6+ 标准库；载荷验证在 Windows x64 运行。`npm run check`、`npm test`、`npm run update:discover` 可在本地检查。
- 配置文件已加入独立 Git 仓库；远端地址、GitHub 权限与 HTTPS 部署需要按实际仓库配置。详见 [自动更新说明](automation/README.md)。

## 本地试用

如已安装 Python，可在本目录运行：

```sh
python -m http.server 8765 --bind 127.0.0.1
```

然后在另一终端添加源：

```sh
piko source add main http://127.0.0.1:8765/
```

正式使用时只发布 `index.json` 与 `packages/` 到 HTTPS 静态目录；本地路径不能直接用于 `source add`。添加真实软件前需确认官方分发地址、版本和 SHA-256，不能将占位下载信息写入清单。

## 本机迁移盘点（仅本地）

`inventory/migration-inventory.md` 和 `inventory/migration-candidates.json` 记录从本机 Scoop、mise、Windows 注册表／Appx 发现的软件及初步迁移分类。迁移候选已按用户要求排除 Qt、微软运行库／SDK／维护更新组件、驱动及硬件配套、Edge 与 Windows 自带应用／扩展，以及 Visual Studio Enterprise 2026、EDFbrowser；原始扫描快照保留。2026-10-29 用户进一步纳入的 Orca、Tabbit、钉钉、微信、企业微信、Listary、ToDesk、向日葵共 8 款已登记清单并通过隔离载荷验证，正式索引为 46 包；完整 GUI、系统集成和实际数据迁移仍待验收。PowerShell 7 明确不处理；WPS Office、安妮Office、Perplexity 本轮未选择，保留待定记录。这不是可安装包清单，也不是 `piko import` 格式；本次范围更新未下载、迁移或卸载软件。

**`inventory/` 含软件列表和机器路径，已加入 `.gitignore`，不得随软件源静态目录公开部署。** 忽略文件不会自动约束静态服务器，请在发布时仅复制 `index.json` 和 `packages/`。
