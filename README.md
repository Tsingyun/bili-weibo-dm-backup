# 微博 / B站 私信备份

把私信完整备份到本机 —— 文字、图片、表情、卡片、**撤回原文**都留下，
做成一个双击就能翻的**离线网页**，再配上按天互动统计、本地全文检索、
图片文字识别与内容描述、导出与分享。

全程只在本机运行：不经过任何第三方服务器，不保存账号密码，不上传任何数据。

`零第三方依赖` · `Node ≥ 22` · `Windows` · `数据不出本机`

---

## 目录

- [功能特性](#功能特性)
- [安装与使用](#安装与使用)
- [目录结构](#目录结构)
- [技术栈](#技术栈)
- [示例](#示例)
- [使用文档](#使用文档)
- [隐私与安全](#隐私与安全)

---

## 功能特性

### 备份

| 能力 | 说明 |
|---|---|
| 双平台 | 微博与 B站各自独立的数据目录（`data/` · `bili/`），互不干扰 |
| 三种抓取模式 | 增量（只补新的）· 全量（翻完历史）· 全量重建（按新规则重抓） |
| 多会话 | 一份数据里放多个聊天对象，各自独立的目录与索引 |
| 时间范围 | `--since` / `--until`，早于起始时间自动停止翻页 |
| 原子与可回溯 | 全量重建前自动备份 `messages.bak.json`；索引可打快照并回滚 |
| 图片与表情 | 下载原图、同步官方表情图、保留 GIF 与头像 |

### 查看

| 能力 | 说明 |
|---|---|
| 离线查看页 | 双击 `查看备份.html`，顶部切换「微博 / B站」 |
| 按天互动统计 | 折线图、热力图、发言节律（星期 × 时段） |
| 完整保留原始形态 | 撤回消息原文、卡片消息、系统提示、表情、语音、视频 |
| 隐藏单条消息 | 右键菜单逐条隐藏；也可一键隐藏全部自动回复 |
| 「一天」的口径 | 以 **当天 05:00 → 次日 05:00** 为一天，符合夜猫子作息 |

### 检索与 AI（可选）

| 能力 | 说明 |
|---|---|
| 本地全文检索 | SQLite **FTS5**（trigram），中文可搜；短词自动回退 LIKE |
| 图片文字识别 | OCR 索引，搜到图里的文字（`命令/图片与OCR/安装OCR环境.cmd` 一键装） |
| 图片内容描述 | 视觉模型生成图片描述，支持「以图搜图 / 相似图」 |
| 全部本地落盘 | 索引就是本机几个 `.json` + 一个 `.db`，可随时重建 |

### 导出与分享

| 格式 | 用途 |
|---|---|
| `jsonl` / `json` | 喂给别的工具或脚本 |
| `csv` | Excel 打开（已处理逗号、换行、公式注入） |
| `md` | 纯文本归档，给人或 AI 读 |
| `html` | 单文件网页，双击就能翻 |
| `bundle.zip` | **分享给别人**：含消息 + 图片 + 索引 + 说明，对方拖进第 5 步即可浏览 |

导出支持时间窗、按类型筛选、**一键打码**（手机号 / 邮箱 / 身份证 / 银行卡 / 地址）。

### 自动化

| 能力 | 说明 |
|---|---|
| 定时自动更新 | Windows 计划任务，默认**每周一 08:00**，两平台各 6 步跑完整链路 |
| 一键体检 | 索引与磁盘对账、js/json 一致性、图片缺失、依赖检查 |
| 自动修复 | `doctor --fix` 重生成 js 包装、清理索引里的孤儿键 |

### 图形界面（WebUI）

本机 `127.0.0.1` 上的 7 步引导：环境检查 → 授权登录 → 选会话 → 选范围备份 →
加载他人备份 → 导出 → 查看与维护。实时日志、任务可停止、
**勾多个平台会串行依次备份**，自动登录走不通时还能手动粘 Cookie。

---

## 安装与使用

### 前置要求

| 项 | 要求 | 说明 |
|---|---|---|
| 系统 | Windows 10 / 11 | 启动器与计划任务是 `.cmd` / `.ps1`；脚本本身是跨平台的 Node |
| Node.js | **≥ 22** | 用到内置 `node:sqlite`，无需任何第三方包 |
| 浏览器 | Edge 或 Chrome | 登录时开一个**专用窗口**（独立配置目录），程序只读 Cookie |
| Python | 3.11+（可选） | 仅 OCR / 图片描述 / 图片压缩需要 |

> **不需要 `npm install`** —— 项目零第三方依赖，克隆下来就能跑。

### 快速开始

```bash
git clone https://github.com/Tsingyun/bili-weibo-dm-backup.git
cd bili-weibo-dm-backup
```

1. **配置要备份谁**：仓库里**故意不带** `sessions.json`（填过真实 uid / 昵称后它就是个人身份数据），
   先从模板复制一份出来，再填对方的数字 ID（uid）—— 别填昵称，昵称会变、uid 不会：

   ```bash
   copy scripts\_skill\sessions.template.json sessions.json
   ```

   编辑 `sessions.json` 把 `peer.uid` 填上，然后双击 `命令/配置与定时/生成会话清单.cmd`。
2. **登录**：双击 `命令/备份与更新/更新备份.cmd`（微博）或 `命令/备份与更新/更新B站备份.cmd`（B站），
   在弹出的浏览器窗口里正常登录一次，程序只把 Cookie 读回本地。
3. **查看**：双击 `查看备份.html`。

想用图形界面就双击 **`命令/查看与导出/启动WebUI.cmd`**，跟着 7 步走，全程不用碰命令行。

### 常用命令

```bash
命令/备份与更新/更新备份.cmd           # 微博 · 增量更新
命令/备份与更新/重建备份.cmd           # 微博 · 全量重建
命令/备份与更新/更新B站备份.cmd        # B站 · 增量更新
命令/查看与导出/重建搜索索引.cmd       # 数据更新后重建本地检索索引
命令/查看与导出/搜索备份.cmd           # 交互式全文检索
命令/查看与导出/导出JSONL.cmd          # 导出聊天记录
命令/图片与OCR/压缩图片.cmd           # 图片转 WebP（会先确认一次 Y/N）
命令/配置与定时/注册定时更新.cmd       # 注册「每周一 08:00 自动更新」
命令/查看与导出/启动WebUI.cmd          # 图形界面
```

等价的 Node 命令（不依赖 `.cmd` 启动器）：

```bash
node scripts/update.mjs --session weibo            # 微博抓取
node scripts/run_pipeline.mjs --session bili --mode incr
node scripts/build_fts.mjs                         # 重建检索索引
node scripts/doctor.mjs                            # 体检
node scripts/doctor.mjs --fix --dry-run            # 先看会修什么
node scripts/server.mjs                            # 起 WebUI
```

---

## 目录结构

```
bili-weibo-dm-backup/
├─ 查看备份.html              离线查看页（双击打开）
├─ 命令/                     全部启动器，按用途分 4 类
│  ├─ 备份与更新/            更新备份 · 重建备份 · 更新B站备份 · 重建B站备份
│  ├─ 查看与导出/            启动WebUI · 搜索备份 · 重建搜索索引 · 索引快照 · 导出JSONL · 导出表情包
│  ├─ 图片与OCR/             压缩图片 · 安装OCR环境 · 卸载OCR环境
│  └─ 配置与定时/            生成会话清单 · 注册定时更新 · 取消定时更新
├─ sessions.json             会话清单：要备份谁（唯一数据源）
├─ sessions.js               由上一行生成，供查看页读取
├─ scripts/                  Node 脚本（抓取 / 索引 / 导出 / 体检 / WebUI）
│  ├─ update.mjs            微博主流程
│  ├─ bili_update.mjs       B站主流程
│  ├─ msg_kind.mjs          消息分类与打码口径
│  ├─ build_fts.mjs         SQLite FTS5 检索索引
│  ├─ snapshot.mjs          索引快照与回滚
│  ├─ doctor.mjs            一键体检（--fix 自动修复）
│  ├─ login.mjs             授权登录（开专用浏览器 → 只读 Cookie）
│  ├─ server.mjs            WebUI 服务端（只监听 127.0.0.1）
│  ├─ run_pipeline.mjs      一条命令跑完整链路
│  ├─ lib/                  服务端共用模块（路径 / 任务流 / zip / 导出 / 导入）
│  └─ _explore/             逆向接口时的探测脚本（备查，可删）
├─ data/                    微博数据集（消息 / 图片 / 索引 / Cookie）
├─ bili/                    B站数据集（结构与 data/ 一一对应）
├─ search/                  本地检索库（SQLite）
├─ snapshots/               索引快照
├─ exports/ imports/ imported/   导出产物 / 待导入 / 已导入（只读）
├─ 使用说明.md              完整使用手册（功能 / 口径 / 常见问题）
├─ 文档/                    补充说明：定时自动更新 / WebUI / WebUI安全审计 /
│                           图片搜索方案 / 备份与体检修复 / 登录校验排查 / 方案评估报告
└─ .gitignore               ⚠ 私信数据与登录凭据一律不入库
```

> `data/` `bili/` `search/` `exports/` `imports/` `imported/` `snapshots/`
> 全部在 `.gitignore` 里 —— **仓库里只有代码和文档，没有一条真实私信**。

---

## 技术栈

| 层 | 用了什么 |
|---|---|
| 运行环境 | Node.js ≥ 22，**零第三方依赖**（只用内置模块） |
| 数据存储 | 纯文件：`messages.json` + 同名 `.js` 包装（供页面 `<script>` 直接读） |
| 全文检索 | SQLite **FTS5**（`node:sqlite`，trigram 分词，中文友好） |
| 抓取 | 平台 Web 接口 + 增量游标翻页；断点续抓 |
| 登录 | Chrome DevTools Protocol（CDP）：开专用配置目录的浏览器，只读 Cookie |
| 服务端 | `node:http` 手写路由；任务用 `child_process` 流式输出 + SSE 推送日志 |
| 压缩包 | 手写 zip 读写（UTF-8 标志位、拒绝 zip64 / 加密包） |
| 前端 | 原生 HTML / CSS / JS，无构建步骤、无框架 |
| 自动化 | Windows 计划任务（PowerShell） |
| 可选 AI | OCR：RapidOCR（本地 ONNX）· 图片描述：免费视觉模型 |

几个值得一提的取舍：

- **不引入数据库做消息存储** —— 私信量级（万级）用 JSON 足够，而且"能直接打开看"比性能重要；
  只有检索走 SQLite。
- **`.js` 与 `.json` 双份** —— 页面用 `<script src>` 读数据，因此 `file://` 直接双击可用，
  不需要起服务、不会被 CORS 拦。
- **登录只读 Cookie** —— 程序从不接触账号密码，也不接管你的日常浏览器。

---

## 示例

### 抓取并查看

```bash
node scripts/run_pipeline.mjs --session weibo --mode incr
node scripts/build_fts.mjs
node scripts/search.mjs 关键词        # 也可以双击 命令/查看与导出/搜索备份.cmd 用交互式
```

### 导出一段时间的聊天记录

```bash
node scripts/export_jsonl.mjs --session weibo --since 2026-06-01 --until 2026-06-30 --mask
# 或打开 WebUI → 第 6 步 → 先预览、再导出
```

### 数据结构（一条消息）

```json
{
  "id": "<msg_id>",
  "ts": 1750000000000,
  "time": "2026-06-22 21:03",
  "from": "peer",
  "type": "text",
  "text": "示例文本",
  "images": [
    { "kind": "photo", "fid": "<id>", "file": "<file>.jpg",
      "url": "https://...", "local": "images/<file>.jpg" }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `from` | `me` / `peer` |
| `type` | `text` · `image` · `link` · `card` · `video` · `emoji` · `voice` |
| `recalled` | 撤回消息保留原文，标记在这里 |
| `card` | 卡片消息：`kind` · `author` · `text` · `url` · `created` |
| `images[].local` | 本机相对路径，查看页据此直接加载图片 |

### 会话清单（`sessions.json`）

```json
{
  "sessions": [
    {
      "key": "weibo",
      "label": "微博",
      "platform": "weibo",
      "dir": "data",
      "peer": { "uid": "1234567890", "name": "" },
      "self": { "uid": "", "name": "" }
    }
  ]
}
```

改完双击 `命令/配置与定时/生成会话清单.cmd` 重新生成 `sessions.js` 即可。

---

## 使用文档

| 文档 | 内容 |
|---|---|
| [使用说明.md](使用说明.md) | 主手册：每一项功能怎么用、目录结构、数据口径、常见问题 |
| [WebUI说明.md](WebUI说明.md) | 图形界面的架构、模块划分、数据存储与踩过的坑 |
| [定时自动更新说明.md](定时自动更新说明.md) | 定时任务的触发时间 / 同步范围 / 存储 / 失败处理 |
| [图片搜索方案.md](图片搜索方案.md) | OCR 与图片描述的实现方案与取舍 |
| [WebUI安全审计.md](WebUI安全审计.md) | 本地服务的攻击面与 26 项修复清单 |
| [备份与体检修复说明.md](备份与体检修复说明.md) | 多平台串行备份、体检孤儿键自动修复 |
| [登录校验-连不上接口-排查与修复.md](登录校验-连不上接口-排查与修复.md) | 「连不上平台接口」的排查路径与结论 |

---

## 隐私与安全

* **数据不出本机**：所有脚本只读写本地文件，没有任何上传逻辑。
* **仓库里没有你的身份信息**：`sessions.json`（真实 uid / 昵称）与
  `scripts/_skill/personal_tokens.local.txt`（昵称变体清单）都**不入库**，
  仓库只放 `sessions.template.json` 模板；`data/` `bili/` `search/` `exports/` `imports/`
  `imported/` `snapshots/` `.edge-profile/` `.ocr-env/` 也全部忽略。
* **登录凭据等同密码**：`data/cookie_header.txt` / `bili/cookie_header.txt` 绝不分享、绝不上传；
  `.gitignore` 已把它连同 `data/` `bili/` 一起排除。
* **WebUI 只监听 `127.0.0.1`**：局域网内其它设备访问不到；
  写操作还要求一个自定义请求头（跨站请求带不上），防别有用心的网页指挥它。
* **导出物按"给别人看"设计**：支持打码；生成的 HTML / CSV 已做链接白名单与公式注入防护。
* **导入的他人备份是只读**：抓取、OCR、压缩等写操作对它一律拒绝。
* **打包成可分享 Skill 时会自动扫隐私**：`node scripts/build_skill.mjs --check`
  用 sessions 派生的清单 + 本地补充词表扫描产物，命中即失败。

## 免责声明

本项目用于备份**你自己有权访问的聊天记录**。请遵守相关平台的服务条款与当地法律法规，
不要用它抓取或传播他人的隐私信息。
