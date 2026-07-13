"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StatusCommand = void 0;
/**
 * Status Command - System health check
 */
const install_interface_1 = require("./install.interface");
class StatusCommand extends install_interface_1.BaseCommand {
    async execute(options) {
        console.log('\n🔍 VPN SaaS System Status\n');
        console.log('═'.repeat(50));
        const services = [];
        // Check 3x-ui
        services.push(await this.check3xui());
        // Check database
        services.push(await this.checkDatabase());
        // Check Redis
        services.push(await this.checkRedis());
        // Check bot process
        services.push(await this.checkBotProcess());
        // Check ports
        services.push(await this.checkPorts());
        // Display results
        console.log('\n📊 Service Status:\n');
        services.forEach((service) => {
            const icon = service.status === 'online' ? '🟢' : service.status === 'offline' ? '🔴' : '🟡';
            console.log(`  ${icon} ${service.name}: ${service.status}`);
            if (options.verbose && service.message) {
                console.log(`     ${service.message}`);
            }
            if (options.verbose && service.details) {
                console.log(`     Details: ${service.details}`);
            }
        });
        // Summary
        const onlineCount = services.filter((s) => s.status === 'online').length;
        const totalCount = services.length;
        console.log(`\n📈 Summary: ${onlineCount}/${totalCount} services online`);
        if (onlineCount === totalCount) {
            this.log('All systems operational!', 'success');
        }
        else {
            this.log('Some services are not running. Check the details above.', 'warn');
        }
        console.log('');
    }
    async check3xui() {
        try {
            const result = await this.execCommand('x-ui status 2>/dev/null || systemctl status x-ui 2>/dev/null | head -5');
            const isRunning = result.stdout.includes('running') || result.stdout.includes('active');
            return {
                name: '3x-UI',
                status: isRunning ? 'online' : 'offline',
                message: isRunning ? 'Service is running' : 'Service is not running',
                details: result.stdout.substring(0, 200),
            };
        }
        catch {
            return { name: '3x-UI', status: 'unknown', message: 'Unable to check status' };
        }
    }
    async checkDatabase() {
        try {
            const result = await this.execCommand('pg_isready -h localhost -p 5432 2>/dev/null || systemctl is-active postgresql');
            const isReady = result.stdout.includes('accepting connections') || result.stdout.includes('active');
            return {
                name: 'PostgreSQL',
                status: isReady ? 'online' : 'offline',
                message: isReady ? 'Database is accepting connections' : 'Database is not responding',
            };
        }
        catch {
            return { name: 'PostgreSQL', status: 'unknown', message: 'Unable to check status' };
        }
    }
    async checkRedis() {
        try {
            const result = await this.execCommand('redis-cli ping 2>/dev/null || systemctl is-active redis-server');
            const isReady = result.stdout.includes('PONG') || result.stdout.includes('active');
            return {
                name: 'Redis',
                status: isReady ? 'online' : 'offline',
                message: isReady ? 'Redis is responding' : 'Redis is not responding',
            };
        }
        catch {
            return { name: 'Redis', status: 'unknown', message: 'Unable to check status' };
        }
    }
    async checkBotProcess() {
        try {
            const result = await this.execCommand('pgrep -f "node.*main.js" 2>/dev/null || pgrep -f "nest start" 2>/dev/null');
            const isRunning = result.stdout.trim().length > 0;
            return {
                name: 'VPN SaaS Bot',
                status: isRunning ? 'online' : 'offline',
                message: isRunning ? 'Bot process is running' : 'Bot process is not running',
                details: isRunning ? `PID: ${result.stdout.trim()}` : undefined,
            };
        }
        catch {
            return { name: 'VPN SaaS Bot', status: 'unknown', message: 'Unable to check status' };
        }
    }
    async checkPorts() {
        const ports = [2053, 2096, 3000, 6379, 5432];
        const openPorts = [];
        for (const port of ports) {
            try {
                const result = await this.execCommand(`netstat -tln 2>/dev/null | grep ':${port}' || ss -tln 2>/dev/null | grep ':${port}'`);
                if (result.stdout.includes(`${port}`)) {
                    openPorts.push(port.toString());
                }
            }
            catch {
                // Port check failed
            }
        }
        return {
            name: 'Network Ports',
            status: openPorts.length > 0 ? 'online' : 'offline',
            message: `Open ports: ${openPorts.length > 0 ? openPorts.join(', ') : 'None detected'}`,
            details: `Expected: ${ports.join(', ')}`,
        };
    }
}
exports.StatusCommand = StatusCommand;
//# sourceMappingURL=status.js.map