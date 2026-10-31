# Piko 软件源

独立于 `../piko/` 客户端项目维护的软件源目录，对应 `../piko/docs/replacement-gaps.md` 的 P0 软件源工作。

**当前共 46 个包**。原 38 包覆盖已盘点的 33 个 Scoop 迁移目标（排除管理器自身）和 5 个 mise 工具入口；本轮再登记 Orca、Tabbit、钉钉、微信、企业微信、Listary、ToDesk、向日葵共 8 包。新增 8 包均通过隔离安装、默认选择与命令入口校验，主程序版本和 Windows 签名状态检查通过；另验证两款远控软件的配置留存模型。证据见 [桌面软件验证](verification/desktop-apps-20261029.json)。原 19→38 包扩充的 30 项检查见 [历史覆盖记录](verification/coverage-20261029.json)。本页前三阶段的旧数量与待办保留为历史记录，当前范围以第四、第五阶段为准。

## 目录

- `index.json`：软件、已登记版本与清单路径索引。
- `packages/<name>/<version>.json`：Windows x64 分发清单。
- [TortoiseSVN 升级与 DLL 占用处理](guides/tortoise-svn.md)：版本化 Shell 配方、旧版本延后清理，以及旧 Scoop 安装的一次性撤销边界。修订 `1.15.0.29830-piko.1` 保留原载荷，后续上游更新自动继承新配方；历史阶段说明中的旧配方行为不适用于此修订。
- [向日葵快捷方式打开安装器的修复](guides/sunlogin.md)：`16.8.0.33445-piko.1` 将快捷方式及 `sunlogin`／`awesun` 命令改为提取后的 `flutter/AweSun.exe`，保留载荷及配置声明，不安装服务或驱动。

原始两份清单复制自客户端的 `examples/source/`：Node 26.12.1、ripgrep 15.2.0。现已增加 Lua 5.5.0、z.lua 1.8.26、Starship 1.27.0、fzf 0.74.5、PSFzf 2.7.12、sudo 0.2020.01.26、Snipaste 2.11.3；已在第六阶段加入 GitHub Actions 上游更新配置；推送并启用仓库权限后运行，正式 HTTPS 托管仍未部署。后续清单在此维护，客户端示例不自动同步。

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

## GitHub 自动更新（第六阶段）

- 已为全部 **46 包**登记更新策略：**44 包自动发现，2 包人工审计**。`innounp` 保留可信工具固定提交；`dingtalk` 保留国内完整载荷渠道，避免改成国际版或下载引导器。
- 每天 **03:17 UTC** 定时检查，也支持手动选择包名。校验官方摘要、分发签名及载荷布局后，只追加新版本清单并生成 PR；**当轮无失败、校验和测试通过、远端完整文件树与已验证内容一致后自动 squash 合并**。不会升级本机软件，失败时保留 PR 待处理。
- 同版本摘要变化、布局缺项、超出配额或源在验证期间被修改时拒绝覆盖。旧版本清单保留；PR 校验逐字节保护已发布版本。
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
