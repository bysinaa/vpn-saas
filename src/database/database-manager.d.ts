/**
 * Minimal module declaration for the JS runtime implementation at src/database/database-manager.js
 * Exporting a top-level `export =` makes this file an external module TypeScript can import with:
 *   import impl = require('./database-manager');
 *
 * Keep this intentionally permissive (any) to avoid changing runtime behaviour.
 */
declare const impl: any;
export = impl;
