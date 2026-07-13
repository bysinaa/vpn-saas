"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.BaseCommand = void 0;
/**
 * Install Command - Install 3x-ui and configure the bot
 */
const child_process_1 = require("child_process");
const util_1 = require("util");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const readline = __importStar(require("readline"));
const execAsync = (0, util_1.promisify)(child_process_1.exec);
class BaseCommand {
    log(message, type = 'info') {
        const prefix = {
            info: '📋',
            success: '✅',
            error: '❌',
            warn: '⚠️',
        }[type];
        console.log(`${prefix} ${message}`);
    }
    async prompt(question) {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });
        return new Promise((resolve) => {
            rl.question(`❓ ${question}: `, (answer) => {
                rl.close();
                resolve(answer);
            });
        });
    }
    async confirm(question, defaultValue = false) {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });
        const suffix = defaultValue ? ' [Y/n]' : ' [y/N]';
        return new Promise((resolve) => {
            rl.question(`❓ ${question}${suffix}: `, (answer) => {
                rl.close();
                const normalized = answer.toLowerCase().trim();
                if (normalized === '')
                    resolve(defaultValue);
                else
                    resolve(normalized === 'y' || normalized === 'yes');
            });
        });
    }
    async select(question, options) {
        console.log(`\n❓ ${question}`);
        options.forEach((opt, i) => {
            console.log(`  ${i + 1}. ${opt.label}`);
        });
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });
        return new Promise((resolve) => {
            rl.question(`\nEnter choice (1-${options.length}): `, (answer) => {
                rl.close();
                const idx = parseInt(answer, 10) - 1;
                if (idx >= 0 && idx < options.length) {
                    resolve(options[idx].value);
                }
                else {
                    resolve(options[0].value);
                }
            });
        });
    }
    async execCommand(cmd, options = {}) {
        try {
            const { stdout, stderr } = await execAsync(cmd, {
                cwd: options.cwd || process.cwd(),
                timeout: options.timeout || 120000,
            });
            return { stdout, stderr };
        }
        catch (error) {
            return { stdout: error.stdout || '', stderr: error.stderr || error.message };
        }
    }
    async fileExists(filePath) {
        try {
            await fs.promises.access(filePath);
            return true;
        }
        catch {
            return false;
        }
    }
    async readFile(filePath) {
        return fs.promises.readFile(filePath, 'utf-8');
    }
    async writeFile(filePath, content) {
        const dir = path.dirname(filePath);
        await fs.promises.mkdir(dir, { recursive: true });
        await fs.promises.writeFile(filePath, content, 'utf-8');
    }
    async appendFile(filePath, content) {
        await fs.promises.appendFile(filePath, content, 'utf-8');
    }
}
exports.BaseCommand = BaseCommand;
//# sourceMappingURL=install.interface.js.map