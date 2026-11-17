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

## 曾经的尝试与撤销（历史版本 `5.13.1-piko.1`／`5.13.1.1`）

曾为此新增 `admin` 系统集成（`piko-service.ps1`），把服务锚定到稳定联接 `apps/lertaro/current`。实测发现该方案不可行：

- Lertaro 自带的 `InstallDirectoryLock` 拒绝联接目录（日志：`'...\current' is a link, not a directory; refusing to lock it`），服务无法进入 Running；
- 服务每次启动还会**删除安装目录里它不认识的联接**（`Removed a link that was not this product's: ...\Data`），把 Piko 的 `persist` 联接换成真实目录，造成数据分裂；
- 服务只接受与它同目录启动的 GUI，从 `current` 启动的 `Lertaro.App.exe` 会被拒绝（`Rejected LaunchHook`）。

## 当前配方：真实目录与必需服务

当前 `5.13.3` 配方继续使用 `admin.required: true`，在现有 `configFiles` 中提供 `piko-service.ps1`，保留显式管理员授权。载荷、SHA-256、命令和快捷方式名称不变。不声明 `persist: ["Data"]`，也不把 `.piko-system` 联接进厂商目录。

- 服务镜像始终为所选**真实版本目录**的 `Lertaro.Service.exe --service`；GUI、命令入口和快捷方式也必须由支持该声明的客户端指向同一真实目录，不能经过 `current`。
- 运行中的 `Data` 始终是真实目录。后台台账位于 `{persist}/.piko-system/piko-lertaro-service.json`，完整备份放在同目录的 `backup-<代次>`，不会因普通卸载删除。
- 脚本同时支持命名布局 `apps/lertaro/<版本>` 和旧版 `apps/<package-key>/<版本>`，持久目录使用对应包目录名。先验证脚本自身真实目录和 `.piko-install.json` 的名称、portable/verified、安装 ID、key、source identity、checksum、manifestHash 与真实 Root；服务归属不能只凭目录前缀判断。无台账收养要求旧版本目录中的有效安装收据与当前包 key、source identity 一致。若旧目录已删除，只有此前保存的同包安装身份与完整备份能证明归属和恢复数据，否则明确拒绝。
- 服务只接受 `LertaroService` 与精确 `Lertaro.Service.exe --service` 命令；外部目录、异常参数、未加引号的歧义路径、重解析路径或台账身份不匹配均拒绝。旧镜像文件缺失而旧安装收据、Data 仍在时，可以安全迁移。

## 新电脑安装与授权

使用支持必需服务生命周期的客户端（Piko ≥ 0.4.23 支持单命令 `--approve-admin` 审批），刷新源并安装/选择版本。安装服务需要管理员权限与显式审批；普通解压不等于服务已经可用。

```powershell
piko source refresh main
piko install main/lertaro@5.13.1
piko system lertaro --approve-admin   # 管理员终端，一条命令：打印计划并执行
piko use main/lertaro@latest
```

Piko ≥ 0.4.23 中 `--approve-admin` 单独一条命令即可完成审批（同次调用先打印完整计划再执行）；旧客户端使用 `--dry-run` 预览后 `--approve-admin --binding <预览 binding>` 两步。安装服务需要管理员权限；普通解压不等于服务已经可用。服务进入 `Running` 且镜像与真实版本目录一致后才算系统集成成功；缺少运行时等启动错误会保留台账并返回失败，不能假装安装完成。

## 升级、卸载与重装

1. 先退出 Lertaro GUI 与 `lff`。升级在管理员终端一条命令完成（Piko ≥ 0.4.23）：`piko update main/lertaro --approve-admin`，或 `piko system main/lertaro@<新版本> --upgrade --approve-admin`。流程仍为显式授权的**旧 remove → 新 install → 全部成功才选择新默认版本**，脚本不依赖 `current` 切换。旧版本目录必须在 remove 成功后才能回收。
2. remove 停止并确认服务停止，将真实 `Data` 复制到新的备份代次，保留隐藏文件和 ACL；复制失败不会把半份备份标记为完整，也不会删除服务注册。成功后删除同包服务注册，但保留原 Data、台账及完整备份。
3. 新 install 从完整备份恢复到新版本的临时真实目录，复制完成后更名为 `Data`，重新注册真实路径服务。目标已有非空且未被此次迁移认领的 Data 时报告冲突，保留两份数据，不合并、不覆盖。
4. 卸载后重新安装时保留包持久目录，再次预览并显式授权即可恢复 Data 与服务。不要主动清理 `persist/lertaro`，否则将失去这些备份。
5. 未激活候选版本的 remove 不会停止或删除另一版本的活动服务；候选已有 Data 会另存代次。全新且从未启动的候选没有 Data 时可安全清理。

## 历史安装与失败恢复

- 没有本地服务台账但存在同包旧注册时，经过新的显式审批可以收养并迁移。仅旧镜像丢失而旧 Data 尚在的情况可以修复；若旧 Data 也丢失且没有完整备份，明确报错，不能宣称恢复了历史数据。
- 历史 `current` 注册只有在联接可明确解析到同包真实版本时才可迁移；历史 `Data` 联接只接受恰好指向本包 `persist/lertaro/Data` 的情况。先完整备份，再仅删除联接本身，保留联接目标。
- 无注册但发现未认领的历史版本 Data／持久 Data 时，拒绝静默新建空数据；应先保全并人工确认迁移来源。
- 复制或启动失败会保留阶段台账、错误、原始 Data、已完成备份和部分临时目录。修复原因后，重新预览并批准对目标版本的 `piko system`；升级默认版本不会提前切换，成功后再重新预览升级。
- 数据冲突、外部注册、无法解析的旧台账需要先人工确认归属；不要直接删除台账来绕过检查。备份代次不会自动清理，确认恢复成功后再自行归档。

验证应使用临时 Piko 根和隔离服务命令替身，覆盖新装、升级、卸载重装、候选清理、悬空镜像、复制/启动失败重试、数据冲突与外部服务拒绝；不要为验证修改日常机器的真实服务。

## 边界

- 只涉及 `LertaroService` 一个服务名；不注册驱动、不写启动项、不改 `HKCU` 的 `lertaro://` 关联。
- 不自动安装 .NET 运行时；缺运行时仍由厂商 `install-dotnet-runtime.bat` 提示。
- 服务以 `LocalSystem` 运行是厂商设计（需读 USN／MFT），Piko 不改变该账户。

## 声明式 SCM 服务的适用边界

新版客户端的 `services` 可以注册包内真实版本目录中的原生 `.exe`，记录完整 SCM 配置和安装身份，提供启动、停止、状态与注销。它不会自动请求 UAC，也不收养没有自身收据的同名服务。

Lertaro **不能只把现有脚本改成 `services`**：当前脚本除 SCM 生命周期外，还负责真实 `Data` 的完整备份与跨版本恢复、旧目录身份核验、未认领数据冲突拒绝及失败阶段台账。普通 SCM 声明没有数据迁移能力；删除这些步骤会丢失数据安全保证。继续保留厂商特例 `admin` 路径，不同时声明同名服务，避免两个所有者争用 `LertaroService`。历史配方与已发布版本的展开摘要不变。

WinFsp 也不适用：其载荷是包含内核驱动和厂商 Launcher 的 MSI，不是可由包内相对 `.exe` 直接注册的普通便携服务。保留现有 `winfsp-setup` 交互安装器入口；Piko 不自动运行 MSI、驱动或伪造 SCM 声明。

