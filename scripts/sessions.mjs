#!/usr/bin/env node
/**
 * 会话清单读取器（多会话支持）
 * ===============================================================
 * 唯一数据源是项目根的 sessions.json。查看页、更新脚本、图片索引脚本
 * 全部从这里读同一份清单，避免「页面认识这个会话、脚本不认识」的错位。
 *
 * 归一化规则（json 里能省的都省掉）：
 *   · globals 缺省 → 按 key 生成 DM_DATA_<KEY> / DM_FACES_<KEY> / DM_OCR_<KEY> / DM_VLM_<KEY>
 *     ⚠ weibo / bili 用的是历史短名（DM_DATA / DM_DATA_B …），在 sessions.json 里
 *       显式写死了。查看备份.html 的静态 <script> 标签就是按这两个名字加载的，
 *       改名会让页面读不到数据 —— 别动它们。
 *   · builtin 缺省 → key 是否属于 STATIC_KEYS
 *   · title / empty → 按 label / dir 生成
 *   · skip → 按 platform 给默认值
 */
import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');
// 可用 DM_SESSIONS_JSON 指向别的清单文件 —— 只有回归测试会用到这个开关
export const MANIFEST_PATH = process.env.DM_SESSIONS_JSON
  ? path.resolve(process.env.DM_SESSIONS_JSON)
  : path.join(ROOT, 'sessions.json');

/** 查看备份.html 里已有静态 <script> 标签的两个来源，全局名不能改 */
export const STATIC_KEYS = ['weibo', 'bili'];

export const PLATFORMS = ['weibo', 'bili'];

const DEFAULT_SKIP = {
  weibo: ['pic_', 'emoji_', 'avatar_'],
  bili: ['face_', 'avatar_', 'emoji_'],
};

/**
 * 历史遗留的全局名。weibo / bili 的数据文件在 查看备份.html 里是用静态
 * <script> 标签加载的，标签里写的就是这两个短名字 —— 所以就算 sessions.json
 * 没写 globals，也必须落到这里，不能落到下面自动生成的长名字上。
 */
const HISTORICAL_GLOBALS = {
  weibo: { data: 'DM_DATA', faces: 'DM_FACES', ocr: 'DM_OCR', vlm: 'DM_VLM' },
  bili: { data: 'DM_DATA_B', faces: 'DM_FACES_B', ocr: 'DM_OCR_B', vlm: 'DM_VLM_B' },
};

export function globalsFor(key) {
  const K = String(key).toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return {
    data: 'DM_DATA_' + K, faces: 'DM_FACES_' + K,
    ocr: 'DM_OCR_' + K, vlm: 'DM_VLM_' + K,
  };
}

/** 缺省全局名：内置两个走历史短名，其余按 key 自动生成 */
export function defaultGlobals(key) {
  return HISTORICAL_GLOBALS[key] || globalsFor(key);
}

/** sessions.json 整个文件不见了时的兜底（保持「没它也能跑」的老行为） */
const FALLBACK_SESSIONS = [
  { key: 'weibo', label: '微博', dir: 'data', platform: 'weibo' },
  { key: 'bili', label: 'B站', dir: 'bili', platform: 'bili' },
];

export function readManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    return { _meta: { fallback: true }, sessions: FALLBACK_SESSIONS };
  }
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
}

/** 读清单 → 归一化后的会话数组。任何非法配置都抛错（宁可报错，不要静默降级）。 */
export function loadSessions() {
  const man = readManifest();
  const raw = Array.isArray(man.sessions) ? man.sessions : [];
  const seen = new Set();
  const out = [];

  for (const s of raw) {
    if (!s || typeof s !== 'object') continue;
    const key = String(s.key || '').trim();
    if (!key) throw new Error('sessions.json：有条目缺少 key');
    if (!/^[A-Za-z0-9_]+$/.test(key)) {
      throw new Error('sessions.json：key「' + key + '」只能含字母 / 数字 / 下划线');
    }
    if (seen.has(key)) throw new Error('sessions.json：key「' + key + '」重复');
    seen.add(key);

    const dir = String(s.dir || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
    if (!dir) throw new Error('sessions.json：会话「' + key + '」缺少 dir');
    if (path.isAbsolute(dir) || dir.split('/').includes('..')) {
      throw new Error('sessions.json：会话「' + key + '」的 dir 必须是项目内的相对路径');
    }

    const platform = s.platform || (STATIC_KEYS.includes(key) ? key : 'weibo');
    if (!PLATFORMS.includes(platform)) {
      throw new Error('sessions.json：会话「' + key + '」的 platform「' + platform +
                      '」不认识（只支持 ' + PLATFORMS.join(' / ') + '）');
    }

    const label = s.label || key;
    const builtin = (typeof s.builtin === 'boolean') ? s.builtin : STATIC_KEYS.includes(key);
    const auto = defaultGlobals(key);
    const g = s.globals || {};
    const peer = (s.peer && typeof s.peer === 'object') ? s.peer : {};
    const self = (s.self && typeof s.self === 'object') ? s.self : {};

    out.push({
      key, label, dir, platform, builtin,
      title: s.title || (label + '私信备份'),
      /**
       * peer = 要备份的那个聊天对象；self = 自己（可留空，能自动探测的会自己探）。
       * ⚠ 这两项是老版本写死在 update.mjs / bili_update.mjs 顶部的常量，
       *   现在一律从这里读 —— 分享给他人时，只有这个文件需要改。
       */
      peer: {
        uid: String(peer.uid == null ? '' : peer.uid).trim(),
        name: String(peer.name == null ? '' : peer.name).trim(),
      },
      self: {
        uid: String(self.uid == null ? '' : self.uid).trim(),
        name: String(self.name == null ? '' : self.name).trim(),
      },
      globals: {
        data: g.data || auto.data,
        faces: g.faces || auto.faces,
        ocr: g.ocr || auto.ocr,
        vlm: g.vlm || auto.vlm,
      },
      // builtin=true 的走 查看备份.html 里的静态标签；其余由页头注入脚本按这里的路径插入
      files: builtin ? null : {
        messages: dir + '/messages.js',
        faces: dir + '/faces.js',
        ocr: dir + '/ocr.js',
        vlm: dir + '/vlm.js',
      },
      skip: (Array.isArray(s.skip) && s.skip.length) ? s.skip : (DEFAULT_SKIP[platform] || []),
      autoReply: s.autoReply || '',
      /**
       * 「导入的他人备份」标记。
       * ⚠ 这几个字段**必须原样带出来**：`imported` 是只读保护的总开关，
       *   下游好几处都靠它（WebUI 的抓取/登录拒绝、run_pipeline 的写步骤拒绝）。
       *   曾经这里漏掉过 —— 归一化时被丢掉，于是 `if (S.imported)` 永远是 false，
       *   保护看起来在、其实一条都没生效（跑验证脚本才发现抓取能对导入目录下手）。
       *   新增字段时请一并在这里透传，别让"标记"死在归一化这一步。
       */
      imported: !!s.imported,
      readonly: !!s.readonly,
      importBatch: s.importBatch || '',
      importedFrom: s.importedFrom || '',
      importedAt: s.importedAt || '',
      empty: s.empty ||
        ('未找到数据文件 <code>' + dir + '/messages.js</code><br>请先运行一次对应的更新脚本'),
    });
  }
  return out;
}

export function findSession(key) {
  const list = loadSessions();
  const s = list.find(x => x.key === key);
  if (!s) {
    throw new Error('不认识会话「' + key + '」。sessions.json 里现有：' +
                    (list.map(x => x.key).join(' / ') || '（空）'));
  }
  return s;
}

/** 从 argv 里取 --session 的值（缺省 defaultKey） */
export function sessionFromArgs(argv, defaultKey = 'weibo') {
  const i = argv.indexOf('--session');
  if (i < 0) return defaultKey;
  const v = argv[i + 1];
  if (!v || v.startsWith('--')) {
    throw new Error('--session 后面要跟会话 key，例如 --session bili');
  }
  return v;
}

/**
 * 取「聊天对象」的 uid；没配就抛一条**照着做就能修好**的错。
 *
 * 这一条是「可分享」的关键：开源 / 分享出去的版本**不预置任何 uid**，
 * 换了账号或换了电脑，必须由使用者自己填。宁可启动时明确报错，
 * 也不要静默抓成空数据（那会让人以为「跑通了」）。
 */
export function requirePeerUid(s) {
  if (!s.peer || !s.peer.uid) {
    throw new Error(
      'sessions.json：会话「' + s.key + '」还没配 peer.uid —— 也就是「要备份谁的私信」。\n' +
      '  请编辑项目根的 sessions.json，在该会话里补上（uid = 对方的数字 ID）：\n' +
      '      "peer": { "uid": "<对方的 uid / mid>", "name": "<对方的名字>" }\n' +
      '  微博：对方主页地址里的数字，如 weibo.com/u/1234567890 → 1234567890\n' +
      '  B站：对方空间地址里的数字，如 space.bilibili.com/1234567 → 1234567'
    );
  }
  return s.peer.uid;
}

/** 会话的数据目录骨架（--mkdir 用） */
export function sessionDirs(s) {
  return [s.dir, s.dir + '/images', s.dir + '/faces', s.dir + '/raw'];
}

/**
 * 取对方 uid；没配就**干净地**打印一条照着做就能修好的提示并退出。
 *
 * 为什么不直接让 requirePeerUid 抛错：分享出去之后，用户是**双击 .cmd** 跑的，
 * 一个未捕获异常会甩出十几行 Node 堆栈，真正有用的那两行提示会被淹掉，
 * 看起来就像「程序崩了」。所以这里自己收口，退出码用 4（与既有的
 * 2=没登录凭据 / 3=登录态失效 区分开，启动器 .ps1 会认这个码）。
 */
export function peerUidOrExit(s) {
  try {
    return requirePeerUid(s);
  } catch {
    const L = (m) => console.error(m);
    L('');
    L('==========================================================');
    L('  还没有配置「要备份谁的私信」—— 这是第一次使用时的必填项');
    L('==========================================================');
    L('  会话        ' + s.key + '（' + s.label + '）');
    L('  要改的文件  ' + MANIFEST_PATH);
    L('');
    if (!fs.existsSync(MANIFEST_PATH)) {
      // 仓库里刻意**不带** sessions.json：填过真实 uid 之后它就是一份个人身份数据。
      L('  ⚠ 这个文件现在还不存在（仓库里不预置，避免误把真实 uid 推上去）。');
      L('    先从模板复制一份出来，再往下填：');
      L('');
      L('      复制  ' + path.join(ROOT, 'scripts', '_skill', 'sessions.template.json'));
      L('      到    ' + MANIFEST_PATH);
      L('');
      L('    （模板里每个字段都写了说明，照着改就行）');
      L('');
    }
    L('  用记事本打开上面这个 sessions.json，找到 "' + s.key + '" 那一节，把 peer 填上：');
    L('');
    L('      "peer": { "uid": "<对方的数字 ID>", "name": "<对方昵称>" }');
    L('');
    L('  这串数字在哪找：');
    L('    微博   打开对方主页，地址栏 weibo.com/u/1234567890  →  1234567890');
    L('    B站    打开对方空间，地址栏 space.bilibili.com/1234567  →  1234567');
    L('');
    L('  填完保存 → 双击「命令/配置与定时/生成会话清单.cmd」→ 再重新运行本程序。');
    L('==========================================================');
    L('');
    process.exit(4);
  }
}
