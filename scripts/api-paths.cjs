const j = require('../openapi.json');
const paths = Object.keys(j.paths);
paths.forEach(p => {
  const methods = Object.keys(j.paths[p]).join(',');
  console.log(`${p} [${methods}]`);
});