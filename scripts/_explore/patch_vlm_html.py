# -*- coding: utf-8 -*-
"""把 VLM 图片描述索引接进 查看备份.html（每处替换都断言唯一，防误改）"""
import os
import shutil
import time

P = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))), '查看备份.html')
src = open(P, encoding='utf-8').read()
orig = src
reps = []

# ---- 1) 引入 vlm.js ----
reps.append((
    '<script src="data/ocr.js" onerror="window.__ocrMissing=1"></script>',
    '<script src="data/ocr.js" onerror="window.__ocrMissing=1"></script>\n'
    '<script src="data/vlm.js" onerror="window.__vlmMissing=1"></script>'
))

# ---- 2) OCR 索引块之后，追加 VLM 索引块 ----
reps.append((
    """    if(parts.length) m._ocr = parts.join(' ');
  });

  document.getElementById('title')""",
    """    if(parts.length) m._ocr = parts.join(' ');
  });

  /* ---------- 图片内容描述索引（VLM）----------
     数据来自 data/vlm.js；只对「OCR 没识别到文字的图片」生成（截图不上云），
     同样可选：文件缺失时其它功能一切照常。 */
  var VLM = (window.DM_VLM || {});
  var VLM_KEYS = Object.keys(VLM).filter(function(k){ return k !== '_meta'; });
  var vlmWithDesc = VLM_KEYS.filter(function(k){ return (VLM[k]||{}).d; }).length;
  ALL.forEach(function(m){
    var vs = [];
    (m.images||[]).forEach(function(im){
      if(!im.local) return;
      var v = VLM[im.local.split('/').pop()];
      if(v && v.d){
        var s = String(v.d).replace(/\\s+/g, ' ').trim();
        if(s){ im._vlmt = s; vs.push(s); }
      }
    });
    if(vs.length) m._vlm = vs.join(' ');
  });

  document.getElementById('title')"""
))

# ---- 3) 搜索范围加入 VLM 描述 ----
reps.append((
    """    var s = (m.text||'') + ' ' + (m.sender||'') + ' ' + (m.type||'') + ' ' + (m._ocr||'');""",
    """    var s = (m.text||'') + ' ' + (m.sender||'') + ' ' + (m.type||'') + ' ' +
            (m._ocr||'') + ' ' + (m._vlm||'');"""
))

# ---- 4) 顶部统计：加「描述」张数 ----
reps.append((
    """    (ocrWithText ? '<span class="s4">已索引图片文字 <b>' + ocrWithText.toLocaleString() + '</b> 张</span>' : '');""",
    """    ((ocrWithText || vlmWithDesc)
       ? '<span class="s4">图片可搜索 <b>' + (ocrWithText + vlmWithDesc).toLocaleString() +
         '</b> 张（文字 ' + ocrWithText.toLocaleString() + ' · 描述 ' +
         vlmWithDesc.toLocaleString() + '）</span>' : '');"""
))

# ---- 5) CSS：内容描述命中的描边色（与图内文字区分） ----
reps.append((
    ".imgs img.ocrhit{outline:2px solid var(--c-me);outline-offset:1px}",
    ".imgs img.ocrhit{outline:2px solid var(--c-me);outline-offset:1px}\n"
    ".imgs img.vlmhit{outline:2px solid var(--c-peer);outline-offset:1px}"
))

# ---- 6) 公共截断函数（图内文字与图片描述共用） ----
reps.append((
    "  function haystack(m){",
    """  function around(s, p, qlen){
    var a = Math.max(0, p - 14), b = Math.min(s.length, p + qlen + 14);
    return (a > 0 ? '…' : '') + s.slice(a, b) + (b < s.length ? '…' : '');
  }

  function haystack(m){"""
))

# ---- 7) 图片渲染：命中图内文字 → 蓝色；命中内容描述 → 粉色 ----
reps.append((
    """        // 命中图内文字时：给图片描边，并把这句文字显示出来
        var tip = '';
        var q = st.q.trim();
        if(q && im._ocrt){
          var p = im._ocrt.toLowerCase().indexOf(q.toLowerCase());
          if(p >= 0){
            cls += ' ocrhit';
            var a = Math.max(0, p - 14), b = Math.min(im._ocrt.length, p + q.length + 14);
            tip = (a > 0 ? '…' : '') + im._ocrt.slice(a, b) + (b < im._ocrt.length ? '…' : '');
          }
        }""",
    """        // 命中「图内文字」或「图片内容描述」时：给图片描边，并把命中片段显示出来
        var tip = '', tipLabel = '';
        var q = st.q.trim();
        if(q){
          var lq = q.toLowerCase();
          var po = im._ocrt ? im._ocrt.toLowerCase().indexOf(lq) : -1;
          if(po >= 0){
            cls += ' ocrhit'; tipLabel = '图内文字';
            tip = around(im._ocrt, po, q.length);
          }else{
            var pv = im._vlmt ? im._vlmt.toLowerCase().indexOf(lq) : -1;
            if(pv >= 0){
              cls += ' vlmhit'; tipLabel = '图片内容';
              tip = around(im._vlmt, pv, q.length);
            }
          }
        }"""
))

reps.append((
    """          ? '<span class="imgwrap">' + tag + '<span class="ocrtip">图内文字：' + hl(tip) + '</span></span>'""",
    """          ? '<span class="imgwrap">' + tag + '<span class="ocrtip">' + tipLabel + '：' + hl(tip) + '</span></span>'"""
))

ok = True
for old, new in reps:
    n = src.count(old)
    tag = old.strip().split('\n')[0][:60]
    if n != 1:
        print(f'  [FAIL] 出现 {n} 次 → {tag}')
        ok = False
        continue
    src = src.replace(old, new, 1)
    print(f'  [OK]   {tag}')

if not ok:
    print('\n有替换未命中，未写入文件')
    raise SystemExit(1)

bak = P + '.bak.' + time.strftime('%Y%m%d%H%M%S')
shutil.copy2(P, bak)
open(P, 'w', encoding='utf-8').write(src)
print(f'\n全部 {len(reps)} 处已写入。备份：{os.path.basename(bak)}')
print(f'文件大小 {len(orig)} → {len(src)} 字符')

# 落盘复核
chk = open(P, encoding='utf-8').read()
for k in ('data/vlm.js', 'DM_VLM', '_vlmt', 'vlmhit', 'vlmWithDesc', 'function around'):
    print(f'  复核 {k:18} {"✓" if k in chk else "✗ 缺失"}')
