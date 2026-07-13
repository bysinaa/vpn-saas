"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StatusCommand = void 0;
/**
 * Status Command - Production runtime health inspection.
 */
const install_interface_1 = require("./install.interface");
class StatusCommand extends install_interface_1.BaseCommand {
    async execute(options) {
        this.setExecutionMode(options);
        this.section('VPN SaaS Health Status');
        const runtime = await this.loadRuntimeConfig();
        const services = await Promise.all([
            this.checkDocker(),
            this.checkCompose(),
            this.check3xui(runtime.panel?.subscriptionPort),
            this.checkDatabase(),
            this.checkRedis(),
            this.checkApplication(),
            this.checkConfiguredPorts(runtime.panel?.subscriptionPort),
        ]);
        services.forEach((service) => {
            const icon = service.status === 'online' ? '🟢' :
                service.status === 'offline' ? '🔴' :
                    '🟡';
            console.log(`${icon} ${service.name}: ${service.summary}`);
            if (options.verbose && service.details) {
                console.log(`   ${service.details}`);
            }
        });
        const onlineCount = services.filter((item) => item.status === 'online').length;
        console.log(`\n${onlineCount}/${services.length} checks passing`);
        if (onlineCount === services.length) {
            this.log('Platform health checks passed.', 'success');
        }
        else {
            this.log('One or more platform checks need attention.', 'warn');
        }
    }
    async checkDocker() {
        const result = await this.execCommand('docker --version', { allowFailure: true });
        return {
            name: 'Docker',
            status: result.ok ? 'online' : 'offline',
            summary: result.ok ? result.stdout.trim() : 'Docker is not installed or unavailable',
            details: result.stderr.trim() || undefined,
        };
    }
    async checkCompose() {
        const result = await this.execCommand('docker compose version', { allowFailure: true });
        return {
            name: 'Docker Compose',
            status: result.ok ? 'online' : 'offline',
            summary: result.ok ? result.stdout.trim() : 'Docker Compose plugin is not available',
            details: result.stderr.trim() || undefined,
        };
    }
    async check3xui(subscriptionPort) {
        const result = await this.execCommand('x-ui status 2>/dev/null || systemctl is-active x-ui 2>/dev/null || service x-ui status 2>/dev/null', { allowFailure: true });
        const output = `${result.stdout}\n${result.stderr}`.trim();
        const running = /running|active/i.test(output);
        return {
            name: '3X-UI',
            status: running ? 'online' : result.ok ? 'offline' : 'unknown',
            summary: running ? `3X-UI is running${subscriptionPort ? ` (sub port ${subscriptionPort})` : ''}` : '3X-UI is not confirmed running',
            details: output || undefined,
        };
    }
    async checkDatabase() {
        const result = await this.execCommand('pg_isready -h localhost -p 5432 2>/dev/null || systemctl is-active postgresql 2>/dev/null', { allowFailure: true });
        const output = `${result.stdout}\n${result.stderr}`.trim();
        const ready = /accepting connections|active/i.test(output);
        return {
            name: 'PostgreSQL',
            status: ready ? 'online' : result.ok ? 'offline' : 'unknown',
            summary: ready ? 'PostgreSQL is accepting connections' : 'PostgreSQL is not ready',
            details: output || undefined,
        };
    }
    async checkRedis() {
        const result = await this.execCommand('redis-cli ping 2>/dev/null || systemctl is-active redis-server 2>/dev/null', { allowFailure: true });
        const output = `${result.stdout}\n${result.stderr}`.trim();
        const ready = /PONG|active/i.test(output);
        return {
            name: 'Redis',
            status: ready ? 'online' : result.ok ? 'offline' : 'unknown',
            summary: ready ? 'Redis is responding' : 'Redis is not responding',
            details: output || undefined,
        };
    }
    async checkApplication() {
        const processResult = await this.execCommand('docker compose ps 2>/dev/null || pgrep -af "node.*dist/main.js" 2>/dev/null || pgrep -af "nest start" 2>/dev/null', { allowFailure: true });
        const output = `${processResult.stdout}\n${processResult.stderr}`.trim();
        const running = /Up|running|node|nest/i.test(output);
        return {
            name: 'VPN SaaS Application',
            status: running ? 'online' : processResult.ok ? 'offline' : 'unknown',
            summary: running ? 'Application process/container detected' : 'Application process not detected',
            details: output || undefined,
        };
    }
    async checkConfiguredPorts(subscriptionPort) {
        const ports = [80, 443, 3000, 5432, 6379];
        if (subscriptionPort) {
            ports.push(subscriptionPort);
        }
        const statuses = await Promise.all(ports.map((port) => this.inspectPort(port)));
        const openPorts = statuses.filter((item) => item.inUse).map((item) => item.port);
        return {
            name: 'Configured Ports',
            status: openPorts.length > 0 ? 'online' : 'offline',
            summary: openPorts.length > 0 ? `In use: ${openPorts.join(', ')}` : 'No expected ports detected',
            details: statuses.map((item) => `${item.port}=${item.inUse ? 'used' : 'free'}`).join(', '),
        };
    }
}
exports.StatusCommand = StatusCommand;
//# sourceMappingURL=status.js.map