// Cargar variables de entorno
require('dotenv').config();

const { AdvancedMonitor } = require('./lib/analytics/AdvancedMonitor');
const { DashboardRenderer } = require('./lib/analytics/DashboardRenderer');
const { dbGps, dbEliot, initDatabases } = require('./lib/database');
const { getDashboardServer } = require('./lib/dashboard/DashboardServer');
const { getEventBus } = require('./lib/events/EventBus');
const { initializeTerminalDashboard } = require('./lib/dashboard/TerminalDashboard');

/**
 * Monitor Empresarial Avanzado v3.0
 * Sistema híbrido con:
 * - Analytics empresariales (semanal, mensual, semestral)
 * - Dashboard terminal en tiempo real
 * - Dashboard web con Socket.IO
 * - Eventos unificados para GPS, VOZ y ELIoT
 */

class EnterpriseMonitor {
    constructor(options = {}) {
        this.options = {
            enableWebDashboard: process.env.ENABLE_WEB_DASHBOARD === 'true' || false,
            enableTerminalDashboard: process.env.ENABLE_TERMINAL_DASHBOARD !== 'false',
            webPort: process.env.DASHBOARD_PORT || 3001,
            refreshInterval: parseInt(process.env.ANALYTICS_REFRESH_INTERVAL) || 30000,
            mode: process.env.MONITOR_MODE || 'hybrid', // 'analytics', 'realtime', 'hybrid'
            ...options
        };

        this.dbConnections = null;
        this.monitor = null;
        this.renderer = new DashboardRenderer();
        this.refreshInterval = this.options.refreshInterval;
        this.isRunning = false;

        // Componentes del sistema unificado
        this.eventBus = null;
        this.dashboardServer = null;
        this.terminalDashboard = null;
    }

    async initialize() {
        try {
            console.log('🚀 Inicializando Monitor Empresarial Avanzado v3.0...\n');

            // Inicializar EventBus central
            console.log('🌟 Inicializando sistema de eventos...');
            this.eventBus = getEventBus();

            // Inicializar bases de datos
            console.log('🔌 Conectando a bases de datos...');
            await initDatabases();

            // Configurar conexiones para el monitor
            this.dbConnections = {
                GPS_DB: dbGps,
                ELIOT_DB: dbEliot
            };

            // Inicializar monitor analítico
            this.monitor = new AdvancedMonitor(this.dbConnections);

            // Inicializar dashboards según configuración
            await this.initializeDashboards();

            console.log('✅ Monitor híbrido inicializado correctamente\n');

        } catch (error) {
            console.error('❌ Error inicializando monitor:', error.message);
            process.exit(1);
        }
    }

    /**
     * Inicializar dashboards según la configuración
     */
    async initializeDashboards() {
        const mode = this.options.mode;

        console.log(`📊 Modo de operación: ${mode.toUpperCase()}`);

        // Inicializar Dashboard Web con Socket.IO
        if (this.options.enableWebDashboard && (mode === 'hybrid' || mode === 'realtime')) {
            try {
                console.log('🌐 Iniciando dashboard web...');
                this.dashboardServer = getDashboardServer({
                    port: this.options.webPort
                });
                await this.dashboardServer.start();

                // Conectar analytics con eventos
                this.setupAnalyticsEvents();

            } catch (error) {
                console.warn(`⚠️ No se pudo iniciar dashboard web: ${error.message}`);
                this.options.enableWebDashboard = false;
            }
        }

        // Inicializar Dashboard Terminal
        if (this.options.enableTerminalDashboard && (mode === 'hybrid' || mode === 'realtime')) {
            try {
                console.log('💻 Iniciando dashboard terminal...');
                this.terminalDashboard = initializeTerminalDashboard({
                    maxEvents: 8,
                    refreshRate: 200
                });
            } catch (error) {
                console.warn(`⚠️ No se pudo iniciar dashboard terminal: ${error.message}`);
                this.options.enableTerminalDashboard = false;
            }
        }

        console.log(`✅ Dashboards configurados:
   💻 Terminal: ${this.options.enableTerminalDashboard ? '✅ Activo' : '❌ Inactivo'}
   🌐 Web: ${this.options.enableWebDashboard ? `✅ http://localhost:${this.options.webPort}` : '❌ Inactivo'}
   📊 Analytics: ✅ Cada ${this.refreshInterval/1000}s\n`);
    }

    /**
     * Configurar conexión entre analytics y eventos
     */
    setupAnalyticsEvents() {
        // Emitir evento cuando se genere un reporte analytics
        this.originalGenerateReport = this.generateAndDisplayReport.bind(this);

        // Override para emitir eventos
        this.generateAndDisplayReport = async () => {
            try {
                // Generar reporte
                const report = await this.monitor.generateComprehensiveReport();

                // Emitir evento con datos analytics
                this.eventBus.emitEvent('analytics.update', {
                    report,
                    timestamp: Date.now(),
                    refreshInterval: this.refreshInterval
                }, 'ANALYTICS');

                // Broadcast via Socket.IO si está disponible
                if (this.dashboardServer) {
                    this.dashboardServer.broadcast('analytics-update', {
                        report,
                        timestamp: Date.now()
                    });
                }

                // Mostrar en terminal solo si no hay dashboard terminal activo
                if (!this.terminalDashboard) {
                    console.clear();
                    const dashboard = this.renderer.renderComprehensiveDashboard(report);
                    console.log(dashboard);
                    console.log(`🔄 Actualización automática cada ${this.refreshInterval / 1000} segundos`);
                    console.log('🛑 Presiona Ctrl+C para salir\n');
                }

            } catch (error) {
                console.error('❌ Error generando reporte:', error.message);

                // Emitir evento de error
                this.eventBus.emitEvent('analytics.error', {
                    error: error.message,
                    timestamp: Date.now()
                }, 'ANALYTICS');
            }
        };
    }

    async start() {
        if (this.isRunning) return;
        
        this.isRunning = true;
        
        // Generar reporte inicial
        await this.generateAndDisplayReport();
        
        // Configurar actualización periódica
        const intervalId = setInterval(async () => {
            if (this.isRunning) {
                await this.generateAndDisplayReport();
            } else {
                clearInterval(intervalId);
            }
        }, this.refreshInterval);

        // Manejar señales de terminación
        process.on('SIGINT', async () => {
            console.log('\n\n🛑 Deteniendo Monitor Empresarial...');
            await this.stop();
            process.exit(0);
        });

        process.on('SIGTERM', async () => {
            console.log('\n\n🛑 Terminando Monitor Empresarial...');
            await this.stop();
            process.exit(0);
        });
    }

    async generateAndDisplayReport() {
        try {
            console.clear();
            
            // Generar reporte completo
            const report = await this.monitor.generateComprehensiveReport();
            
            // Renderizar dashboard
            const dashboard = this.renderer.renderComprehensiveDashboard(report);
            
            // Mostrar dashboard
            console.log(dashboard);
            
            // Información de control
            console.log(`🔄 Actualización automática cada ${this.refreshInterval / 1000} segundos`);
            console.log('🛑 Presiona Ctrl+C para salir\n');
            
        } catch (error) {
            console.error('❌ Error generando reporte:', error.message);
            console.error('🔄 Reintentando en el próximo ciclo...\n');
        }
    }

    async stop() {
        this.isRunning = false;

        console.log('\n🛑 Deteniendo componentes del sistema...');

        // Detener Dashboard Terminal
        if (this.terminalDashboard) {
            try {
                this.terminalDashboard.stop();
                console.log('💻 Dashboard terminal detenido');
            } catch (error) {
                console.warn('⚠️ Error deteniendo dashboard terminal:', error.message);
            }
        }

        // Detener Dashboard Web
        if (this.dashboardServer) {
            try {
                await this.dashboardServer.stop();
                console.log('🌐 Dashboard web detenido');
            } catch (error) {
                console.warn('⚠️ Error deteniendo dashboard web:', error.message);
            }
        }

        // Cerrar conexiones de base de datos
        if (this.dbConnections) {
            try {
                if (this.dbConnections.GPS_DB && this.dbConnections.GPS_DB.sequelize) {
                    await this.dbConnections.GPS_DB.sequelize.close();
                }
                if (this.dbConnections.ELIOT_DB && this.dbConnections.ELIOT_DB.sequelize) {
                    await this.dbConnections.ELIOT_DB.sequelize.close();
                }
                console.log('🗄️ Conexiones de BD cerradas');
            } catch (error) {
                console.warn('⚠️ Error cerrando conexiones DB:', error.message);
            }
        }

        console.log('✅ Monitor híbrido detenido correctamente');
    }

    /**
     * Método para generar reporte bajo demanda
     */
    async generateSingleReport() {
        try {
            await this.initialize();
            const report = await this.monitor.generateComprehensiveReport();
            const dashboard = this.renderer.renderComprehensiveDashboard(report);
            
            console.log(dashboard);
            
            await this.stop();
            return report;
            
        } catch (error) {
            console.error('❌ Error generando reporte único:', error.message);
            throw error;
        }
    }

    /**
     * Método para exportar datos analíticos
     */
    async exportAnalytics(format = 'json') {
        try {
            await this.initialize();
            const report = await this.monitor.generateComprehensiveReport();
            
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const filename = `analytics-export-${timestamp}`;
            
            if (format === 'json') {
                const fs = require('fs');
                const path = require('path');
                
                const exportPath = path.join(__dirname, 'exports', `${filename}.json`);
                
                // Crear directorio si no existe
                fs.mkdirSync(path.dirname(exportPath), { recursive: true });
                
                // Escribir archivo
                fs.writeFileSync(exportPath, JSON.stringify(report, null, 2));
                
                console.log(`📄 Analíticas exportadas: ${exportPath}`);
            }
            
            await this.stop();
            return report;
            
        } catch (error) {
            console.error('❌ Error exportando analíticas:', error.message);
            throw error;
        }
    }
}

// Función principal
async function main() {
    const monitor = new EnterpriseMonitor();
    
    // Parsear argumentos de línea de comandos
    const args = process.argv.slice(2);
    
    if (args.includes('--export')) {
        // Modo exportación
        const format = args.includes('--format=csv') ? 'csv' : 'json';
        await monitor.exportAnalytics(format);
        
    } else if (args.includes('--single')) {
        // Generar reporte único
        await monitor.generateSingleReport();
        
    } else {
        // Modo monitor continuo (default)
        console.log(`
╔════════════════════════════════════════════════════════════════════════════════╗
║                  🚀 MONITOR EMPRESARIAL AVANZADO v2.0                          ║
║                                                                                ║
║  📊 Analíticas de Consumo por Períodos                                        ║
║  📈 Indicadores Profesionales de Negocio                                      ║
║  🎯 KPIs Empresariales en Tiempo Real                                         ║
║                                                                                ║
║  Servicios: GPS ${monitor.renderer.colors.GPS} | VOZ ${monitor.renderer.colors.VOZ} | ELIoT ${monitor.renderer.colors.ELIOT}                                        ║
║  Períodos: Semanal | Mensual | Semestral                                     ║
╚════════════════════════════════════════════════════════════════════════════════╝

Inicializando sistema...
`);
        
        await monitor.initialize();
        await monitor.start();
    }
}

// Exportar para uso programático
module.exports = { EnterpriseMonitor, AdvancedMonitor, DashboardRenderer };

// Ejecutar si se llama directamente
if (require.main === module) {
    main().catch(error => {
        console.error('❌ Error fatal:', error.message);
        process.exit(1);
    });
}