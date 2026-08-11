/* Deep scan: download ALL bundles referenced by login page + any dynamically
 * discovered chunks, then harvest every string that looks like an API path.
 * The dashboard route bundles are loaded lazily but their import specifiers
 * may appear in the vendor-router or QueryProvider chunks as string literals.
 */
const fetch = require('node-fetch');
const BASE = 'http://127.0.0.1:2053';

function harvest(js) {
  const paths = new Set();
  // Match any quoted string containing path-like content with API keywords
  const re = /["'`]([^"'`\s]{2,120})["'`]/g;
  let m;
  while ((m = re.exec(js)) !== null) {
    const s = m[1];
    // Must contain a slash and an API-ish keyword
    if (s.includes('/') && /(inbound|client|server|status|setting|panel|api|onlines|traffic|subscription|addon|add|list|get|update|delete|reset|by)/i.test(s)) {
      paths.add(s);
    }
  }
  return paths;
}

(async () => {
  const allPaths = new Set();
  const visited = new Set();
  const queue = [
    '/assets/login-BVkwtAry.js',
    '/assets/login-DUhBXnI4.js',
    '/assets/QueryProvider-D9euiSeb.js',
    '/assets/vendor-router-DclRvQnk.js',
    '/assets/vendor-axios-3RSw9791.js',
    '/assets/vendor-Dk7d1KLu.js',
    '/assets/QueryProvider-D9euiSeb.js',
  ];

  // Also discover dynamically-imported chunks from the JS source
  const chunkRe = /["'`]\.?\/?assets\/([A-Za-z0-9._-]+\.js)["'`]/g;

  while (queue.length > 0) {
    const url = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);
    try {
      const res = await fetch(BASE + url);
      if (!res.ok) continue;
      const js = await res.text();
      const found = harvest(js);
      found.forEach((p) => allPaths.add(p));
      // Discover more chunks
      let m;
      chunkRe.lastIndex = 0;
      while ((m = chunkRe.exec(js)) !== null) {
        const chunkUrl = '/assets/' + m[1];
        if (!visited.has(chunkUrl)) queue.push(chunkUrl);
      }
    } catch {}
  }

  console.log('=== HARVESTED API-ISH STRINGS (' + allPaths.size + ') ===');
  [...allPaths].sort().forEach((p) => console.log(p));
  process.exit(0);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
