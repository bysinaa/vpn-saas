(async () => {
  try {
    const manager = require('../src/database/database-manager');
    const res = await manager.resolveRuntime({ discover: false, writeEnv: false, generateIsolated: false });
    console.log(JSON.stringify({ ok: true, result: res }, null, 2));
    process.exit(0);
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: String(e), stack: e && e.stack }, null, 2));
    process.exit(2);
  }
})();