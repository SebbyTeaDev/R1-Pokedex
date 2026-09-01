/* Service worker for the BirdNET bench.
 *
 * Network-first, same as probe/sw.js and for the same reason: a cache-first
 * shell would pin a device in the field to whatever it cached on install,
 * with no way to push a fix. A failed fetch falls back to cache, which is
 * what makes offline work.
 *
 * Scope is /bench/, but scope only limits which PAGES this worker controls —
 * it intercepts every same-origin request those pages make, including the
 * model at ../models/. That is why the weights are mirrored into this repo:
 * cross-origin requests are skipped below, so a remote model could never be
 * cached for field use.
 */

var CACHE = 'r1-bench-v1';
var SHELL = ['./', './index.html', './birdnet-worker.js', './test-audio.json'];

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

/* Explicit precache of the 49 MB model, driven from the page so the user
   chooses when to spend the bandwidth. Reports progress back to the client. */
self.addEventListener('message', function (e) {
    if (!e.data || e.data.type !== 'precache-model') { return; }
    var urls = e.data.urls || [];
    var port = e.ports && e.ports[0];
    var done = 0;

    caches.open(CACHE).then(function (c) {
        function next(i) {
            if (i >= urls.length) {
                if (port) { port.postMessage({ done: done, total: urls.length, finished: true }); }
                return;
            }
            fetch(urls[i], { cache: 'reload' })
                .then(function (res) {
                    if (res && res.ok) { return c.put(urls[i], res.clone()); }
                    throw new Error('HTTP ' + (res && res.status));
                })
                .then(function () {
                    done++;
                    if (port) { port.postMessage({ done: done, total: urls.length }); }
                    next(i + 1);
                })
                .catch(function (err) {
                    if (port) {
                        port.postMessage({
                            done: done, total: urls.length,
                            error: urls[i] + ': ' + (err && err.message || err)
                        });
                    }
                    next(i + 1);
                });
        }
        next(0);
    });
});
