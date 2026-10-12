// sw.js — 极简 Service Worker（PWA 可安装 + 离线兜底）
// 策略：同源请求一律「网络优先，缓存兜底」——保证升级后立刻拿到新代码（开发期改完刷新即生效），
// 断网时仍能用缓存打开界面。不做缓存优先，避免「改了代码刷新还是旧版」。
const CACHE = 'gracs-netfirst-v2';
const CACHEABLE = /^\/(js|css|assets|vendor)\//;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;

  const isNavigation = request.mode === 'navigate';
  const isCacheable = isNavigation || CACHEABLE.test(url.pathname);
  if (!isCacheable) return;

  e.respondWith(
    fetch(request)
      .then((res) => {
        if (res && res.ok && (isNavigation || url.pathname !== '/sw.js')) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        if (isNavigation) {
          const root = await caches.match('/');
          if (root) return root;
        }
        return new Response('离线：请检查与主机的连接', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }),
  );
});
