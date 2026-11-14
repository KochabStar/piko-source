# 软件源自动更新

软件源可独立运行，不依赖相邻的 Piko 客户端源码。维护脚本使用 Node.js 24.6+ 标准库，无 npm 运行依赖；下载载荷的布局、PE 版本和签名验证在 Windows x64 上运行。

## 更新流程

`.github/workflows/update-source.yml` 每天 **03:17 UTC** 检查上游，也可通过 Actions → **Update upstream packages** 手动运行。`packages` 输入可填写以英文逗号分隔的包名；空值检查全部包。更新工作流只在默认分支运行。

1. 校验当前索引、清单与更新规则，并运行测试。
2. 从官方发布仓库、官网下载页、经批准的社区版本提示或官方 API 发现正式版本。当前 69 包全部配置自动发现。`innounp` 从上游发布说明发现版本并只取对应官方解包器；`dingtalk` 仅从社区目录读取四段数字版本作为提示，载荷 URL 固定为钉钉国内完整 updater ZIP，随后仍由 SHA-256、PE 版本与布局校验把关。国际版 `-Release` 后缀不匹配。Claude Code 从官方原生版本清单读取 Windows x64 SHA-256；OpenCode、Nushell、Lertaro 匹配各自经过审查的正式版 ZIP。NVIDIA App 仅管理已签名的官方安装器，不自动执行系统安装。Pi 使用官方 `earendil-works/pi` 稳定版 Windows x64 ZIP，额外核对主题、WASM 和原生辅助模块等资源布局。`steam` 解析官方 CDN 引导清单（Valve KV），固定国际版 `steamrow` 引导 ZIP 的内容寻址地址与 `sha2` 摘要，仅当载荷哈希变化时以新通道时间戳登记版本；`steamchina` 渠道不匹配。`epic-games-launcher` 跟随 Epic 官方稳定重定向端点发现构建号，载荷固定为同版本官方 MSI 直链并按 `layout: "epic"` 重建只含启动器本体的显式映射。`godot` 匹配官方稳定 tag 的 Windows x64 ZIP 并以 `verifyPEVersion` 核对 PE 版本；`blender` 解析官方 `download.blender.org` 发布目录清单并渲染官方直链，大版本／次版本目录升级需人工更新规则 URL。
3. 下载候选载荷，计算 SHA-256；GitHub、Node、Go、rustup 提供官方摘要时必须比对，PowerShell Gallery 比对 SHA-512，向日葵另比对官方 MD5。部分桌面分发同时要求 Windows 签名状态为 `Valid`。
4. 使用单独固定版本、固定摘要的 7-Zip、innounp、lessmsi 读取或解包元数据。检查命令、快捷方式、字体及执行配方引用的文件，检查显式文件映射、嵌套载荷、文件类型、大小、链接和路径冲突。MSI 同时核对数据库中的文件标识和 CAB 内容；不会运行 MSI 安装动作。
5. 在 `packages/<category>/<name>/package.json` 中追加已验证版本的 SHA-256／配方引用，按保留策略裁剪落窗版本，再更新 `index.json`。旧版本展开后的内容和安装哈希不可改变，模板包只允许增加版本或确有需要的新配方。源在验证期间被手动修改时拒绝覆盖。
6. 再校验生成的源并运行测试，向 `automation/upstream-updates` 分支创建或刷新一个 PR。**核对已验证更新的远端完整文件树和提交 SHA 后自动 squash 合并；单个包失败不阻止其他已验证更新。** 不绕过仓库策略，不自动合并其他分支或其他 PR。

一个包校验失败只阻止该包发布，保留其已有版本和索引；**其他已验证的更新仍正常生成并自动合并 PR**。单包失败的运行在合并之后仍最终标红，并在运行摘要列出失败包与原因，避免把部分成功标成全部通过。没有有效更新时不创建空 PR；全部失败时不合并。源整体校验、测试、报告完整性或精确文件树校验失败仍停止整次发布。

## 新增一个包

不再需要手工下载、辨认格式、逐条抄写文件映射。`scripts/add.mjs` 把机械部分做完，只留下需要人判断的几项。

1. **探测**：给它一个发布页或资产直链。

   ```powershell
   node scripts/add.mjs probe <name> <发布页或资产URL> [--version <版本>] [--payload <捆绑包ID>] [--category <分类>]
   ```

   它会挑出页面上提到包名的资产（优先 x64/Windows），下载一次，然后按**文件头结构**而不是扩展名判断格式：zip / 7z / tar.gz / MSI（OLE 复合文档）/ Inno（试读元数据）/ Burn（读链上 `BurnManifest.xml`）。判断依据是真实结构，所以把 zip 命名成 `.exe` 或把安装器命名成 `.zip` 也不会认错。

   WiX Burn 捆绑包链上通常有好几个 MSI（CloudDrive2 就是 WinFsp 驱动 + 应用两个），探测会列出全部 `payloadCandidates`；用 `--payload` 指定要哪一个，再跑一次即可得到该载荷的文件树。

   结果写到 `automation/drafts/<name>.json`（已在 `.gitignore`），里面包含 SHA-256、字节数、格式、可执行文件候选和条目样例。

2. **补三项判断**：`bin`（命令表，必须自己定）、`desktop`（要不要快捷方式）、`stripPrefix`（要剥掉的安装前缀），以及 `rule`（更新发现规则）。

3. **校验并发布**：

   ```powershell
   node scripts/add.mjs apply <name> --dry-run   # 下载、比对 SHA-256、跑 checkLayout
   node scripts/add.mjs apply <name> --yes       # 写清单 + 索引 + 更新规则
   node scripts/check.mjs
   node scripts/update.mjs --check --packages <name>
   ```

   `apply` 对 MSI／Inno／Burn 会从同一份元数据自动生成显式 `files` 映射（CloudDrive2 那 752 条现在是自动产出的），并按 `stripPrefix` 剥掉前缀。清单、`index.json` 条目和 `automation/rules.json` 一起写入，避免漏改其中一处。

约束没有放松：`checkLayout` 仍然是发布闸门，探测阶段不写任何清单，`--dry-run` 不写文件，签名与摘要校验照旧。探测只**读**载荷，从不执行它。

### 已发现新版，但主分支版本没变

报告中的 `updated` 表示候选清单已写入更新分支，不表示已经合并到主分支，也不表示本机应用已升级。`blocked` 仅影响对应包；其他更新会继续通过整体校验和精确文件树检查后尝试自动合并。若主分支仍未变化，检查自动合并步骤、仓库保护规则及 PR 是否存在冲突，而不是只看版本发现步骤或 PR 是否创建成功。

旧策略下，2026-10-31 的运行 `41175558383` 已校验 `oh-my-pi 18.14.1`，但 `inno-setup 7.1.1` 解包失败导致 PR #4 未自动合并。新策略已取消这一包阻塞全部更新的限制；部署新工作流后重新运行即可独立发布成功项，失败包留待修复后重试。若只需要一个软件，也可在 Actions 的 `packages` 输入填写 `oh-my-pi` 单独重新验证。**单包重跑会刷新同一个更新 PR，仅包含本轮重新验证通过的候选，不保证保留此前其他待合并候选；其他包后续需重新检查。** 不绕过摘要、载荷布局或自动合并安全校验。

待更新合并并发布到实际使用的源后，本机还需要刷新源并显式升级：

```sh
piko source refresh main
piko install main/oh-my-pi@latest
piko use main/oh-my-pi@latest
piko which omp
omp --version
```

已跟踪 `latest` 的现有安装可改用 `piko update main/oh-my-pi`；若原默认请求为精确版本，`update` 会保留固定版本约束，不会自动变成 `latest`。

## QQNTV2 实时签名

`qqnt` 从官方 `pcConfig.json` 的 x64 地址发现版本，在下载前调用固定免登录 GetSign 接口，解包并读取 PE 完整版本，核对 Authenticode 与完整程序资源布局。**用户必须先升级 Piko 至 0.4.1**；旧版客户端无法下载新渠道。源只保存无签名固定地址与 SHA-256，不记录临时参数，不重新分发载荷。失败时保留旧版，签名失效最多重试一次。详见 [实现和边界](../guides/qqnt.md)。

## 保持的边界

- 不执行下载的应用、安装器、自更新器、Shell 初始化、bootstrap 或管理员配方，不启动 GUI、服务、驱动，不迁移用户数据或凭据。
- 配置代码、持久化与执行声明沿用原清单；其中包含旧版本字面量时要求维护者审核，不盲目改脚本。包含 Shell、bootstrap、admin 的候选在 PR 报告中提示复核。
- 下载上限 2 GiB；最终应用文件上限 512 MiB，展开总配额沿用原清单。中间层受到独立的有界输出及共享嵌套预算限制。NSIS 未提供文件大小时，报告明确记为未知，实际安装仍由 Piko 按落盘字节强制限额。
- 上游同版本摘要变化时阻止更新，不重写历史；上游接口返回旧版本时保留当前版本，不降级。
- 企业微信按候选载荷生成精确 NSIS 文件映射；Tabbit 动态查找唯一 Offline GUID 路径，保留 CN x64 完整载荷地址，并核对实际 PE 版本。不会把网站的小型下载器当作完整程序。
- 微信官网文件名不是完整程序版本，必须读出解包后 `Weixin.exe` 的 PE 版本；重复发布同版本而摘要变化也不会覆盖旧清单。
- 布局和签名通过不等于新版本的 GUI、服务、驱动、Shell API 或真实数据迁移已验收。自动合并只更新软件源元数据，不执行本机安装或迁移。
- `innounp` 主包从上游版本说明自动发现并仅接收其官方归档；用于自动化验证的解包器仍在 `automation/tools.json` 单独固定版本与摘要，避免候选包替换当前运行中的验证工具。
- `dingtalk` 仅将社区目录的四段数字版本作为发现提示；载荷地址固定生成国内 `dtapp-pub.dingtalk.com/.../win_updater/Release/DingTalkUpdate_v<version>.zip` 完整包。国际版 `-Release` 格式不匹配，不读取社区下载地址；候选仍须通过摘要、PE 版本和布局验证。
- `steam` 只接受官方引导清单中与国际版 `steamrow` 变体哈希后缀、摘要一致的引导 ZIP，且要求 `IsBootstrapperPackage` 标记；载荷哈希不变时通道时间戳前进不产生新版本。其分发容器是未签名 ZIP，签名规则以载荷路径形式校验解包后的 `steam.exe` 本体，容器完整性由清单 `sha2` 摘要在下载时强制核对。
- `epic-games-launcher` 只跟随 Epic 官方稳定重定向端点，并要求重定向目标带三段数字构建号的 `EpicInstaller-<version>` 载荷；载荷固定重建成同版本 `.msi` 直链。显式映射仅保留 `Epic Games/Launcher/**` 启动器本体，运行时安装器、系统目录 DLL 与 ProgramData 配置不会进入安装；未来版本载荷增删由映射校验拦下并保留旧版。
- `libreoffice` 用 `layout: apptree` 从候选载荷自己的文件表重建 `<stripPrefix>` 下的整棵应用树，不沿用上一个版本的映射。该 MSI 只在应用树之外重复目标路径（同路径 VC++ 运行时），因此应用树白名单既满足显式映射要求，又不会因内嵌 Python 运行时（`python-core-3.13.17 → 3.13.18`）或随包扩展（`share/extensions/dict-an/**`）增删而把每个新版本都判为布局变化。已发布版本的清单仍逐字节不可变。

## 在 GitHub 启用

本地配置和 Git 提交不等于远端工作流已经运行。

1. 把本仓库推送到你选择的 GitHub 仓库，设 `main` 为默认分支。当前配置没有写死仓库拥有者或远端地址。
2. 在 **Settings → Actions → General → Workflow permissions** 允许工作流写入，并启用 **Allow GitHub Actions to create and approve pull requests**。组织策略若禁用此项，需要仓库管理员处理。
3. 手动运行一次 **Update upstream packages**，检查 Job Summary 和生成的 PR。没有新版本时不会生成空 PR。
4. 工作流在源整体校验、测试及已验证更新的精确文件树检查通过后自动合并 PR；单包失败不影响其他成功项。整体检查失败或远端文件树、基准提交、PR 头提交变化时停止，保留 PR。合并只更新软件源，不会升级本机软件。

默认使用 GitHub 自动提供的 `GITHUB_TOKEN`，无需保存个人令牌。默认令牌创建的 PR 不能依赖后续 `pull_request` 工作流立即自动运行（可能需要额外审批），因此更新作业在创建 PR **之前**已执行完整源校验和测试，合并前另外核对远端完整文件树。若启用了必须在 PR 提交上运行的分支保护检查，可在仓库 Secret 中配置受限令牌 **`SOURCE_UPDATE_TOKEN`**，仅授予本仓库的 Contents / Pull requests 写权限；该令牌仅供创建 PR 和合并脚本使用，发现上游仍使用默认令牌。也可使用符合相同权限要求的 GitHub App 令牌。

GitHub Actions 本身全部固定到提交 SHA。仓库变更和 PR 另由 `.github/workflows/validate.yml` 校验；PR 检查会和基准提交逐字节比较已发布清单。

### 自动合并约束

`scripts/auto-merge.mjs` 不依赖付费的分支保护或 GitHub 原生延迟合并开关。它只在本次更新作业完成校验及测试后执行：

- 必须为完整生成的 `--write` 报告，至少含一项已验证更新；允许其他包为 `blocked`，但成功／失败计数必须与逐包结果一致，拒绝重复、未知或未完成结果。不以“创建了 PR”代替校验成功。
- 工作流仅在报告、摘要完整写入并输出 `report_complete=true` 后才准备合并；更新器异常中断、缺失输出或没有成功更新时不进入合并。命令因单包失败退出非零不影响已验证子集，最终仍报告失败。
- 只允许改动 `index.json` 和本次报告列出的包文件；模板包文件必须精确等于基准模板追加本轮已验证版本，原版本配方和校验值不变。索引必须逐项等于基准索引加本轮成功版本，失败、未选择和未更新包及其他元数据必须保持不变。整个候选 Git tree 在创建 PR 前绑定，远端 PR 的完整 tree SHA 必须完全一致。
- PR 必须来自同一仓库的 `automation/upstream-updates`，目标必须为本次运行的默认分支；不合并 fork、任意 PR 或 draft。
- PR head SHA 必须等于创建 Action 返回的 SHA，默认分支必须仍为本轮基准提交；出现冲突、未知合并状态或并发变动时停止。
- 使用 GitHub 合并接口并传入确切 head SHA，只做 squash；不使用管理员绕过、强推或自动审批。已有分支保护仍由 GitHub 强制执行。
- 因整体检查失败而未合并的 PR 不会被挂上日后可能意外生效的延迟自动合并请求；须下一次更新作业重新验证成功项、完成整体校验后才会尝试合并。

## 模板与历史版本

目前每包一个 `packages/<category>/<name>/package.json`（7 类目录见主 README 的[分类与版本保留](../README.md#分类与版本保留)），共 70 个包文件、129 个版本。schema 2 文件按 `recipes` 保存声明式模板，按 `versions` 保存已核验版本、recipe 引用、各下载摘要及可选配额。普通更新不新增版本文件；配方改变时增加独立 recipe。旧版精确安装仍可用，未跳过 SHA-256 校验；每包按保留策略保留最近 8 个版本组，落出窗口的最旧版本由更新器或 `npm run prune` 裁剪，Git 历史仍可找回。

`npm run compact:check` 可预览 schema 1 清单合并；`npm run compact` 执行。迁移允许索引路径改为共享包文件，但必须逐版本保证解析后的完整 JSON 序列化及 manifestHash 不变；原 schema 1 路径未迁移时仍要求文件字节不变。迁移后的客户端必须支持模板格式；先部署新版 Piko，再发布此源。Git 历史仍保留旧清单，模板只控制工作目录和后续重复配置增长，不压缩已有 Git 历史。

## 本地命令

```sh
npm run check
npm test

# 仅查询元数据：不下载应用、不改索引
npm run update:discover -- --packages node,uv

# 下载并验证候选：不改索引和清单
npm run update:check -- --packages node,uv

# 追加已验证的候选版本：请检查 diff 后提交
npm run update -- --packages node,uv
```

省略 `--packages` 时检查全部包。临时下载、可信解包工具缓存及 `update-report.json` / `update-report.md` 均已忽略；不会进入更新 PR。需要代理时按 Node.js 的环境代理支持设置 `NODE_USE_ENV_PROXY=1` 和相应代理变量，不要把本机地址、令牌或代理配置提交到仓库。

## 发布软件源

更新流水线负责生成并按上述约束自动合并已验证清单，**不自动启用 Pages、创建公开仓库或部署 HTTPS 站点**。部署时只发布 `index.json` 与 `packages/`；不要直接公开含本机盘点的工作目录。`inventory/` 仅留在本地并由 `.gitignore` 排除。
