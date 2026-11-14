// 小手机 Service Worker：网络优先，离线时才用缓存（更新文件后下次打开就是新版）。
// 另外负责：点系统通知 → 切到（或重新打开）对应角色的聊天页。
const CACHE = 'myphone-v3';
const FILES = ['./', './index.html', './style.css', './app.js'];
self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(FILES.map(f => c.add(f).catch(() => {})))));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  if (new URL(r.url).origin !== location.origin) return; // 模型接口、外链图片不拦截
  e.respondWith(
    fetch(r).then(res => {
      if (res.ok) { const cp = res.clone(); caches.open(CACHE).then(c => c.put(r, cp)); }
      return res;
    }).catch(() => caches.match(r))
  );
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const cid = e.notification.data && e.notification.data.cid;
  e.waitUntil((async () => {
    const list = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (list.length) {
      const c = list[0];
      try { await c.focus(); } catch (_) {}
      c.postMessage({ type: 'open-chat', cid });      // 页面还活着：直接切到聊天，不刷新
      return;
    }
    // 页面已被系统清掉：重新打开，并带上 ?chat= 直接进入该角色的聊天（消息早已存进本地数据库）
    await clients.openWindow('./?chat=' + encodeURIComponent(cid || ''));
  })());
});
