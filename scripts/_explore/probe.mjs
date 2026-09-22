// 探测本机 CDP 端口是否可用（直连，不走代理）
const ports = [9222, 9223, 9224, 9333];
for (const p of ports) {
  try {
    const r = await fetch(`http://127.0.0.1:${p}/json/version`, { signal: AbortSignal.timeout(3000) });
    const j = await r.json();
    console.log(`[OK] port ${p} -> ${j.Browser}`);
  } catch (e) {
    console.log(`[--] port ${p} -> ${e.message}`);
  }
}
