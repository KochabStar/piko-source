# TortoiseSVN：DLL 占用下的升级与旧安装清理

## 升级策略（配方修订 `1.15.0.29830-piko.1` 起）

这不是让每次更新前强制关闭 Explorer，而是将 **更新程序／切换注册** 与 **删除旧文件** 分开：

1. MSI 只解包到独立版本目录，不执行 MSI 安装动作。安装候选不会覆盖旧版本 DLL。
2. `piko system ... --upgrade` 仍须管理员内容绑定审批：撤销旧版所拥有的注册值，再选择新版并登记新路径。
3. Shell 扩展的 DLL／COM 路径直接指向实际版本目录，不使用 `current` DLL 路径，也不创建固定的 `CommonProgramFiles\TortoiseOverlays` junction。
4. 已经运行的 Explorer／文件选择器仍可能使用旧版 DLL；旧文件继续保留。新进程在注册切换后使用新路径，现有界面何时显示新版不能仅凭注册写入保证。
5. 客户端清理旧系统集成包前用 Windows Restart Manager 查询 EXE／DLL 占用。预览为 `defer-in-use`，实际结果为 `deferred-in-use`，不会强杀进程或强删被占用版本。用户自行注销／重启释放后再清理。该行为需要支持占用检查的新版 Piko 客户端；仅刷新源不能升级客户端。

新配方只更改自己登记且收据匹配的值，不运行 `regsvr32`，不删除旧程序目录，不修改个人 SVN 设置、`.diff/.patch` 关联或 Windows 的 `Offline Files` overlay。注册收据有 installing／installed／removing／removed 状态，重复执行和中断重试会核对旧值及新值；外部漂移拒绝覆盖。它不是跨注册表事务，失败时需重新预览／检查，不会由 recover 自动重跑管理员代码。

### 为什么新增一个配方版本

上游程序仍为 **1.15.0.29830**，`-piko.1` 是 Piko 的配方修订号，载荷 URL、SHA-256 及 MSI 文件映射与旧版相同。旧的已发布 JSON 保持不可变，避免原安装收据失效。后续上游出现新版时，更新器会自动套用 `scripts/recipes/tortoise-shell-extension.ps1`，不会回到固定 overlay junction 的旧做法。

## Piko 原生命令

以下版本是示例，升级时替换为源内实际候选版本：

```powershell
piko source refresh main
piko install main/tortoise-svn@1.15.0.29830-piko.1
```

**尚未启用 Piko 系统集成**时，先选择，再在自行打开的管理员 PowerShell 中预览／授权：

```powershell
piko use main/tortoise-svn@1.15.0.29830-piko.1
piko system main/tortoise-svn --dry-run
piko system main/tortoise-svn --approve-admin --binding <上一步摘要>
```

**旧默认版已有 Piko 系统集成**时，不直接 `use` 或只运行 `update`：

```powershell
# 候选已安装，旧默认与注册暂时保留
piko system main/tortoise-svn@1.15.0.29830-piko.1 --upgrade --dry-run
piko system main/tortoise-svn@1.15.0.29830-piko.1 --upgrade `
    --approve-admin --binding <上一步组合摘要>

# 更新成功后，旧 DLL 是否释放不影响新版保留
piko cleanup main/tortoise-svn --versions --keep 0 --dry-run
piko cleanup main/tortoise-svn --versions --keep 0 --yes
```

不要把 `deferred-in-use` 当作升级失败，也不要为了删除旧版反复重装新版。注销／重启后重新预览清理即可。若其他进程在检查后再次加载 DLL，Windows 仍可能拒绝删除；该检查降低风险，但不是跨进程锁。清理报错时保留现场并检查，不强删日志。正常 uninstall 被占用时会在移动目录前拒绝，并提示占用进程。

仅使用 CLI／GUI 本体而不需要 Explorer 菜单／图标的用户，无须运行 `piko system`；普通并行安装／选择不注册 Shell 扩展。

## 旧 Scoop 安装：一次性迁移边界

Piko 的 `system --remove` **只能撤销 Piko 自己的收据**，不能拿它删除 Scoop 的外部注册。新配方检测到指向 Scoop 的冲突会停止，而不是自动接管。

旧 Scoop TortoiseSVN 清理应按以下顺序处理：

1. 保存工作，确认新的 Piko 本体与 `svn --version` 正常。备份需要的个人设置、原注册键和旧安装清单；备份放在 Scoop 根目录之外。
2. 在管理员 PowerShell 中，先检查 HKLM／HKCU 的 `Software\Classes\CLSID` 中 `InProcServer32`／`LocalServer32`，以及 `SOFTWARE\TortoiseSVN` 和 `SOFTWARE\TortoiseOverlays`。只撤销**当前值明确指向旧 `scoop\apps\tortoise-svn` 目录**的资源，删除前逐值备份并再次比对。不要仅凭键名包含 Tortoise 就删除，其他 SVN 客户端可能共享 overlay。
3. 尤其先解除旧 `TortoiseStub.dll`、`TortoiseOverlays.dll` 的加载路径，再由用户自行注销／重启。单独结束 `TSVNCache.exe` 不会卸载 Explorer／Listary／文件选择器中已经加载的 DLL；仅重启 Explorer 也不一定释放其他进程。
4. 重启后确认旧路径不再被加载，再删除**确切的旧安装目录**，不要删除 Piko 安装、工作副本或 `.svn` 数据。若要清空整个 Scoop，另行明确检查其 persist 数据删除范围；本节不是清空其他软件数据的授权。
5. 核对旧注册路径与旧快捷方式已消失，再选择是否启用 Piko 的系统集成。不要在旧路径冲突仍存在时绕过 Piko 的保护。

查看缓存进程（只读）：

```powershell
Get-CimInstance Win32_Process |
    Where-Object Name -eq 'TSVNCache.exe' |
    Select-Object ProcessId, ExecutablePath
```

**不要直接导入旧 Scoop 的 `tortoisesvn-uninstall.reg`**：某些清单会整树删除个人 `HKCU\Software\TortoiseSVN`、文件关联及共享 overlay；这不是安全的逐资源撤销。也不要默认 `regsvr32 /u` 就能完整撤销所有版本／架构的注册。

本页不附带自动删除旧 Scoop 注册的入口，不要求运行客户端仓库 `.tools` 脚本；一次性清理必须依据该机器的实际所有权和占用情况。

## 验证与限制

- 自动测试覆盖新旧配方内容、未来上游继承、隔离 HKCU 命名空间中的注册切换／重复执行／外部漂移拒绝／部分撤销恢复。
- 客户端另用真实 Windows DLL 加载进程核验 Restart Manager 能识别占用且不终止进程，并验证旧版本延后清理、默认不变及释放后删除。
- HKCU 隔离测试不等于真实 HKLM 管理员实装、Explorer overlay 展示或旧 Scoop 完整卸载认证。此修复不宣称消除所有 Windows 共享锁，也不会自动重启 Explorer、注销、重启或提权。
