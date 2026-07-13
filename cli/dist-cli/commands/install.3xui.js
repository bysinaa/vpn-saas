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
exports.InstallCommand = void 0;
/**
 * Install Command - Install 3x-ui and configure the bot
 */
const install_interface_1 = require("./install.interface");
const https = __importStar(require("https"));
const http = __importStar(require("http"));
const url_1 = require("url");
class InstallCommand extends install_interface_1.BaseCommand {
    constructor() {
        super(...arguments);
        this.XUI_REPO = 'mhsanaei/3x-ui';
        this.XUI_TAG = 'v2.3.2';
        this.XUI_INSTALL_URL = `https://raw.githubusercontent.com/${this.XUI_REPO}/${this.XUI_TAG}/install.sh`;
    }
    async execute(options) {
        console.log('\n🚀 VPN SaaS Server Installer\n');
        console.log('═'.repeat(50));
        // Check if running as root
        const isRoot = process.getuid?.() === 0 || process.env.USER === 'root';
        if (!isRoot) {
            this.log('Warning: Running as non-root. Some operations may fail.', 'warn');
        }
        // Detect if 3x-ui is already installed
        const has3xui = await this.check3xuiInstalled();
        if (has3xui) {
            this.log('3x-ui is already installed on this server', 'info');
            await this.handleExisting3xui(options);
        }
        else {
            this.log('3x-ui is not installed', 'info');
            await this.handleNew3xui(options);
        }
        // Configure the bot
        await this.configureBot(options);
        // Final instructions
        await this.showFinalInstructions();
    }
    async check3xuiInstalled() {
        const result = await this.execCommand('which x-ui');
        return result.stdout.includes('x-ui') || await this.fileExists('/usr/local/x-ui/x-ui');
    }
    async get3xuiStatus() {
        const result = await this.execCommand('x-ui status 2>/dev/null || systemctl status x-ui 2>/dev/null || service x-ui status 2>/dev/null');
        const running = result.stdout.includes('running') || result.stdout.includes('active');
        // Try to get config from x-ui settings
        let port = 2053;
        let subPath = 'sub';
        let subPort = 2053; // Default subscription port (same as panel port in 3x-UI)
        try {
            // Try to read 3x-UI config file
            const configResult = await this.execCommand('cat /etc/x-ui/x-ui.db 2>/dev/null | strings | grep -i port | head -5 || cat /usr/local/x-ui/x-ui.db 2>/dev/null | strings | grep -i port | head -5');
            if (configResult.stdout) {
                const portMatch = configResult.stdout.match(/(\d{4,5})/);
                if (portMatch)
                    port = parseInt(portMatch[1], 10);
            }
        }
        catch { /* ignore */ }
        return { running, port, subPath, subPort };
    }
    async handleExisting3xui(options) {
        console.log('\n📡 Connecting to existing 3x-ui installation...\n');
        const status = await this.get3xuiStatus();
        this.log(`Status: ${status.running ? 'Running' : 'Stopped'}`, status.running ? 'success' : 'warn');
        this.log(`Panel Port: ${status.port}`, 'info');
        this.log(`Sub Port: ${status.subPort}`, 'info');
        // Get server IP
        const serverIp = await this.getServerIp();
        this.log(`Server IP: ${serverIp}`, 'info');
        // Get panel credentials
        let panelUrl = options.panelUrl;
        let panelUser = options.panelUser;
        let panelPass = options.panelPass;
        if (!panelUrl) {
            panelUrl = `http://${serverIp}:${status.port}`;
            const useDefault = await this.confirm(`Use default panel URL: ${panelUrl}`, true);
            if (!useDefault) {
                panelUrl = await this.prompt(`Panel URL (e.g., http://${serverIp}:${status.port})`);
            }
        }
        if (!panelUser) {
            panelUser = await this.prompt('3x-ui Username (default: admin)');
            panelUser = panelUser || 'admin';
        }
        if (!panelPass) {
            panelPass = await this.prompt('3x-ui Password');
        }
        // Test connection
        this.log('Testing panel connection...', 'info');
        const connected = await this.testPanelConnection(panelUrl, panelUser, panelPass);
        if (!connected) {
            this.log('Failed to connect to panel. Please check credentials.', 'error');
            process.exit(1);
        }
        this.log('Panel connection successful!', 'success');
        // Sync existing users
        await this.syncExistingUsers(panelUrl, panelUser, panelPass);
        // Save panel info
        await this.savePanelConfig({ url: panelUrl, user: panelUser, pass: panelPass, subPort: status.subPort, subPath: status.subPath });
    }
    async handleNew3xui(options) {
        console.log('\n📦 Installing 3x-ui from GitHub...\n');
        const install3xui = options.skip3xui
            ? false
            : await this.confirm('Do you want to install 3x-ui now?', true);
        if (!install3xui) {
            this.log('Skipping 3x-ui installation. You can install it manually later.', 'warn');
            return;
        }
        // Download and run install script
        this.log('Downloading 3x-ui installation script...', 'info');
        const downloadResult = await this.downloadFile(this.XUI_INSTALL_URL);
        if (!downloadResult) {
            this.log('Failed to download installation script', 'error');
            process.exit(1);
        }
        // Save and run install script
        const installScriptPath = '/tmp/3x-ui-install.sh';
        await this.writeFile(installScriptPath, downloadResult);
        await this.execCommand(`chmod +x ${installScriptPath}`);
        this.log('Running installation script (this may take a few minutes)...', 'info');
        const installResult = await this.execCommand(`bash ${installScriptPath}`, { timeout: 300000 });
        if (installResult.stderr && !installResult.stderr.includes('warn')) {
            this.log(`Installation output: ${installResult.stdout}`, 'warn');
        }
        // Check if installed
        const installed = await this.check3xuiInstalled();
        if (!installed) {
            this.log('3x-ui installation may have failed. Please check manually.', 'error');
        }
        else {
            this.log('3x-ui installed successfully!', 'success');
        }
        // Configure 3x-ui
        await this.configure3xui(options);
    }
    async configure3xui(options) {
        this.log('\n⚙️ Configuring 3x-ui...', 'info');
        // Set panel port
        const panelPort = await this.prompt('Enter panel port (default: 2053)');
        const port = parseInt(panelPort, 10) || 2053;
        // Set subscription port
        const subPort = await this.prompt('Enter subscription port (default: 2096)');
        const subscriptionPort = parseInt(subPort, 10) || 2096;
        // Set subscription path
        const subPath = await this.prompt('Enter subscription path (default: sub)');
        const subscriptionPath = subPath || 'sub';
        // Configure via x-ui command
        await this.execCommand(`x-ui set port ${port}`);
        await this.execCommand(`x-ui set sub-port ${subscriptionPort}`);
        await this.execCommand(`x-ui set sub-path ${subscriptionPath}`);
        // Restart service
        await this.execCommand('systemctl restart x-ui 2>/dev/null || service x-ui restart 2>/dev/null || x-ui restart 2>/dev/null');
        this.log('3x-ui configured!', 'success');
        // Get server IP
        const serverIp = await this.getServerIp();
        const panelUrl = `http://${serverIp}:${port}`;
        // Get admin credentials
        let panelUser = options.panelUser || 'admin';
        let panelPass = options.panelPass || await this.prompt('Set 3x-ui admin password');
        // Save panel config
        await this.savePanelConfig({
            url: panelUrl,
            user: panelUser,
            pass: panelPass,
            subPort: subscriptionPort,
            subPath: subscriptionPath,
        });
    }
    async configureBot(options) {
        console.log('\n🤖 Configuring VPN SaaS Bot...\n');
        const serverIp = await this.getServerIp();
        // Get required config
        let botToken = options.panelUrl ? '' : await this.prompt('Enter Telegram Bot Token');
        let databaseUrl = process.env.DATABASE_URL || '';
        let redisUrl = process.env.REDIS_URL || '';
        if (!databaseUrl) {
            const hasPostgres = await this.checkPostgresInstalled();
            if (hasPostgres) {
                databaseUrl = `postgresql://postgres:password@localhost:5432/vpn_saas`;
            }
            else {
                const installDb = await this.confirm('Install PostgreSQL?', true);
                if (installDb) {
                    await this.installPostgres();
                    databaseUrl = `postgresql://postgres:password@localhost:5432/vpn_saas`;
                }
            }
        }
        if (!redisUrl) {
            const hasRedis = await this.checkRedisInstalled();
            if (hasRedis) {
                redisUrl = 'redis://localhost:6379';
            }
            else {
                const installRedis = await this.confirm('Install Redis?', true);
                if (installRedis) {
                    await this.installRedis();
                    redisUrl = 'redis://localhost:6379';
                }
            }
        }
        // Create .env file
        const envContent = this.generateEnvFile({
            botToken: botToken || process.env.TELEGRAM_BOT_TOKEN || '',
            databaseUrl,
            redisUrl,
            serverIp,
        });
        await this.writeFile('.env', envContent);
        this.log('.env file created!', 'success');
        // Install npm dependencies
        this.log('Installing npm dependencies...', 'info');
        await this.execCommand('npm install', { timeout: 180000 });
        // Generate Prisma client
        this.log('Generating Prisma client...', 'info');
        await this.execCommand('npx prisma generate');
        // Run migrations
        this.log('Running database migrations...', 'info');
        await this.execCommand('npx prisma migrate deploy');
    }
    async showFinalInstructions() {
        console.log('\n' + '═'.repeat(50));
        console.log('✅ Installation Complete!\n');
        console.log('Next steps:');
        console.log('1. Edit .env file with your settings');
        console.log('2. Start the bot: npm run start:prod');
        console.log('3. Access admin panel via Telegram bot');
        console.log('\nUseful commands:');
        console.log('  x-ui status     - Check 3x-ui status');
        console.log('  x-ui log        - View 3x-ui logs');
        console.log('  x-ui panel      - Open panel in browser');
        console.log('\n' + '═'.repeat(50));
    }
    async getServerIp() {
        const result = await this.execCommand('curl -s ifconfig.me 2>/dev/null || curl -s ipinfo.io/ip 2>/dev/null || hostname -I | awk \'{print $1}\'');
        return result.stdout.trim() || 'localhost';
    }
    async testPanelConnection(url, user, pass) {
        try {
            const loginData = JSON.stringify({ username: user, password: pass });
            const result = await this.httpRequest({
                url: `${url}/login`,
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(loginData)) },
                body: loginData,
            });
            return result.includes('success') || result.includes('token');
        }
        catch {
            return false;
        }
    }
    async syncExistingUsers(url, user, pass) {
        this.log('Syncing existing users from panel...', 'info');
        // This will be handled by the bot's panel sync feature
        this.log('Users will be synced when the bot starts', 'info');
    }
    async savePanelConfig(config) {
        const configPath = '.3xui-config.json';
        const configData = {
            panelUrl: config.url,
            panelUser: config.user,
            panelPass: config.pass,
            subPort: config.subPort,
            subPath: config.subPath,
            updatedAt: new Date().toISOString(),
        };
        await this.writeFile(configPath, JSON.stringify(configData, null, 2));
        this.log('Panel configuration saved!', 'success');
    }
    async checkPostgresInstalled() {
        const result = await this.execCommand('which psql 2>/dev/null || which postgres 2>/dev/null');
        return result.stdout.length > 0;
    }
    async checkRedisInstalled() {
        const result = await this.execCommand('which redis-server 2>/dev/null');
        return result.stdout.length > 0;
    }
    async installPostgres() {
        this.log('Installing PostgreSQL...', 'info');
        await this.execCommand('apt-get update && apt-get install -y postgresql postgresql-contrib', { timeout: 180000 });
        await this.execCommand('systemctl start postgresql');
        await this.execCommand('systemctl enable postgresql');
        await this.execCommand('su - postgres -c "psql -c \\"CREATE DATABASE vpn_saas;\\""');
        await this.execCommand('su - postgres -c "psql -c \\"ALTER USER postgres WITH PASSWORD \'password\';\\""');
        this.log('PostgreSQL installed!', 'success');
    }
    async installRedis() {
        this.log('Installing Redis...', 'info');
        await this.execCommand('apt-get update && apt-get install -y redis-server', { timeout: 120000 });
        await this.execCommand('systemctl start redis-server');
        await this.execCommand('systemctl enable redis-server');
        this.log('Redis installed!', 'success');
    }
    async downloadFile(url) {
        return new Promise((resolve) => {
            const protocol = url.startsWith('https') ? https : http;
            protocol.get(url, (res) => {
                if (res.statusCode !== 200) {
                    resolve(null);
                    return;
                }
                let data = '';
                res.on('data', (chunk) => (data += chunk));
                res.on('end', () => resolve(data));
                res.on('error', () => resolve(null));
            }).on('error', () => resolve(null));
        });
    }
    async httpRequest(options) {
        return new Promise((resolve, reject) => {
            const url = new url_1.URL(options.url);
            const protocol = url.protocol === 'https:' ? https : http;
            const reqOptions = {
                hostname: url.hostname,
                port: url.port,
                path: url.pathname,
                method: options.method,
                headers: options.headers,
            };
            const req = protocol.request(reqOptions, (res) => {
                let data = '';
                res.on('data', (chunk) => (data += chunk));
                res.on('end', () => resolve(data));
                res.on('error', reject);
            });
            req.on('error', reject);
            if (options.body)
                req.write(options.body);
            req.end();
        });
    }
    generateEnvFile(config) {
        return `# VPN SaaS Environment Configuration
# Generated by CLI installer

# App
NODE_ENV=production
APP_NAME="VPN SaaS"
APP_PORT=3000
APP_HOST=0.0.0.0
APP_URL=http://${config.serverIp}:3000

# Database
DATABASE_URL=${config.databaseUrl}

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_DB=0

# Telegram
TELEGRAM_BOT_TOKEN=${config.botToken}
TELEGRAM_BOT_WEBHOOK_URL=
TELEGRAM_BOT_USE_WEBHOOK=false
TELEGRAM_ADMIN_IDS=

# Security
JWT_ACCESS_SECRET=change-this-in-production
JWT_REFRESH_SECRET=change-this-in-production
BCRYPT_ROUNDS=12
ENCRYPTION_KEY=change-this-32-char-key-in-prod

# 3x-UI Panel (will be updated by panel command)
# Format: panelUrl:panelUser:panelPass:subPort:subPath
# VPN_PANEL_CONNECTION=

# Monitoring
PINO_LEVEL=info
PINO_PRETTY=true
`;
    }
}
exports.InstallCommand = InstallCommand;
//# sourceMappingURL=install.3xui.js.map