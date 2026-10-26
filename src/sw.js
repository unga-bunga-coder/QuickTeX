// Service worker: cache-first app shell. The build prepends VERSION (a hash of the cached files) and FILES.
const CACHE='quicktex-'+VERSION;

self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(FILES))));

// Drop caches from older builds, then take over pages opened before the first install.
self.addEventListener('activate',e=>e.waitUntil(caches.keys()
  .then(keys=>Promise.all(keys.filter(k=>k.startsWith('quicktex-') && k!==CACHE).map(k=>caches.delete(k))))
  .then(()=>self.clients.claim())));

// A new version waits until the page's "tap to reload" says go.
self.addEventListener('message',e=>{ if(e.data==='skipWaiting') self.skipWaiting() });

self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET') return;
  e.respondWith((async()=>{
    const c=await caches.open(CACHE);
    return await c.match(e.request,{ignoreSearch:true})
      || (e.request.mode==='navigate' && await c.match('./'))
      || fetch(e.request);
  })());
});
