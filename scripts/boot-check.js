// Boot-time DI/runtime error trap.
// Catches ANY error thrown during NestFactory bootstrap (including module-load
// errors that Node swallows when stdout is not a TTY) and writes it to a file.
const fs = require('fs');
const path = require('path');

const logFile = path.resolve(process.cwd(), 'boot_check.log');
fs.writeFileSync(logFile, ''); // truncate

// Intercept ALL console methods so NestJS Logger output (which may use
// console.log / console.warn / console.error / console.info) is captured to a
// file before process.exit(1) kills the process (Node buffers stdout/stderr
// when not a TTY, so the error message would otherwise be lost).
const origConsoleError = console.error;
const origConsoleLog = console.log;
const origConsoleWarn = console.warn;
const origConsoleInfo = console.info;
const origConsoleFatal = console.fatal;
const fmtArgs = (args) => args.map((a) => (a instanceof Error ? a.stack : typeof a === 'object' ? (() => { try { return JSON.stringify(a, null, 2); } catch { return String(a); } })() : String(a))).join(' ');
function hookConsole(name, orig) {
  console[name] = function (...args) {
    try { fs.appendFileSync(logFile, `[console.${name}] ${fmtArgs(args)}\n`); } catch (_) {}
    orig.apply(console, args);
  };
}
hookConsole('error', origConsoleError);
hookConsole('log', origConsoleLog);
hookConsole('warn', origConsoleWarn);
hookConsole('info', origConsoleInfo);
if (origConsoleFatal) hookConsole('fatal', origConsoleFatal);

// Also intercept raw stdout/stderr writes (Nest Logger may bypass console).
const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origStderrWrite = process.stderr.write.bind(process.stderr);
process.stdout.write = function (chunk, ...rest) {
  try { fs.appendFileSync(logFile, `[stdout] ${typeof chunk === 'string' ? chunk : chunk.toString()}`); } catch (_) {}
  return origStdoutWrite(chunk, ...rest);
};
process.stderr.write = function (chunk, ...rest) {
  try { fs.appendFileSync(logFile, `[stderr] ${typeof chunk === 'string' ? chunk : chunk.toString()}`); } catch (_) {}
  return origStderrWrite(chunk, ...rest);
};

// Intercept process.exit so we can flush the log first AND capture the stack
// to identify exactly which code path triggers the fatal exit.
const origExit = process.exit;
process.exit = function (code) {
  try {
    const stack = new Error('exit-stack').stack || '(no stack)';
    fs.appendFileSync(logFile, `[process.exit] called with code ${code}\nSTACK:\n${stack}\n`);
  } catch (_) {}
  origExit.call(process, code);
};

function dump(prefix, err) {
  const lines = [
    `[${prefix}] ${new Date().toISOString()}`,
    `message: ${err && err.message ? err.message : String(err)}`,
    `stack:`,
    err && err.stack ? err.stack : '(no stack)',
    `name: ${err && err.name ? err.name : 'unknown'}`,
    '',
  ];
  if (err && err.message && err.message.includes('Circular')) {
    lines.push('>>> CIRCULAR DEPENDENCY DETECTED');
  }
  if (err && err.message && /UnknownDependencies|Nest can't resolve/i.test(err.message)) {
    lines.push('>>> NEST DI UNKNOWN DEPENDENCY DETECTED');
  }
  fs.appendFileSync(logFile, lines.join('\n') + '\n');
}

process.on('uncaughtException', (err) => dump('uncaughtException', err));
process.on('unhandledRejection', (err) => dump('unhandledRejection', err));

// KEY PATCH: Nest's ExceptionsZone.asyncRun catches bootstrap errors, calls
// exceptionHandler.handle(e), then DEFAULT_TEARDOWN which is `() => process.exit(1)`
// — swallowing `e`. We monkey-patch the exception handler instance BEFORE
// requiring main.js so the swallowed exception is dumped to the log file.
try {
  const exceptionsZone = require('@nestjs/core/errors/exceptions-zone');
  const handler = exceptionsZone.ExceptionsZone && exceptionsZone.ExceptionsZone.exceptionHandler;
  if (handler && typeof handler.handle === 'function') {
    const origHandle = handler.handle.bind(handler);
    handler.handle = function (e) {
      try {
        dump('ExceptionsZone.exceptionHandler.handle', e);
        // Also dump the full Nest exception structure (message + stack + response)
        if (e) {
          const info = {
            name: e.name,
            message: e.message,
            stack: e.stack,
            response: e.response,
            options: e.options,
          };
          fs.appendFileSync(logFile, `[exception-dump] ${JSON.stringify(info, null, 2)}\n`);
        }
      } catch (_) {}
      return origHandle(e);
    };
    fs.appendFileSync(logFile, `[patch] ExceptionsZone.exceptionHandler.handle hooked\n`);
  } else {
    fs.appendFileSync(logFile, `[patch] WARN: could not find ExceptionsZone.exceptionHandler\n`);
  }
  // Also patch the ExceptionHandler class prototype in case Nest re-instantiates it.
  try {
    const exModule = require('@nestjs/core/errors/exception-handler');
    const ExHandler = exModule.ExceptionHandler || (exModule.default && exModule.default.ExceptionHandler);
    if (ExHandler && ExHandler.prototype && typeof ExHandler.prototype.handle === 'function') {
      const origProto = ExHandler.prototype.handle;
      ExHandler.prototype.handle = function (e) {
        try { dump('ExceptionHandler.prototype.handle', e); } catch (_) {}
        return origProto.call(this, e);
      };
      fs.appendFileSync(logFile, `[patch] ExceptionHandler.prototype.handle hooked\n`);
    }
  } catch (pe) {
    fs.appendFileSync(logFile, `[patch] exception-handler module not found: ${pe.message}\n`);
  }
} catch (pe) {
  fs.appendFileSync(logFile, `[patch] FAILED to patch ExceptionsZone: ${pe && pe.stack ? pe.stack : String(pe)}\n`);
}

fs.appendFileSync(logFile, `[loader] requiring dist/src/main.js\n`);

try {
  require(path.resolve(process.cwd(), 'dist/src/main.js'));
  fs.appendFileSync(logFile, `[loader] require returned without throwing\n`);
} catch (err) {
  dump('require-throw', err);
  process.exit(2);
}

// Keep alive briefly so async bootstrap errors surface.
setTimeout(() => {
  fs.appendFileSync(logFile, `[loader] 15s elapsed, process still alive\n`);
  process.exit(0);
}, 15000);
