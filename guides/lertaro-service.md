# Lertaro 后台服务启动失败

## 现象与原因

便携版 `Lertaro-Portable.zip` 释放后，应用会从**它当时所在的那个目录**注册 `LertaroService`，镜像路径形如：

```text
C:\Users\<用户>\AppData\Local\piko\apps\lertaro\5.12.7\Lertaro.Service.exe --service
```

Piko 按版本目录安装，升级后旧版本目录会被回收。注册项仍然指着 `5.12.7`，文件却已经不在了，于是每次启动都是：

```text
由于下列错误，Lertaro Background Service 服务启动失败: 操作成功失败。
```

`sc.exe start LertaroService` 直接返回 `exit=2`（系统找不到指定的文件）。这与载荷、摘要或签名都无关，载荷本身是完好的；问题只在服务注册锚定了一个会消失的路径。

## 修订内容（5.13.1-piko.1）

载荷、SHA-256、命令表、快捷方式与 `Data` 持久化声明全部保持不变，只新增系统集成：

- `admin` install/remove 执行 `piko-service.ps1`（同时声明在 `configFiles`），参数 `install|remove {root} {persist}/.piko-system`。
- 服务镜像路径**锚定到该包的稳定入口** `apps/lertaro/current/Lertaro.Service.exe`，`current` 是 Piko 管理的目录联接，会跟随所选默认版本。以后换版本不需要重装服务。
- 启动类型为延迟自动启动（`delayed-auto`），失败恢复 `restart/15000/restart/30000/restart/60000`，与厂商安装器写入的策略一致。
- 写入台账 `{persist}/.piko-system/piko-lertaro-service.json`；remove 只停止并删除台账记录的服务。
- 已存在且指向本包之外的 `LertaroService` 直接拒绝接管，需先由它的所有者删除。
- 若安装时已存在指向旧版本目录的注册（即上面的故障态），先按本包重新注册，再验证服务确实在 `current` 路径下进入 `Running`。

脚本语法在 PowerShell 7 与 Windows PowerShell 5.1 下都能解析：`AutomaticDelayedStart` 只有 PowerShell 7 的 `New-Service` 接受，因此启动类型先建为 `Automatic`，再用 `sc.exe config ... start= delayed-auto` 补上。

## 用法（需管理员终端，Piko 不会自动提权）

```powershell
piko source refresh main
piko install main/lertaro@5.13.1-piko.1
piko use main/lertaro@latest
piko system lertaro                                  # 预览，记下 --binding
piko system lertaro --approve-admin --binding <binding>
piko system lertaro --remove --approve-admin --binding <binding>
```

本机若已被故障注册污染（服务指向已删除的版本目录），按上述 install 步骤会被识别为本包内的旧注册并重建，不需要手工 `sc delete`。

## 边界

- 只管理 `LertaroService` 一个服务名；不注册驱动、不写启动项、不改 `HKCU` 的 `lertaro://` 关联。
- 不自动安装 .NET 运行时；缺运行时仍由厂商 `install-dotnet-runtime.bat` 提示。
- 服务通过 `current` 联接运行，因此升级瞬间若服务正在运行，它仍是旧文件的映像；重新 `piko system lertaro` 或重启服务即可切到新版本。
- 服务以 `LocalSystem` 运行是厂商设计（需读 USN／MFT），Piko 不改变该账户。
