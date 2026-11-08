# Godot 装完没有快捷方式

## 现象与原因

`godot@4.7.2` 安装成功后，开始菜单 `Piko Apps`、桌面、任务栏里都没有 Godot 入口；GUI 编辑器只能用 `godot` 命令或手工进版本目录启动。

原因不在客户端，而在清单：原 `4.7.2` 的平台项完全没有 `desktop` 声明。客户端的快捷方式只从 `desktop.shortcuts` 生成（`Programs\Piko Apps\<name>.lnk`），没有声明就什么都不建。客户端行为正确，是清单漏了入口。

顺带排除的另一个可能性：`godot-console` 指向上游的 `_console.exe` 转发器（PE `Subsystem=3`），如果拿它当快捷方式目标，双击会先弹一个控制台窗口再拉起编辑器，入口语义不对。GUI 目标必须是主程序 `Godot_v4.7.2-stable_win64.exe`（PE `Subsystem=2`）。

## 修订内容（4.7.2-piko.1）

新增版本 `4.7.2-piko.1`，只增加一个快捷方式声明：

```json
"desktop": {
  "shortcuts": [
    { "name": "Godot", "path": "Godot_v4.7.2-stable_win64.exe" }
  ]
}
```

- 目标为 GUI 子系统的主程序；不使用 `_console.exe`。
- `name` 只是开始菜单标签，不参与模板替换；`path` 由模板机制替换，但本修订把上游版本写死（上游不存在 `-piko.N` 资产），因此这里直接写 `4.7.2`。
- 载荷 URL、SHA-256、`bin` 命令表、`persist`／`env` 声明全部不变；`4.7.2` 行保持原样发布，未改写。

## 更新链路

`-piko.N` 修订把上游版本字面写在 URL、`bin` 路径和快捷方式路径里。`scripts/update.mjs` 的 `nextManifest` 现在会先按"去掉 `-piko.N` 的上游版本"替换，再按完整修订版本替换，下一次上游发版（如 `4.7.3`）派生的候选不会继承 `4.7.2` 的载荷名。`tests/godot.test.mjs` 覆盖了这条路径。

## 已有安装

本机旧安装不会因为源清单修订自动获得入口。发布修订后可正常升级：

```powershell
piko source refresh main
piko install main/godot@4.7.2-piko.1
piko use main/godot@latest
```

如果继续用 `4.7.2`，也可以在客户端所有权模型内补入口（本机就是这么做的）：备份 `state.json` 与 `.piko-install.json`，把修订后的 `desktop` 声明同时写入两者（安装收据必须与 state 完全一致，否则 `reset` 会拒绝），然后：

```powershell
piko reset godot --dry-run
piko reset godot --yes
```

`reset` 由客户端生成 `.lnk` 并登记所有权摘要；不要手写 `.lnk`——客户端按内容摘要验证归属，外部改动的文件会被拒绝接管。

## 验证

- 隔离 `PIKO_HOME` + 本地 HTTP 源（piko 0.4.11）安装 `4.7.2-piko.1`：自动创建 `Piko Apps\Godot.lnk`，目标解析到 `apps/godot/4.7.2-piko.1/Godot_v4.7.2-stable_win64.exe`，工作目录为版本目录。
- 实际从该快捷方式启动：进程路径为 GUI 主程序，窗口标题 `Godot Engine - 项目管理器`，无控制台窗口。
- 卸载该版本后快捷方式随所有权收据一并移除。
- 本机旧 `4.7.2` 安装按上面的收据修复流程补入口，`reset --dry-run` 无剩余待修复项；从修复后的快捷方式启动同样到项目管理器。

## 边界

- 不声明 `persist`／`env`：编辑器设置与 `app_userdata` 仍在 `%APPDATA%\Godot\`，项目目录由用户自定。
- 不安装 export templates，不代跑编辑器工作流；GUI 能启动不代表导出工具链、调试器或跨平台导出已验收。
- 命名冲突：若 `Piko Apps` 下已有非 Piko 所有的 `Godot.lnk`，客户端跳过该入口并保留原文件，不会覆盖。
