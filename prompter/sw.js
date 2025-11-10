/* sw.js — PWA runtime & precache for TFJS + USE + CDN assets
   Scope: direktori tempat file ini berada (dan turunannya)
*/

const VERSION = 'v1.0.0';
const STATIC_CACHE = `static-${VERSION}`;
const RUNTIME_CACHE = `runtime-${VERSION}`;

// URL yang dipakai langsung di HTML — tulis persis seperti di <script>/<link>
const PRECACHE_URLS = [
  // CDN di HTML (sesuaikan bila kamu mem-pin versi)
  'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs',
  'https://cdn.jsdelivr.net/npm/@tensorflow-models/universal-sentence-encoder'
];

// Host lintas-origin yang boleh dicache saat runtime
const RUNTIME_ALLOWED_HOSTS = new Set([
  'storage.googleapis.com', // tfjs/tfhub model shard
  'tfhub.dev',              // tfhub redirector
  'www.kaggle.com'
]);

// ------- Helper -------
function isHTMLRequest(req) {
  const accept = req.headers.get('accept') || '';
  return req.destination === 'document' || accept.includes('text/html');
}

function isRuntimeCacheable(urlStr) {
  try {
    const { hostname } = new URL(urlStr);
    return RUNTIME_ALLOWED_HOSTS.has(hostname);
  } catch {
    return false;
  }
}

// Buat Request lintas-origin yang aman CORS (tanpa kredensial)
function makeCorsOmitRequest(input) {
  const url = typeof input === 'string' ? input : input.url;
  const integrity = (typeof input !== 'string' && input.integrity) ? input.integrity : undefined;
  return new Request(url, {
    method: 'GET',
    mode: 'cors',
    credentials: 'omit',
    redirect: 'follow',
    integrity
  });
}

// ------- Install: precache -------
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(STATIC_CACHE);

    // Gunakan Request khusus (cors + omit) agar tidak kena CORS credentials
    const reqs = PRECACHE_URLS.map((u) => makeCorsOmitRequest(u));

    // addAll akan fail jika salah satu gagal; bungkus dengan Promise.all settle
    await Promise.all(reqs.map(async (req) => {
      try {
        const resp = await fetch(req);
        if (resp && (resp.ok || resp.type === 'opaque')) {
          await cache.put(req, resp.clone());
        }
      } catch (e) {
        // Diamkan saja; resource ini bisa diambil saat runtime
        // console.warn('Precache gagal:', req.url, e);
      }
    }));
  })());
  self.skipWaiting();
});

// ------- Activate: bersihkan cache lama -------
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k !== STATIC_CACHE && k !== RUNTIME_CACHE)
        .map((k) => caches.delete(k))
    );
  })());
  self.clients.claim();
});

// ------- Fetch strategy -------
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Hanya tangani GET
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 1) HTML same-origin -> network-first (fallback cache)
  if (isHTMLRequest(req) && url.origin === self.location.origin) {
    event.respondWith(networkFirstHTML(req));
    return;
  }

  // 2) Asset lintas-origin (CDN, model, fonts) -> cache-first + SWR dengan credentials: 'omit'
  if (isRuntimeCacheable(req.url)) {
    event.respondWith(cacheFirstSWR(req));
    return;
  }

  // 3) Default: coba network, fallback cache runtime
  event.respondWith(defaultNetworkFallback(req));
});

// ------- Strategies Implementation -------

async function networkFirstHTML(req) {
  const cache = await caches.open(STATIC_CACHE);
  try {
    const fresh = await fetch(req);
    // Simpan versi terbaru ke cache
    if (fresh && fresh.ok) {
      await cache.put(req, fresh.clone());
    }
    return fresh;
  } catch {
    const cached = await cache.match(req) || await cache.match('./');
    return cached || new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

async function cacheFirstSWR(req) {
  const cache = await caches.open(RUNTIME_CACHE);

  // Normalisasikan request lintas-origin → CORS+omit
  const cleanReq = makeCorsOmitRequest(req);

  // 1) Coba cache dulu
  const cached = await cache.match(cleanReq);
  if (cached) {
    // Revalidate di belakang layar (non-blocking)
    revalidateInBackground(cleanReq, cache);
    return cached;
  }

  // 2) Tidak ada di cache → coba fetch CORS+omit
  try {
    const resp = await fetch(cleanReq);
    if (resp && (resp.ok || resp.type === 'opaque')) {
      await cache.put(cleanReq, resp.clone());
    }
    return resp;
  } catch {
    // 3) Fallback terakhir: no-cors (opaque), agar script/style/font tetap bisa disajikan
    try {
      const opaqueReq = new Request(cleanReq.url, { method: 'GET', mode: 'no-cors', credentials: 'omit', redirect: 'follow' });
      const resp = await fetch(opaqueReq);
      if (resp && resp.type === 'opaque') {
        await cache.put(opaqueReq, resp.clone());
      }
      return resp;
    } catch {
      return new Response('Offline', { status: 503 });
    }
  }
}

function revalidateInBackground(cleanReq, cache) {
  fetch(cleanReq).then((resp) => {
    if (resp && (resp.ok || resp.type === 'opaque')) {
      cache.put(cleanReq, resp.clone());
    }
  }).catch(() => { /* diamkan */ });
}

async function defaultNetworkFallback(req) {
  const cache = await caches.open(RUNTIME_CACHE);
  try {
    return await fetch(req);
  } catch {
    const cached = await cache.match(req);
    return cached || new Response('Offline', { status: 503 });
  }
}

// (Opsional) dukung skipWaiting via postMessage
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
