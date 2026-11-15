# Lertaro 后台服务与数据目录

## 现象与原因（历史：5.12.7 注册悬空）

便携版 `Lertaro-Portable.zip` 释放后，应用会从**它当时所在的那个目录**注册 `LertaroService`，镜像路径形如：

```text
C:\Users\<用户>\AppData\Local\piko\apps\lertaro\5.12.7\Lertaro.Service.exe --service
```

Piko 按版本目录安装，升级后旧版本目录会被回收。注册项仍然指着 `5.12.7`，文件却已经不在了，于是每次启动都是：

```text
由于下列错误，Lertaro Background Service 服务启动失败: 操作成功失败。
```

`sc.exe start LertaroService` 直接返回 `exit=2`（系统找不到指定的文件）。这与载荷、摘要或签名都无关，载荷本身是完好的；问题只在服务注册锚定了一个会消失的路径。

## 5.13.1-piko.1 的尝试与撤销

`5.13.1-piko.1` 曾为此新增 `admin` 系统集成（`piko-service.ps1`），把服务锚定到稳定联接 `apps/lertaro/current`。实测发现该方案不可行：

- Lertaro 自带的 `InstallDirectoryLock` 拒绝联接目录（日志：`'...\current' is a link, not a directory; refusing to lock it`），服务无法进入 Running；
- 服务每次启动还会**删除安装目录里它不认识的联接**（`Removed a link that was not this product's: ...\Data`），把 Piko 的 `persist` 联接换成真实目录，造成数据分裂；
- 服务只接受与它同目录启动的 GUI，从 `current` 启动的 `Lertaro.App.exe` 会被拒绝（`Rejected LaunchHook`）。

因此自 `5.13.1.1` 起，配方**不再包含** `admin`／`configFiles`／`persist` 声明：这个应用的数据与服务注册都以它自己的安装目录为准，Piko 不再伪装能持久化它们。载荷、SHA-256、命令表与快捷方式不变。

## 实际可行的用法

- **安装/升级**：正常 `piko install`／`piko use`，然后从**所选版本的真实目录**启动一次应用（`piko which lertaro` 给出的路径），应用会自行把 `LertaroService` 注册到该目录并启动。不要从 `current` 联接启动 GUI。
- **切换版本后**：先 `sc stop LertaroService`（需管理员），从新版本目录启动应用完成重注册；旧目录回收前服务镜像一直指向旧目录。
- **数据迁移**：`Data` 目录在版本目录内，升级前用 `robocopy <旧版本目录>\Data <新版本目录>\Data /E` 迁移（`Data\Machine` 的 ACL 需要管理员权限）。
- **开始菜单快捷方式**：指向具体版本目录的 `Lertaro.App.exe`；升级后如需更新，重选目标即可。

## 边界

- 只涉及 `LertaroService` 一个服务名；不注册驱动、不写启动项、不改 `HKCU` 的 `lertaro://` 关联。
- 不自动安装 .NET 运行时；缺运行时仍由厂商 `install-dotnet-runtime.bat` 提示。
- 服务以 `LocalSystem` 运行是厂商设计（需读 USN／MFT），Piko 不改变该账户。
