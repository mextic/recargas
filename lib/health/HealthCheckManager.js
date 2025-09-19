/**
 * HealthCheckManager - FASE 5: Sistema de Health Checks Automáticos
 * Monitoreo proactivo de servicios críticos con alertas automáticas
 */
const cron = require('node-cron');
const TaecelHealthCheck = require('./checks/TaecelHealthCheck');
const MSTHealthCheck = require('./checks/MSTHealthCheck');
const DatabaseHealthCheck = require('./checks/DatabaseHealthCheck');
const SystemHealthCheck = require('./checks/SystemHealthCheck');
const AlertManager = require('../alerts/AlertManager');
const moment = require('moment-timezone');

class HealthCheckManager {
    constructor() {
        this.checks = new Map();
        this.results = new Map();
        this.alertManager = null;
        this.isRunning = false;
        this.cronJobs = new Map();
        
        // Configuración de intervalos
        this.config = {
            intervals: {
                external: process.env.HEALTH_CHECK_EXTERNAL_INTERVAL || '*/5 * * * *',  // 5 min
                database: process.env.HEALTH_CHECK_DATABASE_INTERVAL || '*/2 * * * *',  // 2 min
                system: process.env.HEALTH_CHECK_SYSTEM_INTERVAL || '*/1 * * * *'       // 1 min
            },
            thresholds: {
                responseTime: parseInt(process.env.HEALTH_RESPONSE_TIME_THRESHOLD) || 5000,
                cpuThreshold: parseInt(process.env.HEALTH_CPU_THRESHOLD) || 80,
                memoryThreshold: parseInt(process.env.HEALTH_MEMORY_THRESHOLD) || 90,
                diskThreshold: parseInt(process.env.HEALTH_DISK_THRESHOLD) || 95
            },
            alerting: {
                enabled: process.env.HEALTH_ALERTS_ENABLED !== 'false',
                criticalFailures: parseInt(process.env.HEALTH_CRITICAL_FAILURES) || 3,
                warningFailures: parseInt(process.env.HEALTH_WARNING_FAILURES) || 2
            }
        };

        this.initializeHealthChecks();
        
        console.log('🏥 HealthCheckManager inicializado');
        console.log(`⏰ Intervalos configurados:`, this.config.intervals);
    }

    initializeHealthChecks() {
        // Inicializar checks de servicios externos
        this.checks.set('taecel', new TaecelHealthCheck());
        this.checks.set('mst', new MSTHealthCheck());
        
        // Inicializar checks de bases de datos
        this.checks.set('database', new DatabaseHealthCheck());
        
        // Inicializar checks del sistema
        this.checks.set('system', new SystemHealthCheck());

        // Inicializar AlertManager si las alertas están habilitadas
        if (this.config.alerting.enabled) {
            try {
                this.alertManager = new AlertManager();
                console.log('✅ Sistema de alertas integrado con health checks');
            } catch (error) {
                console.warn('⚠️ AlertManager no disponible:', error.message);
            }
        }
    }

    async start() {
        if (this.isRunning) {
            console.log('⚠️ HealthCheckManager ya está ejecutándose');
            return;
        }

        console.log('🚀 Iniciando HealthCheckManager...');
        
        // Ejecutar check inicial
        await this.runAllChecks();
        
        // Programar checks automáticos
        this.scheduleChecks();
        
        this.isRunning = true;
        console.log('✅ HealthCheckManager iniciado correctamente');
    }

    async stop() {
        if (!this.isRunning) {
            console.log('⚠️ HealthCheckManager no está ejecutándose');
            return;
        }

        console.log('🛑 Deteniendo HealthCheckManager...');
        
        // Cancelar todos los cron jobs
        for (const [name, job] of this.cronJobs) {
            job.stop();
            console.log(`   📅 Cron job detenido: ${name}`);
        }
        
        this.cronJobs.clear();
        this.isRunning = false;
        
        console.log('✅ HealthCheckManager detenido');
    }

    scheduleChecks() {
        // Health checks de servicios externos (TAECEL, MST)
        const externalJob = cron.schedule(this.config.intervals.external, async () => {
            // Pausar durante progreso activo para evitar interferencia
            if (global.PROGRESS_ACTIVE) {
                return;
            }
            console.log('🔍 Ejecutando health checks externos...');
            await this.runExternalChecks();
        }, { scheduled: false });

        // Health checks de bases de datos
        const databaseJob = cron.schedule(this.config.intervals.database, async () => {
            // Pausar durante progreso activo para evitar interferencia
            if (global.PROGRESS_ACTIVE) {
                return;
            }
            console.log('🗄️ Ejecutando health checks de base de datos...');
            await this.runDatabaseChecks();
        }, { scheduled: false });

        // Health checks del sistema
        const systemJob = cron.schedule(this.config.intervals.system, async () => {
            // Pausar durante progreso activo para evitar interferencia
            if (global.PROGRESS_ACTIVE) {
                return;
            }
            console.log('⚙️ Ejecutando health checks del sistema...');
            await this.runSystemChecks();
        }, { scheduled: false });

        // Iniciar los jobs
        externalJob.start();
        databaseJob.start();
        systemJob.start();

        // Guardar referencias
        this.cronJobs.set('external', externalJob);
        this.cronJobs.set('database', databaseJob);
        this.cronJobs.set('system', systemJob);

        console.log('📅 Health checks programados:');
        console.log(`   • Externos: ${this.config.intervals.external}`);
        console.log(`   • Base de datos: ${this.config.intervals.database}`);
        console.log(`   • Sistema: ${this.config.intervals.system}`);
    }

    async runAllChecks() {
        console.log('🏥 Ejecutando todos los health checks...');
        
        const results = await Promise.allSettled([
            this.runExternalChecks(),
            this.runDatabaseChecks(),
            this.runSystemChecks()
        ]);

        let totalChecks = 0;
        let passedChecks = 0;

        results.forEach((result, index) => {
            const categories = ['externos', 'base de datos', 'sistema'];
            if (result.status === 'fulfilled' && result.value) {
                const categoryResults = result.value;
                totalChecks += Object.keys(categoryResults).length;
                passedChecks += Object.values(categoryResults).filter(r => r.status === 'healthy').length;
            } else {
                console.error(`❌ Error en checks ${categories[index]}:`, result.reason?.message);
            }
        });

        console.log(`📊 Health checks completados: ${passedChecks}/${totalChecks} exitosos`);
        return this.getOverallHealth();
    }

    async runExternalChecks() {
        const results = {};
        
        try {
            // TAECEL Health Check
            const taecelCheck = this.checks.get('taecel');
            results.taecel = await taecelCheck.check();
            
            // MST Health Check
            const mstCheck = this.checks.get('mst');
            results.mst = await mstCheck.check();
            
            // Actualizar resultados y verificar alertas
            this.updateResults('external', results);
            await this.checkForAlerts('external', results);
            
            return results;
        } catch (error) {
            console.error('❌ Error en health checks externos:', error.message);
            throw error;
        }
    }

    async runDatabaseChecks() {
        const results = {};
        
        try {
            const dbCheck = this.checks.get('database');
            results.databases = await dbCheck.check();
            
            this.updateResults('database', results);
            await this.checkForAlerts('database', results);
            
            return results;
        } catch (error) {
            console.error('❌ Error en health checks de base de datos:', error.message);
            throw error;
        }
    }

    async runSystemChecks() {
        const results = {};
        
        try {
            const systemCheck = this.checks.get('system');
            results.system = await systemCheck.check();
            
            this.updateResults('system', results);
            await this.checkForAlerts('system', results);
            
            return results;
        } catch (error) {
            console.error('❌ Error en health checks del sistema:', error.message);
            throw error;
        }
    }

    updateResults(category, results) {
        const timestamp = Date.now();
        
        if (!this.results.has(category)) {
            this.results.set(category, []);
        }
        
        const categoryResults = this.results.get(category);
        categoryResults.unshift({
            timestamp,
            timestampFormatted: moment(timestamp).tz('America/Mazatlan').format('YYYY-MM-DD HH:mm:ss'),
            results
        });
        
        // Mantener solo los últimos 100 resultados por categoría
        if (categoryResults.length > 100) {
            categoryResults.splice(100);
        }
    }

    async checkForAlerts(category, results) {
        if (!this.alertManager) return;

        for (const [serviceName, result] of Object.entries(results)) {
            if (result.status === 'unhealthy' || result.status === 'degraded') {
                await this.sendHealthAlert(category, serviceName, result);
            }
        }
    }

    async sendHealthAlert(category, serviceName, result) {
        const priority = this.determineAlertPriority(result);
        const title = `Health Check Failed: ${serviceName.toUpperCase()}`;
        
        let message = `El servicio ${serviceName} está ${result.status}.`;
        
        if (result.error) {
            message += `\nError: ${result.error}`;
        }
        
        if (result.responseTime) {
            message += `\nTiempo de respuesta: ${result.responseTime}ms`;
        }
        
        if (result.details) {
            message += `\nDetalles: ${JSON.stringify(result.details, null, 2)}`;
        }

        try {
            await this.alertManager.sendAlert({
                priority,
                title,
                message,
                service: serviceName.toUpperCase(),
                category: 'HEALTH_CHECK',
                metadata: {
                    category,
                    serviceName,
                    status: result.status,
                    responseTime: result.responseTime,
                    lastSuccess: result.lastSuccess,
                    consecutiveFailures: result.consecutiveFailures,
                    checkType: category,
                    timestamp: result.timestamp
                }
            });
        } catch (error) {
            console.error('❌ Error enviando alerta de health check:', error.message);
        }
    }

    determineAlertPriority(result) {
        if (result.status === 'unhealthy') {
            if (result.consecutiveFailures >= this.config.alerting.criticalFailures) {
                return 'CRITICAL';
            } else {
                return 'HIGH';
            }
        } else if (result.status === 'degraded') {
            if (result.consecutiveFailures >= this.config.alerting.warningFailures) {
                return 'MEDIUM';
            } else {
                return 'LOW';
            }
        }
        return 'LOW';
    }

    getOverallHealth() {
        const allResults = {};
        let totalHealthy = 0;
        let totalServices = 0;
        
        for (const [category, categoryHistory] of this.results) {
            if (categoryHistory.length > 0) {
                const latestResults = categoryHistory[0].results;
                allResults[category] = latestResults;
                
                // Contar servicios por estado
                Object.values(latestResults).forEach(result => {
                    if (typeof result === 'object' && result.status) {
                        totalServices++;
                        if (result.status === 'healthy') {
                            totalHealthy++;
                        }
                    }
                });
            }
        }
        
        const healthPercentage = totalServices > 0 ? (totalHealthy / totalServices * 100).toFixed(1) : 0;
        const overallStatus = this.determineOverallStatus(healthPercentage);
        
        return {
            status: overallStatus,
            healthPercentage: parseFloat(healthPercentage),
            totalServices,
            healthyServices: totalHealthy,
            unhealthyServices: totalServices - totalHealthy,
            timestamp: Date.now(),
            timestampFormatted: moment().tz('America/Mazatlan').format('YYYY-MM-DD HH:mm:ss'),
            details: allResults
        };
    }

    determineOverallStatus(healthPercentage) {
        if (healthPercentage >= 95) return 'healthy';
        if (healthPercentage >= 80) return 'degraded';
        return 'unhealthy';
    }

    getHealthHistory(category = null, limit = 20) {
        if (category) {
            return this.results.get(category)?.slice(0, limit) || [];
        }
        
        const history = {};
        for (const [cat, results] of this.results) {
            history[cat] = results.slice(0, limit);
        }
        return history;
    }

    getServiceStatus(serviceName) {
        for (const [category, categoryHistory] of this.results) {
            if (categoryHistory.length > 0) {
                const latestResults = categoryHistory[0].results;
                if (latestResults[serviceName]) {
                    return {
                        category,
                        ...latestResults[serviceName],
                        lastChecked: categoryHistory[0].timestampFormatted
                    };
                }
            }
        }
        return null;
    }

    getHealthStats() {
        const overall = this.getOverallHealth();
        const stats = {
            overall,
            isRunning: this.isRunning,
            config: this.config,
            checksCount: this.checks.size,
            categories: Array.from(this.results.keys()),
            uptime: this.isRunning ? Date.now() - (this.startTime || Date.now()) : 0
        };
        
        return stats;
    }

    // Método para ejecutar health check único (útil para testing)
    async runSingleCheck(checkName) {
        const check = this.checks.get(checkName);
        if (!check) {
            throw new Error(`Health check '${checkName}' no encontrado`);
        }
        
        console.log(`🔍 Ejecutando health check: ${checkName}`);
        const result = await check.check();
        
        this.updateResults('manual', { [checkName]: result });
        
        return result;
    }
}

// Función para uso desde línea de comandos
async function runHealthCheck() {
    const manager = new HealthCheckManager();
    
    try {
        if (process.argv.includes('--once')) {
            console.log('🔍 Ejecutando health check único...');
            const results = await manager.runAllChecks();
            console.log('\n📊 RESULTADOS:');
            console.log(JSON.stringify(results, null, 2));
            process.exit(0);
        } else {
            console.log('🚀 Iniciando health check continuo...');
            await manager.start();
            
            // Manejar cierre limpio
            process.on('SIGINT', async () => {
                console.log('\n🛑 Recibida señal de cierre...');
                await manager.stop();
                process.exit(0);
            });
        }
    } catch (error) {
        console.error('❌ Error en health check:', error.message);
        process.exit(1);
    }
}

// Ejecutar si se llama directamente
if (require.main === module) {
    runHealthCheck();
}

module.exports = HealthCheckManager;