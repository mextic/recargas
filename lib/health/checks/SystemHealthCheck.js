/**
 * SystemHealthCheck - FASE 5: Health Check para Recursos del Sistema
 * Monitoreo de CPU, memoria, disco y proceso con métricas detalladas
 */
const os = require('os');
const fs = require('fs').promises;
const path = require('path');

class SystemHealthCheck {
    constructor() {
        this.name = 'SYSTEM';
        this.consecutiveFailures = 0;
        this.lastSuccess = null;
        this.metricsHistory = [];
        
        // Thresholds configurables por variables de entorno
        this.thresholds = {
            cpu: parseInt(process.env.HEALTH_CPU_THRESHOLD) || 80,        // 80%
            memory: parseInt(process.env.HEALTH_MEMORY_THRESHOLD) || 90,  // 90%
            disk: parseInt(process.env.HEALTH_DISK_THRESHOLD) || 95       // 95%
        };
        
        console.log(`⚙️ System Health Check inicializado`);
        console.log(`🎯 Thresholds: CPU ${this.thresholds.cpu}%, Memory ${this.thresholds.memory}%, Disk ${this.thresholds.disk}%`);
    }

    async check() {
        const timestamp = Date.now();
        
        try {
            console.log('🔍 Verificando recursos del sistema...');
            
            // Recopilar todas las métricas del sistema
            const metrics = {
                cpu: await this.getCPUUsage(),
                memory: this.getMemoryUsage(),
                disk: await this.getDiskUsage(),
                process: this.getProcessInfo(),
                uptime: this.getUptimeInfo(),
                loadAverage: this.getLoadAverage()
            };

            // Evaluar estado general del sistema
            const healthStatus = this.evaluateSystemHealth(metrics);
            
            this.updateMetricsHistory(metrics);
            
            if (healthStatus.status === 'healthy' || healthStatus.status === 'degraded') {
                this.consecutiveFailures = 0;
                this.lastSuccess = timestamp;
                console.log(`✅ Sistema: ${healthStatus.status} - CPU: ${metrics.cpu.usage}%, RAM: ${metrics.memory.usagePercent}%`);
            } else {
                this.consecutiveFailures++;
                console.warn(`⚠️ Sistema: ${healthStatus.status} - Problemas detectados`);
            }
            
            return {
                status: healthStatus.status,
                timestamp,
                consecutiveFailures: this.consecutiveFailures,
                lastSuccess: this.lastSuccess,
                details: {
                    ...metrics,
                    healthEvaluation: healthStatus.issues,
                    thresholds: this.thresholds
                }
            };
            
        } catch (error) {
            this.consecutiveFailures++;
            console.error(`❌ System Health Check falló:`, error.message);
            
            return {
                status: 'unhealthy',
                error: error.message,
                timestamp,
                consecutiveFailures: this.consecutiveFailures,
                lastSuccess: this.lastSuccess
            };
        }
    }

    async getCPUUsage() {
        return new Promise((resolve) => {
            const startMeasure = this.cpuAverage();
            
            setTimeout(() => {
                const endMeasure = this.cpuAverage();
                const idleDifference = endMeasure.idle - startMeasure.idle;
                const totalDifference = endMeasure.total - startMeasure.total;
                const usage = 100 - ~~(100 * idleDifference / totalDifference);
                
                resolve({
                    usage: usage,
                    cores: os.cpus().length,
                    model: os.cpus()[0]?.model || 'Unknown',
                    loadAverage: os.loadavg()
                });
            }, 1000);
        });
    }

    cpuAverage() {
        const cpus = os.cpus();
        let user = 0, nice = 0, sys = 0, idle = 0, irq = 0;
        
        cpus.forEach(cpu => {
            user += cpu.times.user;
            nice += cpu.times.nice;
            sys += cpu.times.sys;
            idle += cpu.times.idle;
            irq += cpu.times.irq;
        });
        
        const total = user + nice + sys + idle + irq;
        
        return { idle, total };
    }

    getMemoryUsage() {
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;
        const usagePercent = Math.round((usedMem / totalMem) * 100);
        
        // Información específica del proceso Node.js
        const processMemory = process.memoryUsage();
        
        return {
            total: totalMem,
            free: freeMem,
            used: usedMem,
            usagePercent,
            totalGB: (totalMem / (1024 * 1024 * 1024)).toFixed(2),
            usedGB: (usedMem / (1024 * 1024 * 1024)).toFixed(2),
            freeGB: (freeMem / (1024 * 1024 * 1024)).toFixed(2),
            process: {
                rss: processMemory.rss,
                heapTotal: processMemory.heapTotal,
                heapUsed: processMemory.heapUsed,
                external: processMemory.external,
                rssMB: (processMemory.rss / (1024 * 1024)).toFixed(2),
                heapUsedMB: (processMemory.heapUsed / (1024 * 1024)).toFixed(2)
            }
        };
    }

    async getDiskUsage() {
        try {
            // Obtener información del directorio actual (donde está la aplicación)
            const currentDir = process.cwd();
            const stats = await fs.stat(currentDir);
            
            // En sistemas Unix, intentar obtener información de disco
            if (process.platform !== 'win32') {
                try {
                    const { spawn } = require('child_process');
                    return new Promise((resolve) => {
                        const df = spawn('df', ['-h', currentDir]);
                        let output = '';
                        
                        df.stdout.on('data', (data) => {
                            output += data.toString();
                        });
                        
                        df.on('close', () => {
                            const lines = output.trim().split('\n');
                            if (lines.length >= 2) {
                                const diskInfo = lines[1].split(/\s+/);
                                const usagePercent = parseInt(diskInfo[4]?.replace('%', '')) || 0;
                                
                                resolve({
                                    path: currentDir,
                                    total: diskInfo[1] || 'unknown',
                                    used: diskInfo[2] || 'unknown',
                                    available: diskInfo[3] || 'unknown',
                                    usagePercent,
                                    filesystem: diskInfo[0] || 'unknown'
                                });
                            } else {
                                resolve(this.getFallbackDiskInfo(currentDir));
                            }
                        });
                        
                        // Timeout después de 5 segundos
                        setTimeout(() => {
                            df.kill();
                            resolve(this.getFallbackDiskInfo(currentDir));
                        }, 5000);
                    });
                } catch (error) {
                    return this.getFallbackDiskInfo(currentDir);
                }
            } else {
                // Para Windows, información básica
                return this.getFallbackDiskInfo(currentDir);
            }
        } catch (error) {
            return {
                path: process.cwd(),
                error: error.message,
                usagePercent: 0
            };
        }
    }

    getFallbackDiskInfo(currentDir) {
        return {
            path: currentDir,
            total: 'unknown',
            used: 'unknown', 
            available: 'unknown',
            usagePercent: 0,
            note: 'Disk usage detection not available on this platform'
        };
    }

    getProcessInfo() {
        return {
            pid: process.pid,
            uptime: process.uptime(),
            uptimeFormatted: this.formatUptime(process.uptime()),
            nodeVersion: process.version,
            platform: process.platform,
            arch: process.arch,
            cwd: process.cwd(),
            execPath: process.execPath,
            argv: process.argv.slice(2), // Argumentos sin node y script name
            env: process.env.NODE_ENV || 'development'
        };
    }

    getUptimeInfo() {
        const systemUptime = os.uptime();
        const processUptime = process.uptime();
        
        return {
            system: systemUptime,
            systemFormatted: this.formatUptime(systemUptime),
            process: processUptime,
            processFormatted: this.formatUptime(processUptime)
        };
    }

    getLoadAverage() {
        const loadAvg = os.loadavg();
        const cpuCount = os.cpus().length;
        
        return {
            '1min': loadAvg[0].toFixed(2),
            '5min': loadAvg[1].toFixed(2),
            '15min': loadAvg[2].toFixed(2),
            cpuCount,
            loadPercentage: {
                '1min': ((loadAvg[0] / cpuCount) * 100).toFixed(1),
                '5min': ((loadAvg[1] / cpuCount) * 100).toFixed(1),
                '15min': ((loadAvg[2] / cpuCount) * 100).toFixed(1)
            }
        };
    }

    evaluateSystemHealth(metrics) {
        const issues = [];
        let status = 'healthy';
        
        // Evaluar CPU
        if (metrics.cpu.usage > this.thresholds.cpu) {
            issues.push(`High CPU usage: ${metrics.cpu.usage}% (threshold: ${this.thresholds.cpu}%)`);
            status = metrics.cpu.usage > 95 ? 'unhealthy' : 'degraded';
        }
        
        // Evaluar memoria
        if (metrics.memory.usagePercent > this.thresholds.memory) {
            issues.push(`High memory usage: ${metrics.memory.usagePercent}% (threshold: ${this.thresholds.memory}%)`);
            status = metrics.memory.usagePercent > 98 ? 'unhealthy' : 'degraded';
        }
        
        // Evaluar disco
        if (metrics.disk.usagePercent > this.thresholds.disk) {
            issues.push(`High disk usage: ${metrics.disk.usagePercent}% (threshold: ${this.thresholds.disk}%)`);
            status = metrics.disk.usagePercent > 99 ? 'unhealthy' : 'degraded';
        }
        
        // Evaluar load average (solo en sistemas Unix)
        if (metrics.loadAverage && metrics.loadAverage.loadPercentage) {
            const load1min = parseFloat(metrics.loadAverage.loadPercentage['1min']);
            if (load1min > 100) {
                issues.push(`High system load: ${load1min}% (1min average)`);
                if (status === 'healthy') status = 'degraded';
            }
        }
        
        // Evaluar memoria del proceso
        const processMemoryMB = parseFloat(metrics.memory.process.rssMB);
        if (processMemoryMB > 1000) { // Si el proceso usa más de 1GB
            issues.push(`High process memory usage: ${processMemoryMB}MB`);
            if (status === 'healthy') status = 'degraded';
        }
        
        return { status, issues };
    }

    updateMetricsHistory(metrics) {
        const historyEntry = {
            timestamp: Date.now(),
            cpu: metrics.cpu.usage,
            memory: metrics.memory.usagePercent,
            disk: metrics.disk.usagePercent,
            processMemory: parseFloat(metrics.memory.process.rssMB)
        };
        
        this.metricsHistory.unshift(historyEntry);
        
        // Mantener solo las últimas 50 mediciones
        if (this.metricsHistory.length > 50) {
            this.metricsHistory = this.metricsHistory.slice(0, 50);
        }
    }

    formatUptime(uptimeSeconds) {
        const days = Math.floor(uptimeSeconds / 86400);
        const hours = Math.floor((uptimeSeconds % 86400) / 3600);
        const minutes = Math.floor((uptimeSeconds % 3600) / 60);
        const seconds = Math.floor(uptimeSeconds % 60);
        
        let formatted = '';
        if (days > 0) formatted += `${days}d `;
        if (hours > 0) formatted += `${hours}h `;
        if (minutes > 0) formatted += `${minutes}m `;
        formatted += `${seconds}s`;
        
        return formatted;
    }

    getAverageMetrics(minutes = 10) {
        const cutoff = Date.now() - (minutes * 60 * 1000);
        const recentMetrics = this.metricsHistory.filter(m => m.timestamp > cutoff);
        
        if (recentMetrics.length === 0) return null;
        
        const avg = {
            cpu: 0,
            memory: 0,
            disk: 0,
            processMemory: 0,
            count: recentMetrics.length
        };
        
        recentMetrics.forEach(metric => {
            avg.cpu += metric.cpu;
            avg.memory += metric.memory;
            avg.disk += metric.disk;
            avg.processMemory += metric.processMemory;
        });
        
        avg.cpu = (avg.cpu / recentMetrics.length).toFixed(1);
        avg.memory = (avg.memory / recentMetrics.length).toFixed(1);
        avg.disk = (avg.disk / recentMetrics.length).toFixed(1);
        avg.processMemory = (avg.processMemory / recentMetrics.length).toFixed(1);
        
        return avg;
    }

    async testSystemHealth() {
        console.log('🧪 Probando salud del sistema...');
        
        const result = await this.check();
        
        console.log('📊 Métricas del sistema:');
        if (result.details) {
            console.log(`   • CPU: ${result.details.cpu.usage}% (${result.details.cpu.cores} cores)`);
            console.log(`   • Memoria: ${result.details.memory.usagePercent}% (${result.details.memory.usedGB}GB/${result.details.memory.totalGB}GB)`);
            console.log(`   • Disco: ${result.details.disk.usagePercent}% usado`);
            console.log(`   • Load Avg: ${result.details.loadAverage['1min']}, ${result.details.loadAverage['5min']}, ${result.details.loadAverage['15min']}`);
            console.log(`   • Process Memory: ${result.details.memory.process.rssMB}MB RSS`);
            console.log(`   • Uptime: ${result.details.uptime.processFormatted}`);
        }
        
        if (result.details?.healthEvaluation?.length > 0) {
            console.log('⚠️ Problemas detectados:');
            result.details.healthEvaluation.forEach(issue => {
                console.log(`   • ${issue}`);
            });
        }
        
        return result;
    }

    getStats() {
        const averages = this.getAverageMetrics();
        
        return {
            name: this.name,
            consecutiveFailures: this.consecutiveFailures,
            lastSuccess: this.lastSuccess,
            lastSuccessFormatted: this.lastSuccess ? 
                new Date(this.lastSuccess).toLocaleString('es-MX', { 
                    timeZone: 'America/Mazatlan' 
                }) : 'Never',
            thresholds: this.thresholds,
            recentAverages: averages,
            metricsHistoryCount: this.metricsHistory.length,
            status: this.consecutiveFailures === 0 ? 'healthy' : 
                    this.consecutiveFailures < 3 ? 'degraded' : 'unhealthy'
        };
    }

    reset() {
        this.consecutiveFailures = 0;
        this.lastSuccess = null;
        this.metricsHistory = [];
        console.log('🔄 System Health Check reseteado');
    }
}

module.exports = SystemHealthCheck;