/* Service worker for the r1 probe.
 *
 * Deliberately NETWORK-FIRST, not cache-first. A cache-first shell would mean
 * every future push of this probe never reaches the device — the creation
 * would keep serving whatever it cached on first install, and we would have no
 * way to ship a fix. Network-first still proves the offline path: when the
 * fetch rejects, the cached shell is served instead.
 */

var CACHE = 'r1-probe-v1';
var SHELL = ['./', './index.html'];

self.addEventListener('install', function (e) {
    e.waitUntil(
        caches.open(CACHE)
            .then(function (c) { return c.addAll(SHELL); })
            .then(function () { return self.skipWaiting(); })
            .catch(function () { return self.skipWaiting(); })
    );
});

self.addEventListener('activate', function (e) {
    e.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', function (e) {
    if (e.request.method !== 'GET') { return; }
    var sameOrigin = false;
    try { sameOrigin = new URL(e.request.url).origin === location.origin; }
    catch (err) { sameOrigin = false; }
    if (!sameOrigin) { return; }

    e.respondWith(
        fetch(e.request)
            .then(function (res) {
                if (res && res.ok) {
                    var copy = res.clone();
                    caches.open(CACHE).then(function (c) {
                        c.put(e.request, copy).catch(function () {});
                    });
                }
                return res;
            })
            .catch(function () {
                return caches.match(e.request).then(function (hit) {
                    return hit || caches.match('./index.html');
                });
            })
    );
});
