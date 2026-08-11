/**
 * TypeScript proxy for database-manager.
 * This file exists so TypeScript builds will emit a proxy under dist/src/database/database-manager.proxy.js
 * that re-exports the runtime JS implementation.
 */
import impl = require('./database-manager');
export = impl;
