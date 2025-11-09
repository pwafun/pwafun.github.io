/* sw.js */
const VERSION = 'v1.0.0';                         // ganti versi ini untuk invalidasi cache
const STATIC_CACHE = `static-${VERSION}`;
const RUNTIME_CACHE = `runtime-${VERSION}`;

// Precache resource yang dipakai langsung di HTML (pakai URL persis seperti di <script>/<link>)
const PRECACHE_URLS = [
  './', // halaman utama
  // CDN utama di HTML:
  'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs',
  'https://cdn.jsdelivr.net/npm/@tensorflow-models/universal-sentence-encoder'
];

// Pola host yang ingin kita cache saat jalan (runtime), termasuk file model USE & font
const RUNTIME_ALLOWED_HOSTS = [
  'cdn.jsdelivr.net',
  'cdnjs.cloudflare.com',
  'fonts.gstatic.com',                 // font yang ditarik dari CSS fontawesome
  'storage.googleapis.com',            // sebagian besar tfjs models di-host di sini
  'tfhub.dev'                          // alternatif host model
];

// Helper: cek apakah request boleh dicache via runtime rules
function isRuntimeCacheable(url) {
  try {
    const u = new URL(url);
    return RUNTIME_ALLOWED_HOSTS.includes(u.hostname);
  } catch {
    return false;
  }
}

// Install: simpan static asset yang sudah kita ketahui
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

// Activate: hapus cache lama kalau versi berubah
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== STATIC_CACHE && k !== RUNTIME_CACHE)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// Strategy ringkas:
// - HTML: network-first (agar cepat update halaman), fallback ke cache
// - Asset CDN & file model: cache-first + stale-while-revalidate (biar kencang & tetap bisa update background)
// - Lainnya: default network
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Hanya tangani GET
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const isHTML = req.destination === 'document' || (req.headers.get('accept') || '').includes('text/html');

  // HTML -> network-first
  if (isHTML && url.origin === self.location.origin) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(STATIC_CACHE);
        cache.put(req, fresh.clone());
        return fresh;
      } catch {
        const cache = await caches.open(STATIC_CACHE);
        const cached = await cache.match(req) || await cache.match('./');
        return cached || new Response('Offline', { status: 503, statusText: 'Offline' });
      }
    })());
    return;
  }

  // Asset runtime (CDN, model USE, fonts) -> cache-first + SWR
  if (isRuntimeCacheable(req.url)) {
    event.respondWith((async () => {
      const cache = await caches.open(RUNTIME_CACHE);
      const cached = await cache.match(req);
      const networkPromise = fetch(req, { mode: 'cors' })
        .then((resp) => {
          // simpan respons ke cache jika valid
          if (resp && resp.status === 200) cache.put(req, resp.clone());
          return resp;
        })
        .catch(() => null);

      // Stale-while-revalidate: segera pakai cache jika ada, sambil update di belakang
      return cached || (await networkPromise) || new Response('Offline', { status: 503 });
    })());
    return;
  }

  // Default -> coba network, fallback cache (jaga-jaga)
  event.respondWith((async () => {
    try {
      return await fetch(req);
    } catch {
      const cache = await caches.open(RUNTIME_CACHE);
      const cached = await cache.match(req);
      return cached || new Response('Offline', { status: 503 });
    }
  })());
});
