# 向日葵快捷方式打开安装器

## 原因与修订

`16.8.0.33445` 原清单将根目录的 `AweSun.exe` 同时作为两条命令和开始菜单快捷方式的入口。该文件是官方外层分发程序，直接启动会出现安装界面。原来的载荷、版本和签名检查未验证 GUI 启动行为，因此没有发现入口错误。

修订 `16.8.0.33445-piko.1` 仅修正启动入口：

- `sunlogin`、`awesun`：`flutter/AweSun.exe`。
- 开始菜单“向日葵”：`flutter/AweSun.exe`，工作目录由客户端设置为其所在的 `flutter` 目录。
- 下载 URL、SHA-256、PE 资源解包路径及持久化声明保持不变。外层 `AweSun.exe` 仍保留，不自动执行。
- 旧清单不可变，新增修订并调整索引；后续上游版本继承修订后的入口。

## 已有安装

已安装旧版本不会因源清单修订而自动改变。修订发布到所用软件源后，可显式安装并选择：

```powershell
piko source refresh main
piko install main/sunlogin@16.8.0.33445-piko.1
piko use main/sunlogin@latest
piko which sunlogin
piko which awesun
piko reset sunlogin --dry-run
```

如果源别名不是 `main`，请使用实际别名。不要手改 `.lnk` 后假定 `reset` 会接管：客户端按内容摘要验证快捷方式所有权，外部修改可能被拒绝。也不要只修改安装收据或只修改状态，两者必须一致。

本次对报告问题的本机旧版本做了独立入口修复：先备份状态、安装收据及原快捷方式，再在客户端 mutation lock 下同步修正命令与桌面声明，通过客户端选择事务重新生成快捷方式及所有权记录。保留旧版本号、原下载身份及 manifest hash；这是有备份记录的本地修复，不把旧安装伪装成已经发布的新修订。

## 后台服务集成（16.8.0.33445-piko.2）

### 现象与原因

GUI 入口修订后，客户端可以启动但一直停留在“连接服务中”：向日葵16 的被控能力依赖 Windows 服务（`AweSunService` 为主，`SunloginService` 为兼容遗留名），便携安装不注册任何服务。若机器上有旧版向日葵/傲软卸载残留（服务指向已删除的 `D:\AweSun\OldAweSun.exe` 之类死路径），客户端也无法自愈，因为修复服务需要管理员权限。

### 修订内容

`16.8.0.33445-piko.2` 在保持 piko.1 全部声明（载荷、入口、持久化）不变的基础上新增：

- `configFiles`：`piko-service.ps1`，随安装写入版本目录。
- `admin` 系统集成：install/remove 都执行该脚本，参数 `install|remove {root} {persist}/.piko-system`。
- `persist` 追加 `.piko-system`，存放服务所有权台账。

install 复用厂商外层程序的静默服务安装：`AweSun.exe --mod=install --admin=1 --cmd=install_silent --serviceonly=1 --path=<版本目录>`，以轮询 `AweSunService` 运行且镜像路径锚定本版本目录为成功条件；成功后把实际注册到的服务名写入台账。remove 只停止并删除台账记录、且镜像路径仍锚定本版本目录的服务，外部服务跳过并提示。台账记录版本目录，另一版本持有注册时拒绝重复安装，需先用旧版本 remove 或走 `--upgrade` 一次审批完成切换。

### 用法（需管理员终端，Piko 不会自动提权）

```powershell
piko install main/sunlogin@16.8.0.33445-piko.2
piko use main/sunlogin@latest
piko system sunlogin                                  # 预览，记下 --binding
piko system sunlogin --approve-admin --binding <binding>
piko system sunlogin --remove --approve-admin --binding <binding>
piko system sunlogin --upgrade --approve-admin --binding <binding>   # 版本切换时旧移除+新安装
```

本机若已有手动/旧安装注册的服务（包括指向 `current` 的注册），脚本会拒绝接管；先显式删除现有 `AweSunService`、`SunloginService` 再走上述流程。

### 边界

- 不安装驱动、不开机项、不迁移设备身份或凭据：服务端配置（`AweSun\config.ini` 等）留在各自版本目录，卸载旧版本即丢弃；身份跨版本迁移未验收。
- 服务注册锚定具体版本目录而非 `current`，与 piko 版本不可变原则一致；未 remove 就 reset/删除版本目录会留下死服务，与本文开头的残留问题同源。
- 与 piko.1 修订一样，本修订必须发布到正在使用的软件源后才对其它机器生效。

## 后续更新

本修订必须先发布到正在使用的软件源；只修改本地仓库不会改变远端清单。发布后，后续上游版本从当前 `latest` 清单生成，因此会继承 `flutter/AweSun.exe` 的两条命令及快捷方式目标，而不是继承旧清单的安装器入口。布局校验同时要求目标 EXE、Flutter 引擎和数据文件存在；路径或资源布局改变时阻止该候选发布，不自动回退到外层安装器。该校验不代替新版 GUI／远控功能验收。piko.2 起还会继承后台服务集成声明。

保持跟随 `latest` 时，后续执行：

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
- 回归覆盖修订的两条命令、快捷方式、原载荷／持久化声明不变，以及后续版本继承。更新检查额外要求 Flutter 引擎和数据文件存在。
- 不安装或启动远控服务，不修改启动项，不安装驱动，不迁移设备身份或凭据。GUI 能启动不代表远程连接、被控、无人值守、实际配置保存或跨版本迁移已验收。
