// Cargar variables de entorno
require('dotenv').config();

const { AdvancedMonitor } = require('./lib/analytics/AdvancedMonitor');
const { DashboardRenderer } = require('./lib/analytics/DashboardRenderer');
const { dbGps, dbEliot, initDatabases } = require('./lib/database');

/**
 * Monitor Empresarial Avanzado
 * Dashboard con analíticas de consumo por períodos (semanal, mensual, semestral)
 * Indicadores profesionales para GPS, VOZ y ELIoT
 */

class EnterpriseMonitor {
    constructor() {
        this.dbConnections = null;
        this.monitor = null;
        this.renderer = new DashboardRenderer();
        this.refreshInterval = 30000; // 30 segundos
        this.isRunning = false;
    }

    async initialize() {
        try {
            console.log('🚀 Inicializando Monitor Empresarial Avanzado...\n');
            
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
            
            console.log('✅ Monitor inicializado correctamente\n');
            console.log('📊 Generando primer reporte...\n');
            
        } catch (error) {
            console.error('❌ Error inicializando monitor:', error.message);
            process.exit(1);
        }
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
        
        // Cerrar conexiones de base de datos
        if (this.dbConnections) {
            try {
                if (this.dbConnections.GPS_DB && this.dbConnections.GPS_DB.sequelize) {
                    await this.dbConnections.GPS_DB.sequelize.close();
                }
                if (this.dbConnections.ELIOT_DB && this.dbConnections.ELIOT_DB.sequelize) {
                    await this.dbConnections.ELIOT_DB.sequelize.close();
                }
            } catch (error) {
                console.log('Error cerrando conexiones DB:', error.message);
            }
        }
        
        console.log('✅ Monitor detenido correctamente');
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