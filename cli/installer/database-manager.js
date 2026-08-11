/**
 * Compatibility wrapper for legacy CLI which previously lived here.
 * It now delegates to the shared runtime implementation at src/database/database-manager.js
 *
 * The CLI may continue to call require('./database-manager') as before.
 */
module.exports = require('../../src/database/database-manager');