/**
 * Install Command - Install 3x-ui and configure the bot
 */
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

const execAsync = promisify(exec);

export interface InstallOptions {
  yes?: boolean;
  skip3xui?: boolean;
  panelUrl?: string;
  panelUser?: string;
  panelPass?: string;
  interactive?: boolean;
}

export interface InstallContext {
  serverIp: string;
  panelUrl: string;
  panelUser: string;
  panelPass: string;
  subPath: string;
  subPort: number;
  botToken: string;
  databaseUrl: string;
  redisUrl: string;
}

export abstract class BaseCommand {
  protected log(message: string, type: 'info' | 'success' | 'error' | 'warn' = 'info') {
    const prefix = {
      info: '📋',
      success: '✅',
      error: '❌',
      warn: '⚠️',
    }[type];
    console.log(`${prefix} ${message}`);
  }

  protected async prompt(question: string): Promise<string> {
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

  protected async confirm(question: string, defaultValue = false): Promise<boolean> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const suffix = defaultValue ? ' [Y/n]' : ' [y/N]';
    return new Promise((resolve) => {
      rl.question(`❓ ${question}${suffix}: `, (answer) => {
        rl.close();
        const normalized = answer.toLowerCase().trim();
        if (normalized === '') resolve(defaultValue);
        else resolve(normalized === 'y' || normalized === 'yes');
      });
    });
  }

  protected async select<T extends string>(
    question: string,
    options: { value: T; label: string }[],
  ): Promise<T> {
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
        } else {
          resolve(options[0].value);
        }
      });
    });
  }

  protected async execCommand(
    cmd: string,
    options: { cwd?: string; timeout?: number } = {},
  ): Promise<{ stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await execAsync(cmd, {
        cwd: options.cwd || process.cwd(),
        timeout: options.timeout || 120000,
      });
      return { stdout, stderr };
    } catch (error: any) {
      return { stdout: error.stdout || '', stderr: error.stderr || error.message };
    }
  }

  protected async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.promises.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  protected async readFile(filePath: string): Promise<string> {
    return fs.promises.readFile(filePath, 'utf-8');
  }

  protected async writeFile(filePath: string, content: string): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(filePath, content, 'utf-8');
  }

  protected async appendFile(filePath: string, content: string): Promise<void> {
    await fs.promises.appendFile(filePath, content, 'utf-8');
  }
}