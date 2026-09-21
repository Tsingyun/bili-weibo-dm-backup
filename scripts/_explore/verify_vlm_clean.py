# -*- coding: utf-8 -*-
"""
描述清洗 + 免费模型降级链 回归测试
==================================
背景（2026-09-15）：
  智谱免费视觉模型 glm-4.6v-flash 高峰期持续返回 1305「访问量过大」，
  一批图干等退避，1 小时 45 分只成功 82/126。加入降级链后换用同样免费的
  glm-4v-flash，44 张 5.6 分钟全部完成。

  但 glm-4v-flash 的输出风格不同：
    · 用 markdown 写小标题（**关键词：** / - 列表），原清洗规则匹配不到
    · 会自我复读（美味佳肴、美味食物、美味佳肴…）一路写到 token 上限，
      单条最长 1,912 字，300 个关键词里只有 30 个是唯一的
    · 偶尔在开头带孤立引号

本脚本锁死清洗规则与降级链行为，防止再退化。

跑法：
  .ocr-env/Scripts/python.exe scripts/_explore/verify_vlm_clean.py
退出码 0 = 全过，1 = 有失败
"""
import os
import sys
import io
import json
import urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))

import image_vlm as V   # noqa: E402

PASS = [0]
FAIL = [0]


def chk(cond, name, detail=''):
    if cond:
        PASS[0] += 1
        print('  [ok] ' + name + ('   ' + detail if detail else ''))
    else:
        FAIL[0] += 1
        print('  [!!] ' + name + '   ' + detail)


# ------------------------------------------------- 1. 思考过程 / markdown 记号
print('[1] clean() 清掉模型的输出噪声')

t = V.clean('<think>用户说要用5个字，图中是纯玫红…</think>关键词：纯色背景\n纯玫红色块。')
chk('<think' not in t and '用户说' not in t, '整块吃掉 <think> 思考过程', repr(t[:30]))

t = V.clean('**关键词：**\n- 熟食、肉类、排骨\n\n**概括：**\n一盘切好的熟肉。')
chk('**' not in t and '-' not in t.split('\n')[0] and '关键词' not in t,
    '清掉 markdown 粗体与列表记号', repr(t[:46]))

t = V.clean('### 关键词：猫、草地\n一只橘猫。')
chk('###' not in t and '关键词' not in t, '清掉 ### 标题记号', repr(t[:40]))

t = V.clean('15~25个关键词：原神、雪山\n原神角色插画。')
chk('关键词' not in t, '清掉「15~25个关键词：」带数量的变体', repr(t[:40]))


# ------------------------------------------------- 2. 关键词去重与限量
print()
print('[2] 关键词去重 + 限量（模型复读的止损）')

loop = '、'.join(['美味佳肴、美味食物'] * 20)
t = V.clean(loop)
first = t.split('\n')[0]
kws = [p for p in first.split('、') if p]
chk(len(kws) == len(set(kws)), '去重后无重复词',
    f'{len(kws)} 个，唯一 {len(set(kws))} 个')
chk(len(kws) <= V.MAX_KW, f'关键词数不超过 MAX_KW={V.MAX_KW}', f'实际 {len(kws)} 个')

many = '、'.join(f'词{i}' for i in range(80))
t = V.clean(many)
chk(len([p for p in t.split('、') if p]) == V.MAX_KW,
    '超量关键词被截到上限', f'80 -> {len([p for p in t.split("、") if p])}')

# 不能误伤：正文里有句号的首行不算关键词表
keep = '女孩、毛绒玩具、广场、花盆。这是一句正文，不该被拆分。'
chk(V.clean(keep) == keep, '首行含句号时不做关键词切分', '')


# ------------------------------------------------- 3. 引号处理
print()
print('[3] 引号：只修噪声，不动正文')

chk(V._tidy_token("'蓝色背景") == '蓝色背景', '去掉开头的孤立 ASCII 引号', '')
chk(V._tidy_token('文字“45 w you”') == '文字“45 w you”',
    '中文引号原样保留（曾误删右引号）', repr(V._tidy_token('文字“45 w you”')))
chk(V._tidy_token('"quoted"') == 'quoted', '成对 ASCII 引号被剥掉', '')
chk(V._tidy_token('普通词') == '普通词', '普通词不受影响', '')


# ------------------------------------------------- 4. 长度上限
print()
print('[4] 描述限长')

long_kw = '、'.join(f'关键词{i}号' for i in range(60)) + '。' + '尾巴' * 200
t = V.clean(long_kw)
chk(len(t) <= V.MAX_DESC + 1, f'总长不超过 MAX_DESC={V.MAX_DESC}', f'实际 {len(t)} 字')

mid = V.clean('第一段关键词甲、乙、丙、丁。' + '正文' * 300)
chk(mid.endswith('…'), '截断处有省略号标记', repr(mid[-6:]))

short = '猫、狗、草地\n一只猫趴在草地上。'
chk(V.clean(short) == short, '短描述不被改动（无副作用）', '')


# ------------------------------------------------- 5. 免费模型降级链
print()
print('[5] 免费模型降级链')

FREE = {'glm-4.6v-flash', 'glm-4v-flash', 'glm-4.1v-thinking-flash'}
chk(set(V.FREE_MODELS) <= FREE, '降级链只用官方定价页标注「免费」的模型',
    ' / '.join(V.FREE_MODELS))
chk(V.FREE_MODELS[0] == 'glm-4.6v-flash', '首选仍是质量最好的 glm-4.6v-flash', '')
chk(len(V.FREE_MODELS) >= 2, '至少有一个备用模型可用', f'{len(V.FREE_MODELS)} 个')


# ------------------------------------------------- 6. 429 时真的会换模型
print()
print('[6] describe() 遇 429 自动换模型')

calls = []
_orig_call, _orig_encode, _orig_interval = V.call_api, V.encode, V.MIN_INTERVAL


def fake_encode(path, maxside=None, quality=None):
    return 'QUJD', 1234, (800, 600)


def make_call(fail_first):
    def _call(key, b64, model, prompt):
        calls.append(model)
        if fail_first and model == 'model-A':
            raise urllib.error.HTTPError(
                'u', 429, 'rate limited', {},
                io.BytesIO(b'{"error":{"code":"1305","message":"busy"}}'))
        return {'choices': [{'message': {'content': '关键词：猫、狗\n一只猫。'}}],
                'usage': {'total_tokens': 12}}
    return _call


try:
    V.encode = fake_encode
    V.MIN_INTERVAL = 0.0
    V.RETRY = 4
    V._MODELS[0] = ['model-A', 'model-B']

    calls.clear()
    V.call_api = make_call(fail_first=True)
    ent = V.describe('k', 'x.jpg')
    chk(calls == ['model-A', 'model-B'], '429 后换到链上的下一个模型', ' -> '.join(calls))
    chk(ent['m'] == 'model-B', '条目如实记录实际出结果的模型', ent['m'])
    chk(ent['d'].startswith('猫、狗'), '换模型后拿到的描述正常入库', repr(ent['d'][:20]))

    calls.clear()
    V.call_api = make_call(fail_first=False)
    ent2 = V.describe('k', 'x.jpg')
    chk(calls == ['model-A'] and ent2['m'] == 'model-A',
        '首选模型正常时不切换（每张都从链首开始）', ' -> '.join(calls))
finally:
    V.call_api, V.encode, V.MIN_INTERVAL = _orig_call, _orig_encode, _orig_interval
    V._MODELS[0] = list(V.FREE_MODELS)


# ------------------------------------------------- 7. 线上索引体检
print()
print('[7] 线上 vlm.json 体检')
p = os.path.join(ROOT, 'data', 'vlm.json')
if os.path.exists(p):
    d = json.load(open(p, encoding='utf-8'))
    ks = [k for k in d if not k.startswith('_')]
    bad = [k for k in ks
           if any(x in ((d[k] or {}).get('d') or '')
                  for x in ('关键词：', '概括：', '<think', '**'))]
    chk(not bad, '索引里没有残留的小标题/markdown 记号', f'{len(bad)} 条命中')
    over = [k for k in ks if len((d[k] or {}).get('d') or '') > V.MAX_DESC + 1]
    chk(not over, '没有超出长度上限的描述', f'{len(over)} 条超长')
    empty = [k for k in ks if not ((d[k] or {}).get('d') or '').strip()]
    chk(not empty, '没有空描述', f'{len(empty)} 条为空')
    print(f'       （当前 {len(ks)} 条，有描述 {len(ks) - len(empty)} 条，'
          f'_meta.engine = {d["_meta"]["engine"]}）')
else:
    chk(False, 'vlm.json 存在', p)

print()
print('=' * 36)
print(f'通过 {PASS[0]} 项，失败 {FAIL[0]} 项')
sys.exit(1 if FAIL[0] else 0)
