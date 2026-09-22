// 探测 CDP 端口（长超时 + 忽略代理环境变量）
const ports = [9333, 9222];
for (const p of ports) {
  for (const path of ['/json/version', '/json/list']) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}${path}`, {
        signal: AbortSignal.timeout(15000),
        headers: { 'Host': `127.0.0.1:${p}` }
      });
      const t = await r.text();
      console.log(`[OK] ${p}${path} -> ${t.slice(0, 600)}`);
    } catch (e) {
      console.log(`[--] ${p}${path} -> ${e.name}: ${e.message} | cause=${e.cause ? e.cause.message || e.cause.code : '-'}`);
    }
  }
}
