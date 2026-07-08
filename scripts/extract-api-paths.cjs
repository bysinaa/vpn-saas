/* Extract all quoted string paths from the QueryProvider bundle to discover
 * the real 3x-ui API endpoint structure used by the React frontend.
 */
const fetch = require('node-fetch');
const BASE = 'http://127.0.0.1:2053';

(async () => {
  const bundles = [
    '/assets/QueryProvider-D9euiSeb.js',
    '/assets/vendor-Dk7d1KLu.js',
    '/assets/vendor-router-DclRvQnk.js',
  ];
  const paths = new Set();
  for (const b of bundles) {
    const res = await fetch(BASE + b);
    const js = await res.text();
    // Match single/double/backtick quoted strings starting with /
    const re = /["'`]([/][a-zA-Z0-9/_{}.-]{3,80})["'`]/g;
    let m;
    while ((m = re.exec(js)) !== null) {
      const v = m[1];
      // Filter out asset/static paths
      if (!/\.(js|css|png|svg|woff|ttf|ico|map)$/.test(v) && !v.includes('/assets/')) {
        paths.add(v);
      }
    }
  }
  console.log('=== ALL QUOTED PATHS ===');
  [...paths].sort().forEach((p) => console.log(p));
  process.exit(0);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
