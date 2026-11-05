/**
 * OCR 状态（**只读**）—— 给 WebUI 那个独立的「识别图片文字」按钮用
 * ==============================================================
 * 这里只数文件、不启动任何识别、也不读消息正文：
 *   · 环境是否就绪 = `.ocr-env/Scripts/python.exe` 在不在
 *   · 待识别数     = images/ 下符合口径的图片 − ocr.json 里已有 `t` 的条目
 *
 * 口径必须和 `scripts/image_ocr.py` 的 `targets()` 完全一致：
 *   skip 前缀（会话清单里配的优先）、图片扩展名、`t is not None` 才算已处理。
 * 对不上会让按钮显示「还有 3 张」、点下去却报「没有需要处理的图片」。
 *
 * ⚠ 导入的他人备份一律排除（只读，不许对它跑 OCR）——和
 *   `run_pipeline.mjs` 的 `rejectWritingOnImported()` 是同一条防线。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadSessions } from '../sessions.mjs';

const DEF_SKIP = {
  weibo: ['pic_', 'emoji_', 'avatar_'],
  bili: ['face_', 'avatar_', 'emoji_'],
};
const EXT = /\.(jpg|jpeg|png|webp|bmp)$/i;

/** 项目自带的隔离环境；不在就说明 OCR 还没装 */
export function ocrPython() {
  return path.join(ROOT, '.ocr-env', 'Scripts', 'python.exe');
}
export function ocrEnvReady() {
  return fs.existsSync(ocrPython());
}

/** 单个会话的图片 / 已识别 / 待识别数 */
export function ocrPending(s) {
  const dir = path.join(ROOT, s.dir, 'images');
  const skip = (Array.isArray(s.skip) && s.skip.length)
    ? s.skip : (DEF_SKIP[s.platform] || []);
  let ocr = {};
  try {
    ocr = JSON.parse(fs.readFileSync(path.join(ROOT, s.dir, 'ocr.json'), 'utf8')) || {};
  } catch { /* 没有索引 = 一张都没识别过 */ }
  const imgs = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => !skip.some((p) => f.startsWith(p)) && EXT.test(f))
    : [];
  const done = imgs.filter((f) => ocr[f] && ocr[f].t != null).length;
  return { images: imgs.length, done, pending: imgs.length - done };
}

/** 汇总给前端：不含任何昵称 / uid / 消息内容，只有数字和会话 key */
export function ocrStatus() {
  const sessions = loadSessions()
    .filter((s) => !s.imported)
    .map((s) => ({ key: s.key, label: s.label, platform: s.platform, ...ocrPending(s) }));
  return {
    ready: ocrEnvReady(),
    sessions,
    totalPending: sessions.reduce((n, s) => n + s.pending, 0),
  };
}
