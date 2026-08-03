#!/usr/bin/env node
'use strict';

/** Thin compatibility adapter for the read-only PostgresDetector. */
const { createPostgresDetector } = require('./postgres-detector');

async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('Usage: detect-db [--json]');
    return null;
  }
  const result = await createPostgresDetector().discover();
  console.log(`${result.status}: ${result.connection ? `${result.connection.host}:${result.connection.port}/${result.connection.database}` : 'no PostgreSQL candidate'}`);
  for (const diagnostic of result.diagnostics) console.log(`- ${diagnostic.code}`);
  return result;
}

if (require.main === module) main().catch((error) => { console.error(`detect-db: ${error.message}`); process.exitCode = 1; });
module.exports = { main };
