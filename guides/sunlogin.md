# 向日葵快捷方式打开安装器

## 原因与修订

`16.8.0.33445` 原清单将根目录的 `AweSun.exe` 同时作为两条命令和开始菜单快捷方式的入口。该文件是官方外层分发程序，直接启动会出现安装界面。原来的载荷、版本和签名检查未验证 GUI 启动行为，因此没有发现入口错误。

修订（已并入 `16.8.0.33445`）仅修正启动入口：

- `sunlogin`、`awesun`：`flutter/AweSun.exe`。
- 开始菜单“向日葵”：`flutter/AweSun.exe`，工作目录由客户端设置为其所在的 `flutter` 目录。
- 下载 URL、SHA-256、PE 资源解包路径及持久化声明保持不变。外层 `AweSun.exe` 仍保留，不自动执行。
- 配方修订原地并入上游版本号；后续上游版本继承修订后的入口。

## 已有安装

已安装版本不会因源清单修订而自动改变，版本目录内的旧 `piko-service.ps1` 也不会被 `source refresh` 替换。同上游版本更改 recipe 会改变 `manifestHash`，重复 `install` 可能因安装身份冲突被拒绝。下面的新装命令只适用于未安装该版本的环境；已有安装必须先阅读本节的安全撤销／重装限制，不能据此保证原地修复。

```powershell
piko source refresh main
piko install main/sunlogin@16.8.0.33445
piko system main/sunlogin@16.8.0.33445 --approve-admin
piko use main/sunlogin@latest
piko which sunlogin
piko which awesun
piko reset sunlogin --dry-run
```

以上 `system` 与 `use` 需在管理员终端执行（Piko 不会自动提权）。Piko ≥ 0.4.23 中 `--approve-admin` 单独一条命令即可：同一次调用先打印完整计划再执行，无需 `--dry-run` 预览后抄写 binding；如需先审阅再执行，仍可 `--dry-run` 预览并用 `--binding` 绑定早前预览。旧客户端保持两步预览/binding 流程。

如果源别名不是 `main`，请使用实际别名。不要手改 `.lnk` 后假定 `reset` 会接管：客户端按内容摘要验证快捷方式所有权，外部修改可能被拒绝。也不要只修改安装收据或只修改状态，两者必须一致。

### 同版本 recipe 修订的撤销与重装

本轮没有发布软件源，也没有修改用户已安装的 Piko、脚本、状态或批准收据。客户端没有“用新源脚本覆盖旧已批准脚本”的迁移命令；不得手改 `.piko-install.json`、`manifestHash`、系统集成收据或脚本来伪造原批准。

只有旧版本原已批准的 remove 能够完整、安全撤销其真实服务时，才使用已有客户端流程重装。先用下文的只读 SCM 命令核对四个名字和 ImagePath：**若发现任一 `*ServiceDeamon`，旧脚本漏枚举它，不能直接执行旧 remove 后卸载程序目录**。若存在外部同名服务、缺少原批准、旧 remove 失败或仍有任何服务引用版本目录，也没有本次已实现的安全自动迁移路径；保留原目录、配置、台账及备份，停止此流程，不用 `--force`、手动删目录或直接 `sc delete` 绕过边界。

确认没有守护服务残留、目标为原已批准并能完整撤销的 Piko 自有服务后，在管理员终端依次执行，每一步成功才继续：

```powershell
piko system main/sunlogin@16.8.0.33445 --remove --approve-admin
# 再用下文只读 SCM 命令确认四个服务均不再引用该版本目录。
piko unuse sunlogin
piko uninstall main/sunlogin@16.8.0.33445
# 卸载保留 persist，包括配置、.piko-system 台账目录和服务数据备份。
# 以下步骤须等待修订真正发布到所用软件源；本地仓库改动不等于发布。
piko source refresh main
piko install main/sunlogin@16.8.0.33445
piko system main/sunlogin@16.8.0.33445 --approve-admin
piko use main/sunlogin@latest
```

`system --remove` 执行安装时记录的原声明，不使用尚未批准的新源脚本。若旧版 remove 的缺陷阻止安全撤销，当前应明确报告阻塞，而不是宣称刷新源或重复安装已经修复服务。持久化配置与备份目录不能删除，重新安装后仍需真实管理员 SCM 启动验收。


本次对报告问题的本机旧版本做了独立入口修复：先备份状态、安装收据及原快捷方式，再在客户端 mutation lock 下同步修正命令与桌面声明，通过客户端选择事务重新生成快捷方式及所有权记录。保留旧版本号、原下载身份及 manifest hash；这是有备份记录的本地修复，不把旧安装伪装成已经发布的新修订。

## 后台服务集成

### 现象与原因

GUI 入口修订后，客户端可以启动但一直停留在“连接服务中”：向日葵16 的被控能力依赖 Windows 服务（`AweSunService` 为主，`SunloginService` 为兼容遗留名），便携安装不注册任何服务。若机器上有旧版向日葵/傲软卸载残留（服务指向已删除的 `D:\AweSun\OldAweSun.exe` 之类死路径），客户端也无法自愈，因为修复服务需要管理员权限。

### 修订内容

服务集成在入口修订的基础上新增：

- `configFiles`：`piko-service.ps1`，随安装写入版本目录。
- `admin.required: true` 系统集成：install/remove 都执行该脚本，参数 `install|remove {root} {persist}/.piko-system`，需要显式管理员审批。
- `persist` 追加实际服务配置 `AweSun/config.ini` 和 `.piko-system`；台账与完整服务数据备份保存在后者，不只保留顶层 GUI `config.ini`。

install 只调用厂商 service-only 安装器：`AweSun.exe --mod=install --admin=1 --cmd=install_silent --serviceonly=1 --path=<版本目录>`，不猜参数，也不把 Flutter GUI 直接注册为服务。脚本先验证 Piko `.piko-install.json` 的 name、source identity、key、checksum、manifestHash 和真实 Root；服务镜像必须是四个确切主服务／守护服务身份，并位于同一已验证包目录的明确版本子目录中。路径比较带目录边界，拒绝 sibling prefix、包根外路径、重解析点和未加引号的歧义 PathName。成功条件是服务运行且镜像锚定当前真实版本目录，随后把服务名、镜像、安装身份和状态写入原子所有权台账。

#### 注册与启动不是同一个动作

原脚本在厂商进程结束前只等待 `AweSunService` 变成 `Running`，自己不发出启动请求；厂商成功退出但留下已注册、停止状态的服务时，只能等到超时。现在先等待厂商安装器成功退出并验证注册身份，完成停服备份、配置发布与硬链接修复后，明确启动 `AweSunService`，等待真实 SCM 返回 `Running`。启动失败保留 `sc.exe` 退出码、诊断原文和 `cleanup-pending` 台账，不把注册成功当作运行成功，也不隐藏失败重试或自动提权。

固定载荷 `AweSun_16.8.0.33445_x64.exe`（98,196,416 字节，SHA-256 `d1003f291088e024932e4d4de19e4dcf2da282dd8fc1c0153402e562583d0cb7`）的静态字符串与反汇编区分了三个入口：`flutter/AweSun.exe` 是 GUI；根 `AweSun.exe` 是兼具安装器与 native 后台模式的厂商程序；服务实际由安装器放到版本目录内的 `AweSun` 子目录。安装定义包含 `"<版本目录>\AweSun\AweSun.exe" --mod=service`，旧兼容服务还可使用无参数的 `OldAweSun.exe`，不能把 Flutter GUI 直接注册进 SCM。

厂商还定义 `AweSunServiceDeamon`／`SunloginServiceDeamon`（`Deamon` 为厂商原有拼写），使用 `--mod=daemon`。以前脚本完全漏掉这两个名字；现在四个名字都在安装前完整检查，包目录之外的任一个同名服务都会阻止厂商执行，绝不接管。已证明归属的守护服务先停止、主服务后停止；配置全部处理完后，主服务先启动、原先运行的守护服务最后恢复。安装器也显式使用真实版本 Root 作为工作目录。旧兼容无参数入口仅限确切的 `SunloginService` 与 `OldAweSun.exe` 组合，其余入口必须匹配对应 native mode。

上述修复的是可由代码直接证明的激活遗漏及守护服务生命周期缺口；静态分析不能证明问题机器某次真实服务启动失败的具体 SCM 错误。本次只读 SCM 没有发现这四个服务，本机 Piko 状态也没有向日葵安装，不能用该环境重构用户现场。已有桌面验证记录明确不包含真实服务验收。

隔离回归已运行：24 项通过、0 失败，覆盖停止状态注册后的显式启动、1053 启动失败恢复、守护服务停启顺序和外部服务保护，不触碰真实 SCM。测试子进程显式使用进程级 ExecutionPolicy Bypass；产品脚本和用户永久执行策略未修改。

```powershell
node --test tests/sunlogin.test.mjs
```

真实验收必须在用户自行打开的管理员终端、新安装了已发布修订配方的环境中执行前述 `piko system ... --approve-admin`；已有同版本安装先遵守安全撤销／重装限制，不能原地覆盖已批准脚本。随后只读检查四个确切身份、原始 ImagePath 与启动结果：

```powershell
$names = 'AweSunService','SunloginService','AweSunServiceDeamon','SunloginServiceDeamon'
Get-CimInstance Win32_Service | Where-Object Name -in $names |
  Select-Object Name,State,PathName,StartMode,ExitCode,ServiceSpecificExitCode
$names | ForEach-Object { sc.exe qc $_; sc.exe queryex $_ }
Get-WinEvent -FilterHashtable @{LogName='System';ProviderName='Service Control Manager';StartTime=(Get-Date).AddMinutes(-10)} |
  Where-Object Message -Match 'AweSun|Sunlogin|向日葵' |
  Select-Object TimeCreated,Id,Message
```

应确认主服务为 `Running`、ImagePath 落在所选真实版本目录且参数为 native service mode；若 SCM 仍拒绝启动，保留上面的退出码、事件与 `{persist}/.piko-system/piko-sunlogin-service.json`，不能用隔离替身测试或 GUI 能打开代替真实验收。本次终端非管理员，未创建、启动、停止或删除任何真实服务，远控与无人值守功能仍未验收。


### 用法（需管理员终端，Piko 不会自动提权）

```powershell
piko install main/sunlogin@16.8.0.33445
piko system main/sunlogin@16.8.0.33445 --approve-admin   # 管理员终端，一条命令
piko use main/sunlogin@latest                          # 必需服务成功后选择

# 卸载集成与升级也各是一条命令（管理员终端）
piko system sunlogin --remove --approve-admin
piko update main/sunlogin --approve-admin   # 或：piko system main/sunlogin@<新版本> --upgrade --approve-admin
```

Piko ≥ 0.4.23 支持 `--approve-admin` 单命令审批（同次调用打印计划并执行）；旧客户端使用 `--dry-run` 预览 + `--binding` 两步，且各动作 binding 不可复用。

remove 支持 `installed`、`installing`、`recovery`、`cleanup-pending` 状态，即使外层 `AweSun.exe` 已缺失也能清理已证明归属的服务。没有本地服务台账时，不凭服务名接管：只有服务 PathName 严格落在同一 Piko 包目录、能通过对应版本 `.piko-install.json` 身份校验，并且是旧 `current/AweSun/AweSun.exe` 或 `OldAweSun.exe` 明确布局时，才建立 recovery 台账并清理。外部同名服务、无 receipt、路径歧义或 sibling prefix 均保持不动并拒绝；未激活候选不得停止或删除其他版本的活动服务、台账或共享 `AweSun/config.ini`。每次停止/删除前都会重新校验服务身份；失败会保留 `cleanup-pending` 记录，重新预览后可重试，不删除旧程序目录。

### 边界

- 不安装驱动、不开机项。服务脚本停止同一厂商数据树的全部服务后备份完整 `AweSun` 树，只有完整备份才写 `complete.json` 标记。实际 `AweSun/config.ini` 持久化；厂商安装器若原子替换文件，脚本会停服、备份新旧配置、更新共享文件并重建硬链接，然后再启动服务，重建失败会保留 `cleanup-pending`，不会假装配置已保存。未知数据保留在备份中，不把旧二进制自动恢复到新版本；跨版本配置兼容和远控身份仍需实际验收。
- 新装、升级、卸载重装都以真实版本 Root 传参，不依赖 `current` 已切换。升级先 remove 旧版本，再 install 新版本，成功后客户端才选择新版本；失败保留旧程序目录和可重试台账。
- 服务注册锚定具体版本目录而非 `current`。直接 reset/删除版本目录前必须完成显式 remove；若失败，保留状态记录，不静默丢失服务数据。

## 后续更新

本修订必须先发布到正在使用的软件源；只修改本地仓库不会改变远端清单。发布后，后续上游版本从当前 `latest` 清单生成，因此会继承 `flutter/AweSun.exe` 的两条命令及快捷方式目标，而不是继承旧清单的安装器入口。布局校验同时要求目标 EXE、Flutter 引擎和数据文件存在；路径或资源布局改变时阻止该候选发布，不自动回退到外层安装器。该校验不代替新版 GUI／远控功能验收。当前清单还会继承后台服务集成声明。

保持跟随 `latest` 且软件源确实发布了**新上游版本**时，后续执行（同版本 recipe 修订不能靠此流程迁移，参见已有安装）：

```powershell
piko source refresh main
piko update main/sunlogin
piko which sunlogin
piko reset sunlogin --dry-run
```

客户端安装新版后切换默认版本、`current` 和受管理快捷方式；持久化声明保持不变，不清除现有数据。实际配置格式的跨版本兼容仍需单独验证。如果曾用 `piko use main/sunlogin@<精确版本>`，该选择会锁定版本，`update` 不会升级；先改为 `piko use main/sunlogin@latest` 可恢复跟随源的最新版本。

当前问题机器的本地修复保留了原有 `latest` 请求，但不能替代远端修订发布。向日葵自身的应用内更新不由上述源生成和客户端切换流程管理，其行为未验证，建议通过 Piko 更新。

## 验证与边界

- 实际从修复后的快捷方式启动，进程路径为 `flutter/AweSun.exe`，不是根目录分发程序。
- `piko which sunlogin`、`piko which awesun` 均解析到该 GUI；`piko reset sunlogin --dry-run` 没有待修复项。
- 行为回归使用临时 Piko 根和隔离 PowerShell 替身，覆盖真实 receipt/path 边界、厂商参数、旧 `current/AweSun/OldAweSun` 收养、失败安装/停服失败可恢复、缺外层安装器 remove、外部服务与未激活候选保护，以及原子替换后 `AweSun/config.ini` 停服备份和硬链接修复。不会操作日常机器的真实服务或注册表。
- 不安装或启动远控服务，不修改启动项，不安装驱动，不迁移设备身份或凭据。GUI 能启动不代表远程连接、被控、无人值守、实际配置保存或跨版本迁移已验收。
