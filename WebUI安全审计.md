# WebUI 安全与健壮性审计报告

> 审计时间：2026-09-22 · 范围：WebUI 整条新增链路
> （`scripts/server.mjs` · `scripts/run_pipeline.mjs` · `scripts/login.mjs` · `scripts/cdp_lib.mjs`
> · `scripts/lib/{paths,zip,jobs,export_engine,import_backup}.mjs` · `scripts/sessions.mjs`）
> 结论：**26 项问题，25 项已修，1 项标为中风险保留**（附规避方式）。
> 回归：`verify_webui` 151/151 · `verify_extras` 117/117 · `verify_sessions` 49/49 · `verify_daycut` 118/118。
> commit `6891d9e`（已 push）。

---

## 一、安全（8 项）

### A1 「一次请求删光工作区」—— 严重 · 已修

- **定位**：`scripts/lib/import_backup.mjs` 的 `deleteImported()`；入口 `server.mjs /api/imported/delete`。
- **根因**：删除逻辑是 `rmSync('imported/' + batch, { recursive: true })`，而 `batch` **直接来自请求体**。
  只要 batch 里能塞进 `..`，`imported/..` 就指向整个工作区 —— 一条 DELETE 请求删掉全部备份。
  同理，批次名在**创建**时也没校验，等于先把定时炸弹存进 sessions.json。
- **修复**：新增 `paths.mjs::safeSegment(name, fallback)` —— 把任何名字压成**单个安全路径段**：
  `/ \` 一律拍平成 `_`、开头的点去掉（挡 `..`）、Windows 非法字符替换、截断 60 字符、空名回落默认名。
  `deleteImported()` 里**先对原始输入做一次校验**（含分隔符 / 开头点 / 长度）再压段，双保险。
  批次名、上传名、导出文件名前缀现在**全部**经过它。
- **验证**：`verify_webui` 里 4 条断言（拍平 `../`、挡 `..`、空名回落、超长截断）。

### A2 登录凭据可被下载 —— 严重 · 已修

- **定位**：`server.mjs` 的 `/api/download` 与静态文件出口。
- **根因**：下载接口对 `?path=` **没有任何目录限制** —— `?path=data/cookie_header.txt` 能把微博 Cookie、
  `?path=bili/cookie_header.txt` 能把 B站 SESSDATA（等同账号密码）原样下载走；`?path=scripts/server.mjs` 能拿源码。
- **修复**：两道闸，**下载出口和静态出口都要过**（只挡 API 没用，改个 URL 走静态就绕过了）：
  1. 目录白名单 `DOWNLOAD_DIRS = ['exports/', 'imports/', 'imported/']`；
  2. 敏感文件黑名单 `SENSITIVE_RE`：`cookie_header.txt` / `*_key.txt` / `.env*` / `id_rsa*` / `*.pem|pfx|p12` → 403。
  另外静态响应统一加 `X-Content-Type-Options: nosniff`。
- **验证**：4 条断言（白名单内可下载 · 白名单外 403 · `../` 穿越 400 · 凭据文件双出口均 403）。

### A3 导出 HTML 里的 `javascript:` 链接 —— 高 · 已修

- **定位**：`scripts/lib/export_engine.mjs` 渲染 HTML 时的链接输出。
- **根因**：导出的 HTML 会被**别人**打开，而聊天里的链接是**对方可控**的。
  一条 `javascript:...` 在导出的网页里就是一段能执行的脚本（`data:text/html` 同理）。
- **修复**：新增 `safeUrl()` 白名单，只放行 `http(s):` 和 `mailto:`，其余一律清空。

### A4 CSV 公式注入 —— 高 · 已修

- **定位**：`export_engine.mjs` 的 `csvCell()`。
- **根因**：Excel / WPS 会把以 `= + - @` 开头的单元格**当公式执行**。聊天里 `-2+3`、`@某人`、`=1+1` 很常见，
  旧实现原样导出，对方一打开就可能执行攻击载荷（经典 CSV injection / DDE）。
- **修复**：这类单元格前面补一个单引号；**纯数字（`-5`、`1.2e3`）放过不动**，免得把正常数字变成文本。

### A5 `</script>` 截断 —— 中 · 已修

- **定位**：`import_backup.mjs` 生成的 `DM_*.js` 数据文件。
- **根因**：数据以 `window.DM_xxx = {...}` 形式内联进 `<script>`，正文里只要出现 `</script>`，
  就会提前闭合标签，后面的内容变成 HTML —— 轻则页面错乱，重则注入。
- **修复**：生成时把 `<` 统一转成 `\u003c`（JS 字符串里完全等价，但不再是标签边界）。

### A6 上传文件名路径穿越 —— 高 · 已修

- **定位**：`server.mjs /api/import/upload`。
- **根因**：文件名取自请求头 `x-dm-filename`，直接拼进 `imports/<name>`。
  传 `../../evil.zip` 就能写到工作区**外面**去。
- **修复**：`path.basename()` 之后过 `safeSegment()`，再统一补 `.zip`（顺手修掉 `xxx.zip.zip` 的叠加）。

### A7 zip 炸弹 / 超大包 —— 中 · 已修

- **定位**：`scripts/lib/zip.mjs` 的 `readZip()`。
- **根因**：解压循环没有总量和条目上限，一个几百 KB 的包可以解出几十 GB（zip bomb），直接把磁盘写满。
- **修复**：解压总量上限 2 GB、条目上限 2 万，超了就报错中止；单条目 > 4 GB 也报错（uint32 头会溢出）。
  另外 `readZip` 外包了一层友好报错，不再把 zlib 的原始异常抛给用户。

### A8 调试端口 `--remote-allow-origins=*` —— 中风险 · **保留**

- **定位**：`scripts/login.mjs` 启动 Chrome 时的参数。
- **风险**：CDP 端口只监听 127.0.0.1（外网连不上），但**同机的任意网页**都能连上来操作那个浏览器
  （读 Cookie、以你的登录态发请求）。本机单用户场景下实际可被利用的窗口很窄。
- **为什么不现在改**：收紧需要同时改 CDP 客户端的 Origin 校验 + 对登录流程做完整回归，
  改动面超出"加固"范畴，风险反而更大。代码里已注释标注。
- **规避**：只在需要扫码登录时开那个浏览器窗口，登完就关；不要在登录期间逛来路不明的网页。

---

## 二、资源泄漏（5 项，全部已修）

| 定位 | 根因 | 修复 |
|---|---|---|
| `lib/jobs.mjs` 取消任务 | 只 `kill()` 了直接子进程；`run_pipeline` 再 spawn 的**孙子进程**（python OCR 等）杀不掉，变孤儿常驻 | `killTree()`：Windows 上用 `taskkill /PID /T /F` 杀整棵进程树 |
| `lib/jobs.mjs` 淘汰逻辑 | 遍历时用 `break`，一旦前面几个任务都在跑就**永不淘汰**，任务表无限增长（内存泄漏） | 改成「先剔最老的**已结束**任务；全都还在跑才动最老的」，再加硬上限 `MAX_JOBS*2` 兜底 |
| `cdp_lib.mjs` 请求超时 | `setTimeout` 没 `unref()`，会把进程强行留活；请求返回后也没 `clearTimeout` | 定时器 `unref()` + 完成时 `clearTimeout` |
| `cdp_lib.mjs` WebSocket | 没挂 `error` 监听 —— Node 里未处理的 `error` 事件**直接崩掉调用方进程** | 挂 `error`（吞掉、交给紧随的 `close` 统一收尾）+ `close` 里 reject 掉所有 pending Promise |
| `login.mjs` 启动浏览器 | `spawn` 没挂 `error`，浏览器路径不对 / 被拦截时抛未捕获异常 | 挂 `p.on('error')`，打印可读的原因 |

---

## 三、崩溃与异常处理缺失（7 项，全部已修）

| 定位 | 根因 | 修复 |
|---|---|---|
| `server.mjs` 服务器级 error | 启动后任何一次连接异常都 `process.exit(1)` —— 一个坏请求就**干掉整个界面** | 启动后（`STARTED`）忽略连接级错误，只记日志 |
| `server.mjs` `buildState` | `readManifest()` 没 try/catch，sessions.json 稍有损坏就整个 state 500，页面白屏 | 包 try/catch，配置坏时返回空清单并在页面上说清 |
| `server.mjs` 文件下载 | `res` 上没有 `error` 监听，用户中途取消下载 → `ECONNRESET` 未捕获 | `pipeFile()` 统一文件输出，吞掉连接类错误 |
| `run_pipeline.mjs` 退出 | 直接 `process.exit()` —— 管道里还没写出去的日志会被**截断**，WebUI 上看到半截日志 | 重构为 `async main()` + `process.exitCode`；只读导入的拦截也改用 `return 4` |
| `run_pipeline.mjs` 只读拦截 | 顶层 `process.exit(4)`，与上一条同源的截断问题 | 挪进 `main()` 用返回值（文件里仅剩同步阶段的 `findSession` 失败一处直接 exit，已注释说明安全） |
| `lib/paths.mjs` `dirStat` | 递归统计没有深度上限，遇到循环符号链接 / 超深目录会爆栈 | 加 `maxDepth = 64` |
| `lib/zip.mjs` `writeZip` | 把整个 zip 攒在一个 Buffer 里，导出大备份时直接吃满内存 | 改成**流式落盘**（循环 `writeSync`，处理短写） |

---

## 四、边界与输入校验（4 项，全部已修）

| 定位 | 问题 | 修复 |
|---|---|---|
| `server.mjs` 请求体 | `readBody` 没有大小上限，超大 body 会吃满内存 | 超限返回 413 |
| `server.mjs` 上传 | 上传内容整块读进内存再写盘 | `saveBody()` 改为**流式落盘**，边收边写 |
| `server.mjs` 上传名 | `x.zip` 会被叠成 `x.zip.zip` | 先剥掉已有 `.zip` 后缀再补 |
| 测试残留 | 回归跑完 `imports/` 里留下一堆假包 | 跑完按名字清理测试包（`empty/` `evil-pwn/` `not-a-backup/` `shared-backup/`） |

---

## 五、性能（2 项，全部已修）

| 定位 | 问题 | 修复 |
|---|---|---|
| `server.mjs` `/api/state` | 页面每 20 秒轮询一次，每次都**递归 stat 几千个文件**算会话体积 | 加 8 秒缓存（`STAT_CACHE`），命中直接返回副本 |
| `lib/zip.mjs` | 见上（攒大 Buffer） | 流式落盘 |

---

## 六、测试侧的修复（顺带发现一个"假故障"）

- **`verify_extras` 的 `doctor --json 可执行` 恒失败 —— 是测试写错了，不是 bug。**
  `doctor` 用**退出码表达"查出几个问题"**（0 = 没毛病，1 = 有 error）。真实数据里 B站有 1 张图缺失，
  退出码恒为 1，于是断言 `code === 0` 永远红。已改成「0/1 都算正常（>1 才是真崩）+ 输出是合法 JSON + 有 summary/sessions」。
- **真实数据隐患（低风险，与本次代码无关）**：`doctor` 报 B站 `bili/images/card_u4oc9m.webp` 缺图，
  且 `ocr.json` 里有对应的孤儿键。不影响任何功能（`fixable: 0`，需人工补图或清键），留给后续单独处理。
- `verify_webui` 新增「7.5 安全防线」**22 条断言**（129 → 151），把上面每一道闸都钉住，防止以后被改回去：
  下载白名单 / `../` 穿越 / 凭据文件双出口 / 上传文件名越狱 / `safeSegment` / `csvCell` / `safeUrl`。

---

## 七、还没做的（明确列出）

1. **A8 CDP 调试端口**（中风险，见上）—— 需要改 CDP 客户端 + 登录回归，暂保留。
2. **B站缺图 1 张 + OCR 孤儿键**（低风险，数据问题）。
3. **接口速率限制**：未做。判断为可接受 —— 服务只监听 127.0.0.1、单用户本机使用，且写接口要求
   自定义头 `X-DM-WebUI: 1` + 同源 `Origin`，已挡住浏览器侧的 CSRF。若以后要暴露到局域网，**必须先加限速和鉴权**。
4. **旧脚本未在本轮范围**：`sync_faces.mjs` / `fetch_*.mjs` 等既有抓取脚本本次未逐行审计（本轮聚焦 WebUI 新增链路）。
