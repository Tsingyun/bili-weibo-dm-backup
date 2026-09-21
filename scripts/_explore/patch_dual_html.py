# -*- coding: utf-8 -*-
"""把 查看备份.html 改造为「微博 / B站」双数据源查看器（顶部切换按钮）。"""
import io, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
P = os.path.join(ROOT, '查看备份.html')
t0 = io.open(P, encoding='utf-8').read()
t = t0
n = 0


def sub(old, new, cnt=1, tag=''):
    global t, n
    c = t.count(old)
    assert c == cnt, f'[{tag}] 匹配 {c} 次（期望 {cnt}）:\n{old[:180]}'
    t = t.replace(old, new, cnt)
    n += 1
    print(f'  [{n:02d}] ok  {tag}')


# ============================================================ 1. CSS
CSS = '''/* ---------- 顶部数据源切换（微博 / B站）---------- */
.srcsw{display:flex;gap:4px;padding:4px;border-radius:11px;border:1px solid var(--line);
  background:var(--panel);margin-bottom:11px}
.srcsw button{flex:1;min-width:0;height:31px;border:0;border-radius:8px;background:transparent;
  color:var(--muted);font-family:inherit;font-size:12.5px;font-weight:600;cursor:pointer;
  display:inline-flex;align-items:center;justify-content:center;gap:5px;white-space:nowrap;overflow:hidden}
.srcsw button[aria-pressed="true"]{background:var(--chip-on);color:#fff}
.srcsw button:disabled{opacity:.45;cursor:not-allowed}
.srcsw button .n{font-weight:400;font-size:11px;opacity:.8}
/* ---------- B站卡片（分享视频/专栏/动态/推送/通知）---------- */
.wcard.bc{border-color:color-mix(in srgb, var(--c-peer) 42%, var(--line))}
.wcard.bc .wcard-h{color:var(--c-peer)}
.wcard.bc .wcard-h .wa{font-weight:500;opacity:.85}
.wcard-t.wtitle{font-weight:600}
'''
sub('.side-top{display:flex;align-items:center;gap:8px}',
    CSS + '.side-top{display:flex;align-items:center;gap:8px}', tag='CSS 插入')

# ============================================================ 2. 侧栏顶部切换按钮
sub('''  <aside class="sidebar">
    <div class="side-top">''',
    '''  <aside class="sidebar">

    <!-- 数据源切换：微博 / B站（同一套查看器，数据互不影响） -->
    <div class="srcsw" id="srcSw" role="tablist" aria-label="切换备份来源">
      <button type="button" role="tab" data-src="weibo" aria-pressed="true">微博</button>
      <button type="button" role="tab" data-src="bili" aria-pressed="false">B站</button>
    </div>

    <div class="side-top">''', tag='侧栏切换按钮')

# ============================================================ 3. 引入 B站数据脚本
sub('''<script src="data/vlm.js" onerror="window.__vlmMissing=1"></script>''',
    '''<script src="data/vlm.js" onerror="window.__vlmMissing=1"></script>
<!-- B站数据集（目录与全局名都与微博独立，缺失时不影响微博视图） -->
<script src="bili/messages.js" onerror="window.__biliMissing=1"></script>
<script src="bili/faces.js" onerror="window.__biliFacesMissing=1"></script>
<script src="bili/ocr.js" onerror="window.__biliOcrMissing=1"></script>
<script src="bili/vlm.js" onerror="window.__biliVlmMissing=1"></script>''', tag='引入B站脚本')

# ============================================================ 4. 数据源注册表 + boot 化
sub('''(function(){
  var D = window.DM_DATA;
  if(!D){ document.getElementById('chat').innerHTML =
      '<div class="empty">未找到数据文件 <code>data/messages.js</code><br>请先运行一次「更新备份.cmd」</div>'; return; }

  var META = D.meta || {}, ALL = D.messages || [];
  var CHUNK = 150;
''',
    '''/* ==========================================================
   数据源注册表：微博 / B站 共用同一个查看器，顶部按钮切换
   ----------------------------------------------------------
   两套数据完全独立，各自有自己的目录与导出的全局名：
     微博  data/messages.js → window.DM_DATA     （+ DM_FACES / DM_OCR / DM_VLM）
     B站   bili/messages.js → window.DM_DATA_B   （+ DM_FACES_B / DM_OCR_B / DM_VLM_B）
   ========================================================== */
var SOURCES = {
  weibo: {
    key:'weibo', label:'微博', title:'微博私信备份',
    data: window.DM_DATA, faces: window.DM_FACES, ocr: window.DM_OCR, vlm: window.DM_VLM,
    autoReply: '',
    empty: '未找到数据文件 <code>data/messages.js</code><br>请先运行一次「更新备份.cmd」',
  },
  bili: {
    key:'bili', label:'B站', title:'B站私信备份',
    data: window.DM_DATA_B, faces: window.DM_FACES_B, ocr: window.DM_OCR_B, vlm: window.DM_VLM_B,
    autoReply: '',
    empty: '未找到数据文件 <code>bili/messages.js</code><br>请先运行一次「更新B站备份.cmd」' +
           '（首次需要在弹出的浏览器窗口里扫码登录 B站）',
  },
};

/* 切换数据源时，把整棵 DOM 恢复成「初始快照」——
   这样所有节点都是全新的，监听器不会因为反复 boot 而重复叠加。 */
var SNAP = null;
function snapDom(){
  if(!SNAP) SNAP = {
    layout: document.querySelector('.layout').cloneNode(true),
    fab:    document.querySelector('.fab').cloneNode(true),
    lb:     document.getElementById('lb').cloneNode(true),
    stat:   document.getElementById('stat').cloneNode(true),
  };
  return SNAP;
}
function resetDom(){
  var S = snapDom();
  [[ '.layout', S.layout ], [ '.fab', S.fab ], [ '#lb', S.lb ], [ '#stat', S.stat ]]
    .forEach(function(p){
      var cur = document.querySelector(p[0]);
      if(cur && cur.parentNode) cur.parentNode.replaceChild(p[1].cloneNode(true), cur);
    });
}

var CUR_SRC = null;

function boot(srcKey){
  var SRC = SOURCES[srcKey] || SOURCES.weibo;
  CUR_SRC = SRC.key;

  // 摘掉上一轮的全局监听，再重建 DOM（节点级监听器随旧节点一起扔掉）
  if(boot._bound){
    boot._bound.forEach(function(b){
      (b[2] ? window : document).removeEventListener(b[0], b[1]);
    });
  }
  var BOUND = boot._bound = [];
  function onDoc(ev, fn){ document.addEventListener(ev, fn); BOUND.push([ev, fn, 0]); }
  function onWin(ev, fn, opt){ window.addEventListener(ev, fn, opt); BOUND.push([ev, fn, 1]); }

  resetDom();
  bindSrcSwitch();

  var D = SRC.data;
  if(!D){
    document.getElementById('title').textContent = SRC.title;
    document.title = SRC.title;
    document.getElementById('stats').innerHTML = '<span class="s1">尚无数据</span>';
    document.getElementById('chat').innerHTML = '<div class="empty">' + SRC.empty + '</div>';
    return;
  }

  var META = D.meta || {}, ALL = D.messages || [];
  var CHUNK = 150;
  var AUTO_REPLY = SRC.autoReply || '';   // B站没有固定文案，靠 msg_source 结构化判定
''', tag='注册表 + boot 化')

# ============================================================ 5. 各数据源自己的 OCR/VLM/表情
sub("  var OCR = (window.DM_OCR || {});", "  var OCR = (SRC.ocr || {});", tag='OCR 取本源的')
sub("  var VLM = (window.DM_VLM || {});", "  var VLM = (SRC.vlm || {});", tag='VLM 取本源的')
sub("  var FACES = (window.DM_FACES || { phrase:{}, ee:{} });",
    "  var FACES = (SRC.faces || { phrase:{}, ee:{} });", tag='表情取本源的')

# ============================================================ 6. 标题
sub('''  document.getElementById('title').textContent = '微博私信备份 · ' + (META.peer_name || '');
  document.title = '微博私信备份 · ' + (META.peer_name || '');''',
    '''  document.getElementById('title').textContent = SRC.title + ' · ' + (META.peer_name || '');
  document.title = SRC.title + ' · ' + (META.peer_name || '');''', tag='标题')

# ============================================================ 7. 自动回复状态按来源区分
sub('''  var AUTO_REPLY = '';   // 对方的自动回复，可一键隐藏
  var st = { q:'', filter:'all', list:ALL.slice(), win:0, hideAuto:false, hitIdx:-1, autoHidden:0, ctx:{} };
  try{ st.hideAuto = localStorage.getItem('dm-hide-auto') === '1'; }catch(e){}''',
    '''  var st = { q:'', filter:'all', list:ALL.slice(), win:0, hideAuto:false, hitIdx:-1, autoHidden:0, ctx:{} };
  try{ st.hideAuto = localStorage.getItem('dm-hide-auto-' + SRC.key) === '1'; }catch(e){}''',
    tag='隐藏自动回复状态')

sub("      if(st.hideAuto && (m.text||'').trim() === AUTO_REPLY){ autoHidden++; return false; }",
    "      if(st.hideAuto && msgKind(m) === 'auto'){ autoHidden++; return false; }",
    tag='筛选用统一口径')

sub('''  function updateAutoChip(){
    var c = document.getElementById('autoChip');
    c.setAttribute('aria-pressed', st.hideAuto ? 'true' : 'false');
    c.textContent = st.hideAuto ? '🙈 自动回复已隐藏' : '🚫 自动回复';
  }''',
    '''  function updateAutoChip(){
    var c = document.getElementById('autoChip');
    if(!c) return;
    c.setAttribute('aria-pressed', st.hideAuto ? 'true' : 'false');
    c.textContent = st.hideAuto ? '🙈 自动回复已隐藏' : '🚫 自动回复';
    c.title = (SRC.key === 'bili')
      ? '一键隐藏 / 显示 B站的自动回复：接口 msg_source 为 8~11、17，以及关注后的自动推送（msg_type 16）'
      : '一键隐藏 / 显示对方的自动回复「' + AUTO_REPLY + '」';
  }''', tag='自动回复按钮提示')

sub("    try{ localStorage.setItem('dm-hide-auto', st.hideAuto ? '1' : '0'); }catch(e){}",
    "    try{ localStorage.setItem('dm-hide-auto-' + SRC.key, st.hideAuto ? '1' : '0'); }catch(e){}",
    tag='隐藏状态按来源存档')

# ============================================================ 8. 链接归一化：加 B站
sub('''  function fmtShort(created){''',
    '''  // B站链接归一化：同一支视频 / 专栏 / 动态的 BV 号、av 号、短链只保留一条
  function biliKey(url){
    if(!url) return '';
    var s = String(url), m;
    if((m = /(BV[0-9A-Za-z]{10})/.exec(s))) return 'bv:' + m[1];
    if((m = /read\\/cv(\\d+)/i.exec(s))) return 'cv:' + m[1];
    if((m = /t\\.bilibili\\.com\\/(\\d+)/.exec(s))) return 'dyn:' + m[1];
    if((m = /\\/(?:video\\/)?av(\\d+)/i.exec(s))) return 'av:' + m[1];
    if((m = /bangumi\\/play\\/(?:ss|ep)(\\d+)/i.exec(s))) return 'pgc:' + m[1];
    return '';
  }
  // 按当前数据源选归一化规则（微博那套逻辑保持原样，不受影响）
  function linkKey(u){
    if(SRC.key === 'bili') return biliKey(u) || String(u || '');
    return weiboKey(u) || String(u || '');
  }
  function fmtShort(created){''', tag='biliKey 归一化')

sub("      var k = weiboKey(u) || String(u);", "      var k = linkKey(u);", tag='去重键1')
sub("    if(!onlyUrl) txtUrls.forEach(function(u){ inText[weiboKey(u) || String(u)] = 1; });",
    "    if(!onlyUrl) txtUrls.forEach(function(u){ inText[linkKey(u)] = 1; });", tag='去重键2')
sub("      var k1 = weiboKey(l.long) || String(l.long || '');",
    "      var k1 = l.long ? linkKey(l.long) : '';", tag='去重键3')
sub("      var k2 = weiboKey(l.short) || String(l.short || '');",
    "      var k2 = l.short ? linkKey(l.short) : '';", tag='去重键4')

# ============================================================ 9. 卡片渲染：区分微博卡 / B站卡
sub('''    var isWeiboCard = !!(card && card.kind === 'weibo');   // 分享的微博
    var isWboxCard  = !!(card && card.kind === 'wbox');    // 「查看动图」→ 图片已单独展示''',
    '''    var isWeiboCard = !!(card && card.kind === 'weibo');   // 分享的微博
    var isBiliCard  = !!(card && card.kind === 'bili');    // B站分享 / 推送 / 通知卡片
    var isWboxCard  = !!(card && card.kind === 'wbox');    // 「查看动图」→ 图片已单独展示''',
    tag='卡片类型判定')

sub('''      // 正文与 links 已并入卡片，不再重复渲染（需求4）
    } else {''',
    '''      // 正文与 links 已并入卡片，不再重复渲染（需求4）
    } else if(isBiliCard){
      /* ---- B站卡片：分享视频/专栏/动态/直播、视频推送、UP主赠言、官方通知 ---- */
      var needBtnB = ((card.title || '').length + (card.text || '').length) > 46 || imgs.length > 0;
      inner += '<div class="wcard bc">' +
        '<div class="wcard-h">📺 ' + hl(card.sub || 'B站') +
          (card.author ? ' <span class="wa">· ' + hl(card.author) + '</span>' : '') +
          (card.created ? ' <span class="wt">' + esc(fmtShort(card.created)) + '</span>' : '') +
          (card.extra ? ' <span class="wt">· ' + esc(card.extra) + '</span>' : '') +
        '</div>' +
        (card.title ? '<div class="wcard-t wtitle">' + richText(card.title) + '</div>' : '') +
        (card.text ? '<div class="wcard-t">' + richText(card.text) + '</div>' : '') +
        (uniq.length ? '<a class="wcard-link" href="' + esc(uniq[0]) + '" target="_blank" rel="noreferrer">🔗 打开原链接</a>' : '') +
        (needBtnB ? '<button class="wcard-btn" type="button">展开详情</button>' : '') +
        '</div>';
    } else {''', tag='B站卡片渲染')

sub("    var cls = 'bubble' + (imgs.length && !txt ? ' plain' : '') + (isWeiboCard ? ' has-card' : '');",
    "    var cls = 'bubble' + (imgs.length && !txt ? ' plain' : '') + ((isWeiboCard || isBiliCard) ? ' has-card' : '');",
    tag='卡片气泡样式')

sub("  var TYPE_LABEL = {text:'文字', image:'图片', emoji:'表情', video:'视频', voice:'语音', link:'链接', card:'卡片', other:'消息', recalled:'已撤回'};",
    "  var TYPE_LABEL = {text:'文字', image:'图片', emoji:'表情', video:'视频', voice:'语音', link:'链接', card:'卡片', other:'消息', recalled:'已撤回', recall:'撤回提示', notice:'系统提示', ai:'AI 消息'};",
    tag='类型标签')

# ============================================================ 10. 全局监听器改为可回收
sub('''  var railTick = 0;
  window.addEventListener('scroll', function(){
    if(railTick) return;
    railTick = requestAnimationFrame(function(){ railTick = 0; highlightMonth(); });
  }, {passive:true});''',
    '''  var railTick = 0;
  onWin('scroll', function(){
    if(railTick) return;
    railTick = requestAnimationFrame(function(){ railTick = 0; highlightMonth(); });
  }, {passive:true});''', tag='滚动监听可回收')

sub('''  document.addEventListener('keydown', function(e){
    if(e.key === '/' && document.activeElement !== qEl){ e.preventDefault(); qEl.focus(); }
    if(e.key === 'Escape'){ closeLb(); if(document.activeElement===qEl) qEl.blur(); }
  });''',
    '''  onDoc('keydown', function(e){
    if(e.key === '/' && document.activeElement !== qEl){ e.preventDefault(); qEl.focus(); }
    if(e.key === 'Escape'){ closeLb(); if(document.activeElement===qEl) qEl.blur(); }
  });''', tag='快捷键监听可回收')

sub('''  document.addEventListener('keydown', function(e){
    if(e.key === 'Escape' && document.getElementById('stat').classList.contains('on')) closeStat();
  });''',
    '''  onDoc('keydown', function(e){
    if(e.key === 'Escape' && document.getElementById('stat').classList.contains('on')) closeStat();
  });''', tag='统计面板 Esc 可回收')

sub('''  document.addEventListener('keydown', function(e){
    if(!lb.classList.contains('on')) return;
    if(e.key==='ArrowLeft') openLb(cur-1);
    if(e.key==='ArrowRight') openLb(cur+1);
  });''',
    '''  onDoc('keydown', function(e){
    if(!lb.classList.contains('on')) return;
    if(e.key==='ArrowLeft') openLb(cur-1);
    if(e.key==='ArrowRight') openLb(cur+1);
  });''', tag='灯箱按键可回收')

sub('''                    (tt === AUTO_REPLY && st.hideAuto);''',
    '''                    (!!AUTO_REPLY && tt === AUTO_REPLY && st.hideAuto);''', tag='隐藏自动回复判定')

# ============================================================ 11. 统计口径：B站用结构化字段
sub('''  function msgKind(m){
    var t = (m.text || '').trim();
    if(t === AUTO_REPLY) return 'auto';
    if(RE_GIFT.test(t)) return 'gift';
    if(RE_SYSTIP.test(t)) return 'sys';
    return 'count';
  }''',
    '''  /* 一条消息算不算「真实发言」：
     · 微博：接口没有「是否自动回复」字段，只能按接口原文精确匹配（3 类）
     · B站 ：接口自带 msg_source，可以直接结构化判定，比猜文案可靠得多
             msg_source 8=关注后 9=收到消息 10=关键词 11=大航海 → 自动回复
                        17=互关自动消息      16=系统
             msg_type   16=关注后的自动推送    5=撤回    18=系统提示
                        10=官方通知 13=图片卡片 301~306=粉丝团提示 */
  function msgKind(m){
    if(SRC.key === 'bili'){
      var s = m.msg_source | 0, mt = m.media_type;
      if((s >= 8 && s <= 11) || s === 17) return 'auto';
      if(mt === 16) return 'auto';
      if(mt === 5 || mt === 18) return 'sys';
      if(mt === 10 || mt === 13) return 'gift';
      if(mt >= 301 && mt <= 306) return 'gift';
      if(m.from !== 'me' && m.from !== 'peer') return 'gift';
      return 'count';
    }
    var t = (m.text || '').trim();
    if(t === AUTO_REPLY) return 'auto';
    if(RE_GIFT.test(t)) return 'gift';
    if(RE_SYSTIP.test(t)) return 'sys';
    return 'count';
  }''', tag='msgKind 双口径')

# ============================================================ 12. 口径说明分来源
sub('''  function renderCaliber(){
    var D = buildDaily(), e = D.excl, T = D.tot;
    document.getElementById('caliber').innerHTML =
      '<details open><summary>统计口径与数据来源</summary><ul>' +''',
    '''  function renderCaliber(){
    var el = document.getElementById('caliber');
    if(!el) return;
    el.innerHTML = (SRC.key === 'bili') ? caliberBili() : caliberWeibo();
  }

  function caliberWeibo(){
    var D = buildDaily(), e = D.excl, T = D.tot;
    return '<details open><summary>统计口径与数据来源</summary><ul>' +''', tag='口径说明分发')

sub('''      '</ul></details>';
  }

  function openStat(){''',
    '''      '</ul></details>';
  }

  function caliberBili(){
    var D = buildDaily(), e = D.excl, T = D.tot;
    return '<details open><summary>统计口径与数据来源</summary><ul>' +
      '<li><span class="em">数据来源</span>：本地备份 <code>bili/messages.js</code>，共 ' + ALL.length.toLocaleString() +
        ' 条（' + esc(D.dates[0]) + ' ~ ' + esc(D.dates[D.dates.length-1]) + '）。纯本地计算，不联网。</li>' +
      '<li><span class="em">按自然日划分</span>：消息时间戳换算到<b>本机时区</b>的 <code>YYYY-MM-DD</code>，' +
        '一条消息只归属它所在的那一天，不跨日拆分；时间轴按日<b>连续补齐</b>，没有消息的日子记 0（共 ' +
        T.zero.toLocaleString() + ' 天），所以折线上的时间间隔是真实的。</li>' +
      '<li><span class="em">归属判定</span>：用接口的 <code>sender_uid</code> 判定（= 我的 mid 记"我"、= ' +
        esc(META.peer_name || '对方') + ' 的 mid 记"对方"），发送者为系统账号（uid 0）的不计入。区间内：我 ' +
        T.me.toLocaleString() + ' 条 / 对方 ' + T.peer.toLocaleString() + ' 条。</li>' +
      '<li><span class="em">不计入</span>（3 类，全部按接口字段结构化判定，不猜文案）<ul>' +
        '<li><b>自动回复 / 自动消息</b>：' + e.auto.toLocaleString() + ' 条 —— <code>msg_source</code> 为 ' +
        '8~11（关注后、收到消息、关键词、大航海触发）或 17（互关自动消息），以及 <code>msg_type</code>=16（关注后的自动推送）。' +
        (META.auto_reply_top ? '其中出现最多的是「' + esc(String(META.auto_reply_top.text).slice(0, 40)) + '」共 ' +
          META.auto_reply_top.n.toLocaleString() + ' 次。' : '') + '</li>' +
        '<li><b>系统通知 / 官方推送</b>：' + e.gift.toLocaleString() + ' 条 —— <code>msg_type</code> 10（通知）、' +
        '13（图片卡片）、301~306（粉丝团提示），以及发送者不是你们俩的消息。</li>' +
        '<li><b>撤回提示与系统提示</b>：' + e.sys.toLocaleString() + ' 条 —— <code>msg_type</code> 5（撤回）、18（系统提示）。</li>' +
        '</ul></li>' +
      '<li><span class="em">计入</span>：文字、图片、自定义表情、分享视频 / 专栏 / 动态 / 直播、视频推送、专栏推送、' +
        'UP主赠言等<b>全部真实往来内容</b>；被撤回但原文仍在的消息也计入（它确实发出过）。</li>' +
      '<li><span class="em">看趋势</span>：默认叠加 7 日均线（细线是每日原始值，实线是均线），并默认开启<b>独立量程</b>' +
        '（左轴=我、右轴=对方，两条线各自铺满图高）。想比较真实量级，关掉「独立量程」即可。' +
        '点击图上任意一天可跳到那天的聊天记录。</li>' +
      '</ul></details>';
  }

  function openStat(){''', tag='B站口径说明')

# ============================================================ 13. 启动收尾 + 切换逻辑
sub('''  /* ---------- 启动 ---------- */
  updateAutoChip();
  applyFilter();
  st.win = Math.max(0, st.list.length - CHUNK);
  render();
  highlightMonth(st.list.length - 1);
  requestAnimationFrame(function(){ window.scrollTo(0, document.body.scrollHeight); });
})();''',
    '''  /* ---------- 本次 boot 的收尾 ---------- */
  updateAutoChip();
  applyFilter();
  st.win = Math.max(0, st.list.length - CHUNK);
  render();
  highlightMonth(st.list.length - 1);
  requestAnimationFrame(function(){ window.scrollTo(0, document.body.scrollHeight); });
}

/* ---------- 顶部「微博 / B站」切换 ---------- */
function bindSrcSwitch(){
  var box = document.getElementById('srcSw');
  if(!box) return;
  Array.prototype.forEach.call(box.querySelectorAll('button[data-src]'), function(b){
    var key = b.dataset.src, S = SOURCES[key];
    var ok = !!(S && S.data);
    b.setAttribute('aria-pressed', key === CUR_SRC ? 'true' : 'false');
    b.disabled = !ok;
    if(ok && S.data.meta && S.data.meta.total != null){
      var nEl = document.createElement('span');
      nEl.className = 'n';
      nEl.textContent = S.data.meta.total.toLocaleString();
      b.appendChild(nEl);
    }
    b.onclick = function(){
      if(!ok || key === CUR_SRC) return;
      try{ localStorage.setItem('dm-src', key); }catch(e){}
      boot(key);
    };
  });
}

/* ---------- 首次进入：优先上次看过的那个来源 ---------- */
(function init(){
  var want = 'weibo';
  try{ want = localStorage.getItem('dm-src') || 'weibo'; }catch(e){}
  if(!SOURCES[want] || !SOURCES[want].data) want = SOURCES.weibo.data ? 'weibo' : 'bili';
  boot(want);
})();''', tag='启动 + 切换')

io.open(P, 'w', encoding='utf-8', newline='').write(t)
print(f'\n完成：{n} 处改动，{len(t0)} → {len(t)} 字节')
