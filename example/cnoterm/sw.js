const CACHE_NAME = 'terminal-v1';
const urlsToCache = [
    '/',
    '/index.html',
    '/styles.css',
    '/app.js',
    '/manifest.json',
    'https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.min.css',
    'https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js',
    'https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.min.js',
    'https://cdn.jsdelivr.net/npm/xterm-addon-web-links@0.9.0/lib/xterm-addon-web-links.min.js'
];

// 安装事件
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                console.log('Opened cache');
                return cache.addAll(urlsToCache);
            })
            .catch(err => {
                console.error('Cache install failed:', err);
            })
    );
    self.skipWaiting();
});

// 激活事件
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cacheName => {
                    if (cacheName !== CACHE_NAME) {
                        console.log('Deleting old cache:', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
    self.clients.claim();
});

// 请求拦截
self.addEventListener('fetch', event => {
    // 跳过 WebSocket 请求
    if (event.request.url.includes('/ws')) {
        return;
    }

    event.respondWith(
        caches.match(event.request)
            .then(response => {
                // 缓存命中，返回缓存
                if (response) {
                    return response;
                }

                // 克隆请求
                const fetchRequest = event.request.clone();

                return fetch(fetchRequest).then(response => {
                    // 检查是否是有效响应
                    if (!response || response.status !== 200 || response.type !== 'basic') {
                        return response;
                    }

                    // 克隆响应
                    const responseToCache = response.clone();

                    caches.open(CACHE_NAME)
                        .then(cache => {
                            cache.put(event.request, responseToCache);
                        });

                    return response;
                });
            })
            .catch(err => {
                console.error('Fetch failed:', err);
                // 可以返回一个离线页面
            })
    );
});

// 支持多实例
self.addEventListener('message', event => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});