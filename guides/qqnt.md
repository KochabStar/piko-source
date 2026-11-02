# QQNT 新渠道下载与长期软件源

## 结论（2026-11-02）

**有可行方案：下载前调用 QQ 官网公开、免登录的 `GetSign` 接口，再从官方 CDN 下载。** 不需要 QQ 账号、Cookie 或第三方密钥；签名是临时下载授权，不能固定写入包清单。

本次实际验证：

- 官方 Windows 配置仍指向 `9.9.36` 的 x64 分发，外层 PE 版本为前次已核验的 `9.9.36.53644`。
- 对同一个无签名 URL 请求返回 **403**。
- 重新调用官方 `GetSign` 返回 HTTP **200**、`retcode: 0`，产生新的 `sign`／`t`。
- 对新签名 URL 请求 `Range: bytes=0-1` 返回 **206**，`Content-Range: bytes 0-1/330446512`。本轮没有重复下载完整载荷或运行 QQ。
- 前次官方完整下载的 SHA-256 为 `63255c70c7ff523e7eed7d52d9708ed7a77ea346ece6474c65dded406edb3155`；范围探测不能替代完整下载的 SHA-256 校验。

无签名资源身份：

```text
https://qqdl.gtimg.cn/qqfile/QQNTV2/9.9.36/release/e8e54bbb/QQ_9.9.36_260924_x64_01.exe
```

官方流程与可复查来源：

- 官网：`https://im.qq.com/index/#/windows`。
- Windows 元数据：`https://qq-web.cdn-go.cn/im.qq.com_new/latest/rainbow/pcConfig.json`，读取 `Windows.ntDownloadX64Url`。
- 官网前端 `assets/index.js` 的下载处理先执行 `GetSign`，再导航至返回地址。
- Nixpkgs 的 QQ 更新脚本采用相同官方接口：`https://github.com/NixOS/nixpkgs/blob/master/pkgs/by-name/qq/qq/update.sh`。

## 官方签名请求

```http
POST https://im.qq.com/http2rpc/gotrpc/noauth/trpc.qqntv2.urlsign.UrlSign/GetSign
Content-Type: application/json
x-oidb: {"uint32_command":"0x9b8e","uint32_service_type":1}
Origin: https://im.qq.com
Referer: https://im.qq.com/index/

{"url":"<已固定版本的官方无签名资源 URL>"}
```

成功条件为 `retcode === 0` 且 `data.url` 有效。返回值只应存在于下载进程内存中；不写入源清单、锁文件、Git、缓存键或常规日志。签名接口属于官网公开下载流程，不是私有接口或绕过账号权限。

## 推荐：客户端原生按需签名

长期解决需要 **Piko 客户端下载层**配合，而不只是源更新脚本：

1. 清单继续固定无签名资源 URL、完整版本与 SHA-256。安装历史版本时必须签名这个固定 URL，不能重新选择官网 `latest`。
2. 仅对精确的 `https://qqdl.gtimg.cn/qqfile/QQNTV2/` 官方资源启用专用解析器；其他包和老版 `QQNT/` 下载行为不变。
3. 请求固定的官方 `GetSign` 端点，不接受源清单指定任意 POST 目标，不跟随签名接口的重定向，不携带 GitHub token／Cookie／账号信息。
4. 验证返回 URL：HTTPS、精确 `qqdl.gtimg.cn`、默认端口、无用户名密码／片段，路径必须与固定资源一致；保留原查询参数语义，只允许添加必要签名参数。
5. 仅将通过校验的临时 URL 交给既有下载链，仍执行重定向策略、超时、大小上限和最终 SHA-256 校验；缓存仍按已固定 SHA-256 寻址。
6. 签名失效可重新申请一次，不应无限重试，也不能退回跳过摘要、运行安装器或调用外部任意下载脚本。
7. 更新器也调用同一个签名逻辑，但保存清单时仍写无签名地址。更新器独自解决签名只会让 CI 能下载，**不会让未升级的客户端能安装**。

客户端完成并发布上述能力后，再追加 `9.9.36.53644`、必要资源布局与自动更新规则，保留当前 `9.9.33.52230` 历史版本。应补齐恶意域名／路径、过期签名、签名接口重定向、摘要不符及旧版精确安装测试。

本次未修改或发布客户端，也未把返回 403 的新地址伪装成可安装版本；源中仍保留已经完整校验的官方 `9.9.33.52230`。

## 备选：稳定 HTTPS 签名重定向服务

只改软件源也可以使用一个稳定 HTTPS 地址，在收到 GET／HEAD 时申请官方签名后返回 **302**，让客户端最终直接从官方 CDN 下载。无需镜像或重新分发载荷字节；现有客户端可跟随 HTTPS 重定向并按固定 SHA-256 校验。

已有参考实现 `DeepslateQAQ/qq-download-worker`：

```text
https://github.com/DeepslateQAQ/qq-download-worker
```

审阅时的提交为 `797944f47722975827df7a93a33172a8a1304079`。其设计对下载路径现场取签名、限制官方主机及路径，并返回 `Cache-Control: no-store`；不能把仓库源码审阅等同于证明某个公网部署始终运行相同代码。

此方案引入额外可用性和隐私依赖。优先使用自己管理、可审计的部署，而不是悄悄将公共第三方服务写入主软件源；摘要校验仍必须来自独立的官方完整下载，不能信任重定向服务提供的摘要。本次没有创建云资源、部署 Worker、采用公共第三方中转或上传 QQ 载荷。

## 为什么仍保留人工策略

- 一次性的签名 URL 即使当前成功，过期后仍会破坏安装。
- 在更新工作流中刷新签名不能保证数天后安装、缓存清空或旧版重装仍然有效。
- 当前源清单只声明静态 HTTPS 资源，没有下载前动态 POST／解析协议；不向旧客户端发布不认识的字段。
- 手工将已核验载荷放入 Piko 摘要缓存可以临时绕开网络下载，但不能当作已修复长期软件源。

因此，官方按需签名是推荐的根本方案；客户端支持或自管稳定重定向部署完成前，`qqnt` 保留人工更新与原可下载版本。
