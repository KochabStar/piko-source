# CloudDrive2 快捷方式打开黑窗口

## 现象与原因

开始菜单 `Piko Apps\CloudDrive2` 和 `clouddrive` 命令都指向 `clouddrive.exe`，双击后是一个控制台窗口，不是客户端界面。

原因在包选错了产品线，不在客户端：

- `clouddrive2@1.1.3` 打的是官网同一页面上的「核心服务」安装包 `CloudDrive2Setup-X64-1.1.3.exe`。它的 `clouddrive.exe` 是**控制台程序**（PE `Subsystem=3`），启动后在终端里跑服务、只对外提供 WebUI（`http://127.0.0.1:19798/`），必须另开浏览器才能用。
- 官方同一页面还有「应用直接下载版」：`app-v1.1.3-24` 频道里的 `CloudDrive2-1.1.3-3-windows-x64.exe`，那是 WinUI 桌面客户端，`CloudDrive.exe` 是 **GUI 程序**（PE `Subsystem=2`），双击出窗口。

客户端的快捷方式只按清单的 `desktop.shortcuts` 建 `.lnk`，之前清单里写的就是控制台入口，所以建出来的快捷方式必然是黑窗口。

## 修订内容（1.1.3.3）

- `format: "burn"` + `payload: "CloudDriveApp"`：捆绑包是 WiX Burn，链里既有 WinFsp 驱动 MSI 又有应用 MSI，清单只选应用 MSI。
- `stripPrefix: "PFiles64/CloudDrive"`：MSI 的安装前缀 `PFiles64/CloudDrive/` 剥掉，显式 `files` 映射出 752 个文件（`CloudDrive.exe`、`cloudapi.dll`、`wwwroot/**` 等，排除两个 `.pdb`）。
- `bin.clouddrive` 与 `desktop.shortcuts[0]` 都改成 `CloudDrive.exe`。
- 新版本**不再**包含 `shawl.exe`、`wwwroot` 服务端载荷与 `piko-service.ps1` 服务注册脚本：桌面版自己就是客户端，不需要管理员服务。
- `1.1.3` 那一行原样保留，可精确安装旧的服务版；跟随 `latest` 的安装会切到 `1.1.3.3`。

## 更新链路

桌面版和核心服务是两条不同的版本线：

| 频道 | release tag | 资产名 | 清单版本 |
| --- | --- | --- | --- |
| 核心服务 | `v1.1.3` | `CloudDrive2Setup-X64-1.1.3.exe` | `1.1.3` |
| 桌面版 | `app-v1.1.3-24` | `CloudDrive2-1.1.3-3-windows-x64.exe` | `1.1.3.3` |

资产名里的 `3` 与 tag 里的 `24` 不是同一个数：同一版应用会重发新的 bundle build。所以发现规则用一条正则同时抓 tag 和资产名，再靠 `versionTemplate: "{assetver}.{appbuild}"` 合成版本号。只取资产名的版本会让同一 `1.1.3-3` 资产的不同 build 撞版本，发现流程会误报 `already indexed`。`tests/clouddrive2.test.mjs` 覆盖了这条路径。

## 已有安装

旧 `1.1.3` 装的是一份服务端载荷，和桌面版是两种程序。要换成桌面版：

```powershell
piko source refresh main
piko install main/clouddrive2@1.1.3.3
piko use main/clouddrive2@latest
piko reset clouddrive2 --dry-run
piko which clouddrive
```

如果源别名不是 `main`，用实际别名。旧 `1.1.3` 版本目录可以留着（它的服务脚本本来也没执行过），确认桌面版能用后再删。

不要手改 `.lnk`：客户端按内容摘要验证快捷方式所有权，外部改动的文件会被拒绝接管；也不要只改安装收据或只改 state，两者必须一致，否则 `reset` 会拒绝。

## 验证

- `checkLayout` 用真实捆绑包隔离校验：752 个文件、526,032,129 字节、0 个未知大小，捆绑包 Authenticode `Valid`，应用 `FileVersion 1.1.3.3`。
- SHA-256 `5be3f546…a776db` 与 GitHub 官方 release digest 逐字节一致。
- `node scripts/update.mjs --check --packages clouddrive2` 返回 `current`。
- 隔离 `PIKO_HOME` + 本地 HTTP 源安装后，从新生成的 `Piko Apps\CloudDrive2.lnk` 启动：进程路径是版本目录下的 `CloudDrive.exe`，窗口标题 `CloudDrive`，渲染出登录页，无控制台窗口。
- 旧 `1.1.3` 的 `clouddrive.exe` 直接运行只输出 `welcome to clouddrive v1.1.3 …` 并转为后台，不弹窗口——这就是报告现象的复现。

## 边界

- **不安装 WinFsp 驱动**：捆绑包链的驱动 MSI 被排除，所以盘符挂载所需的 WinFsp 需另行安装；本包不写 `Program Files`、不 `msiexec`、不注册服务。
- 不声明 `persist`／`configTemplates`：数据在 `%LOCALAPPDATA%\CloudDrive.WinUI` 与 `%USERPROFILE%\Waytech\CloudDrive2` 的原生位置，Piko 不拥有、不迁移。
- 登录、云盘挂载、备份/复制任务、播放与真实数据迁移未验收；窗口出现只证明入口正确。
