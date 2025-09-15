// ============== SISTEMA DE RECARGAS OPTIMIZADO v2.0 ==============
require("./lib/instrument.js");

const { initDatabases, dbGps, dbEliot, getRedisClient } = require('./lib/database');
const { GPSRechargeProcessor } = require('./lib/processors/GPSRechargeProcessor');
const { VozRechargeProcessor } = require('./lib/processors/VozRechargeProcessor');
const { ELIoTRechargeProcessor } = require('./lib/processors/ELIoTRechargeProcessor');
const { PersistenceQueueSystem } = require('./lib/concurrency/PersistenceQueueSystem');
const { OptimizedLockManager } = require('./lib/concurrency/OptimizedLockManager');
const schedule = require('node-schedule');
const moment = require('moment-timezone');

class RechargeOrchestrator {
    constructor() {
        this.processors = {
            GPS: null,
            VOZ: null,
            ELIOT: null
        };
        this.persistenceQueue = null;
        this.lockManager = null;
        this.schedules = new Map();
        this.isInitialized = false;
    }

    async initialize() {
        console.log('🚀 Iniciando Sistema de Recargas Optimizado v2.0');
        console.log('=================================================\n');
        
        try {
            // 1. Inicializar bases de datos
            console.log('📊 Conectando bases de datos...');
            await initDatabases();
            
            // Guardar referencia a bases de datos en la clase
            this.dbGps = dbGps;
            this.dbEliot = dbEliot;
            
            // 2. Inicializar sistema de persistencia
            console.log('💾 Inicializando sistema de persistencia...');
            // Cada servicio necesita su propia instancia de persistencia
            this.gpsQueue = new PersistenceQueueSystem({
                serviceType: 'gps',
                enableAutoRecovery: true,
                maxRetries: 3
            });
            
            this.vozQueue = new PersistenceQueueSystem({
                serviceType: 'voz',
                enableAutoRecovery: true,
                maxRetries: 3
            });
            
            this.eliotQueue = new PersistenceQueueSystem({
                serviceType: 'eliot',
                enableAutoRecovery: true,
                maxRetries: 3
            });
            
            await this.gpsQueue.initialize();
            await this.vozQueue.initialize();
            await this.eliotQueue.initialize();
            
            // 3. Inicializar lock manager
            console.log('🔒 Inicializando gestor de locks...');
            this.lockManager = new OptimizedLockManager({
                useRedis: true,
                getRedisClient: getRedisClient
            });
            this.lockManager.setDbConnection(dbGps);
            
            // 4. Inicializar procesadores
            console.log('⚙️ Inicializando procesadores...');
            this.processors.GPS = new GPSRechargeProcessor(dbGps, this.lockManager, this.gpsQueue);
            this.processors.VOZ = new VozRechargeProcessor(dbGps, this.lockManager, this.vozQueue);
            this.processors.ELIOT = new ELIoTRechargeProcessor({GPS_DB: dbGps, ELIOT_DB: dbEliot}, this.lockManager, this.eliotQueue);
            
            // 5. Verificar recuperación ante crash
            console.log('🔍 Verificando estado anterior...');
            const gpsStats = await this.gpsQueue.getQueueStats();
            const vozStats = await this.vozQueue.getQueueStats();
            const eliotStats = await this.eliotQueue.getQueueStats();
            
            const totalPending = gpsStats.auxiliaryQueue.pendingDb + vozStats.auxiliaryQueue.pendingDb + eliotStats.auxiliaryQueue.pendingDb;
            
            if (totalPending > 0) {
                console.log(`⚠️ Detectadas ${totalPending} recargas pendientes (GPS: ${gpsStats.auxiliaryQueue.pendingDb}, VOZ: ${vozStats.auxiliaryQueue.pendingDb}, ELIOT: ${eliotStats.auxiliaryQueue.pendingDb})`);
                await this.processPendingQueues();
            }
            
            // 6. Configurar schedules
            this.setupSchedules();
            
            // 7. TESTING: Ejecutar servicios inmediatamente para debugging (solo en desarrollo)
            if (process.env.NODE_ENV === 'development' && process.env.TEST_VOZ === 'true') {
                console.log('\n🧪 TESTING: Ejecutando VOZ inmediatamente...');
                setTimeout(() => {
                    this.runProcess('VOZ').catch(error => {
                        console.error('❌ Error en test VOZ:', error);
                    });
                }, 2000); // 2 segundos después de inicializar
            }
            
            if (process.env.TEST_ELIOT === 'true') {
                console.log('\n🧪 TESTING: Ejecutando ELIoT inmediatamente...');
                setTimeout(() => {
                    this.runProcess('ELIOT').catch(error => {
                        console.error('❌ Error en test ELIoT:', error);
                    });
                }, 3000); // 3 segundos después de inicializar (para no interferir con VOZ)
            }
            
            this.isInitialized = true;
            console.log('\n✅ Sistema inicializado correctamente\n');
            
        } catch (error) {
            console.error('❌ Error durante inicialización:', error);
            throw error;
        }
    }

    setupSchedules() {
        console.log('📅 Configurando tareas programadas...');
        
        // GPS - Intervalo configurable basado en GPS_MINUTOS_SIN_REPORTAR
        const gpsInterval = parseInt(process.env.GPS_MINUTOS_SIN_REPORTAR) || 14;
        console.log(`   🔄 GPS verificará cada ${gpsInterval} minutos (GPS_MINUTOS_SIN_REPORTAR=${gpsInterval})`);
        
        const gpsRule = new schedule.RecurrenceRule();
        gpsRule.minute = new schedule.Range(0, 59, gpsInterval);
        gpsRule.tz = "America/Mazatlan";
        
        this.schedules.set('GPS', schedule.scheduleJob(gpsRule, async () => {
            await this.runProcess('GPS');
        }));
        
        // VOZ - Configurable con variable de entorno o horarios fijos por defecto
        const vozMode = process.env.VOZ_SCHEDULE_MODE || 'fixed'; // 'fixed' o 'interval'
        const vozInterval = parseInt(process.env.VOZ_MINUTOS_SIN_REPORTAR) || null;
        
        if (vozMode === 'interval' && vozInterval) {
            // Modo intervalo: cada N minutos (como GPS)
            console.log(`   📞 VOZ verificará cada ${vozInterval} minutos (VOZ_MINUTOS_SIN_REPORTAR=${vozInterval})`);
            
            const vozRule = new schedule.RecurrenceRule();
            vozRule.minute = new schedule.Range(0, 59, vozInterval);
            vozRule.tz = "America/Mazatlan";
            
            this.schedules.set('VOZ', schedule.scheduleJob(vozRule, async () => {
                await this.runProcess('VOZ');
            }));
        } else {
            // Modo fijo: 2 veces al día (comportamiento actual)
            console.log('   📞 VOZ verificará 2 veces al día: 1:00 AM y 4:00 AM');
            
            // Primera ejecución: 1:00 AM
            const vozRule1 = new schedule.RecurrenceRule();
            vozRule1.hour = 1;
            vozRule1.minute = 0;
            vozRule1.tz = "America/Mazatlan";
            
            this.schedules.set('VOZ-1', schedule.scheduleJob(vozRule1, async () => {
                console.log('📞 Ejecutando VOZ - Primera verificación (1:00 AM)');
                await this.runProcess('VOZ');
            }));
            
            // Segunda ejecución: 4:00 AM (3 horas después)
            const vozRule2 = new schedule.RecurrenceRule();
            vozRule2.hour = 4;
            vozRule2.minute = 0;
            vozRule2.tz = "America/Mazatlan";
            
            this.schedules.set('VOZ-2', schedule.scheduleJob(vozRule2, async () => {
                console.log('📞 Ejecutando VOZ - Segunda verificación (4:00 AM)');
                await this.runProcess('VOZ');
            }));
        }
        
        // ELIOT - Intervalo configurable basado en ELIOT_MINUTOS_SIN_REPORTAR
        const eliotInterval = parseInt(process.env.ELIOT_MINUTOS_SIN_REPORTAR) || 10;
        console.log(`   🔄 ELIoT verificará cada ${eliotInterval} minutos (ELIOT_MINUTOS_SIN_REPORTAR=${eliotInterval})`);
        
        const eliotRule = new schedule.RecurrenceRule();
        eliotRule.minute = new schedule.Range(0, 59, eliotInterval);
        eliotRule.tz = "America/Mazatlan";
        
        this.schedules.set('ELIOT', schedule.scheduleJob(eliotRule, async () => {
            await this.runProcess('ELIOT');
        }));
        
        console.log(`   • GPS: Cada ${gpsInterval} minutos`);
        console.log('   • VOZ: 2 veces al día (1:00 AM y 4:00 AM)');
        console.log(`   • ELIOT: Cada ${eliotInterval} minutos`);
    }

    async runProcess(type) {
        if (!this.isInitialized) {
            console.log('⚠️ Sistema no inicializado');
            return;
        }
        
        const processor = this.processors[type];
        if (!processor) {
            console.log(`❌ Procesador ${type} no encontrado`);
            return;
        }
        
        const startTime = Date.now();
        const inicioMazatlan = moment.tz("America/Mazatlan").format('YYYY-MM-DD HH:mm:ss');
        console.log(`\n${'='.repeat(50)}`);
        console.log(`🚀 [${inicioMazatlan}] Iniciando proceso ${type} - Mazatlán`);
        console.log(`${'='.repeat(50)}`);
        
        try {
            const result = await processor.process();
            const duration = ((Date.now() - startTime) / 1000).toFixed(2);
            const finMazatlan = moment.tz("America/Mazatlan").format('YYYY-MM-DD HH:mm:ss');
            
            console.log(`\n✅ Proceso ${type} completado en ${duration}s`);
            console.log(`🏁 [${finMazatlan}] Proceso finalizado - Mazatlán`);
            console.log(`   • Procesados: ${result.processed}`);
            console.log(`   • Exitosos: ${result.success}`);
            console.log(`   • Fallidos: ${result.failed}`);
            
            return result;
            
        } catch (error) {
            console.error(`❌ Error en proceso ${type}:`, error.message);
            
            // Guardar error en métricas
            await this.saveErrorMetric(type, error);
            
            return { success: 0, failed: 1, error: error.message };
        }
    }

    async processPendingQueues() {
        console.log('📦 Procesando colas pendientes...');
        
        let totalProcessed = 0;
        let totalFailed = 0;
        
        // Procesar cola GPS
        const gpsStats = await this.gpsQueue.getQueueStats();
        if (gpsStats.auxiliaryQueue.pendingDb > 0) {
            console.log(`   🔄 GPS: ${gpsStats.auxiliaryQueue.pendingDb} registros pendientes`);
            const gpsResult = await this.processors.GPS.processAuxiliaryQueueRecharges();
            totalProcessed += gpsResult.processed;
            totalFailed += gpsResult.failed;
        }
        
        // Procesar cola VOZ  
        const vozStats = await this.vozQueue.getQueueStats();
        if (vozStats.auxiliaryQueue.pendingDb > 0) {
            console.log(`   📞 VOZ: ${vozStats.auxiliaryQueue.pendingDb} registros pendientes`);
            const vozResult = await this.processors.VOZ.processAuxiliaryQueueRecharges();
            totalProcessed += vozResult.processed;
            totalFailed += vozResult.failed;
        }
        
        // Procesar cola ELIOT
        const eliotStats = await this.eliotQueue.getQueueStats();
        if (eliotStats.auxiliaryQueue.pendingDb > 0) {
            console.log(`   🤖 ELIOT: ${eliotStats.auxiliaryQueue.pendingDb} registros pendientes`);
            // ELIOT necesitará su propio método de recovery (lo implementaremos después)
        }
        
        console.log(`   • Total procesados: ${totalProcessed}`);
        console.log(`   • Total fallidos: ${totalFailed}`);
        return { processed: totalProcessed, failed: totalFailed };
    }

    async saveErrorMetric(type, error) {
        try {
            const sql = `
                INSERT INTO recargas_metricas 
                (process_type, start_time, end_time, records_failed, error_message)
                VALUES (?, NOW(), NOW(), 1, ?)
            `;
            await this.dbGps.querySequelize(sql, {
                replacements: [type, error.message],
                type: this.dbGps.getSequelizeClient().QueryTypes.INSERT
            });
        } catch (e) {
            console.error('Error guardando métrica:', e.message);
        }
    }

    async getStatus() {
        const gpsStats = await this.gpsQueue.getQueueStats();
        const vozStats = await this.vozQueue.getQueueStats();
        const eliotStats = await this.eliotQueue.getQueueStats();
        
        const status = {
            initialized: this.isInitialized,
            queues: {
                gps: gpsStats,
                voz: vozStats,
                eliot: eliotStats
            },
            locks: await this.lockManager.getStats(),
            schedules: Array.from(this.schedules.keys())
        };
        
        console.log('\n📊 ESTADO DEL SISTEMA:');
        console.log('────────────────────────');
        console.log(`Estado: ${status.initialized ? '✅ Activo' : '❌ Inactivo'}`);
        console.log(`Cola GPS: ${gpsStats.auxiliaryQueue.total} elementos (${gpsStats.auxiliaryQueue.pendingDb} pendientes)`);
        console.log(`Cola VOZ: ${vozStats.auxiliaryQueue.total} elementos (${vozStats.auxiliaryQueue.pendingDb} pendientes)`);
        console.log(`Cola ELIOT: ${eliotStats.auxiliaryQueue.total} elementos (${eliotStats.auxiliaryQueue.pendingDb} pendientes)`);
        console.log(`Locks activos: ${status.locks.active}`);
        console.log(`Schedules activos: ${status.schedules.join(', ')}`);
        
        return status;
    }

    async shutdown() {
        console.log('\n🛑 Deteniendo sistema...');
        
        // Cancelar schedules
        this.schedules.forEach((job, name) => {
            job.cancel();
            console.log(`   • Schedule ${name} cancelado`);
        });
        
        // Liberar locks
        if (this.lockManager) {
            await this.lockManager.releaseAllLocks();
        }
        
        console.log('✅ Sistema detenido correctamente');
    }
}

// Crear instancia global
const orchestrator = new RechargeOrchestrator();

// Inicializar al arrancar
(async () => {
    try {
        await orchestrator.initialize();
        
        // Ejecutar GPS una vez al inicio
        console.log('\n🔧 Ejecutando proceso GPS inicial...');
        await orchestrator.runProcess('GPS');
        
    } catch (error) {
        console.error('❌ Error fatal durante inicialización:', error);
        process.exit(1);
    }
})();

// Manejo de señales
process.on('SIGINT', async () => {
    await orchestrator.shutdown();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    await orchestrator.shutdown();
    process.exit(0);
});

// Manejo de errores no capturados
process.on('uncaughtException', async (error) => {
    console.error('❌ Error no capturado:', error);
    await orchestrator.shutdown();
    process.exit(1);
});

process.on('unhandledRejection', async (reason, promise) => {
    console.error('❌ Promesa rechazada no manejada:', reason);
    await orchestrator.shutdown();
    process.exit(1);
});

// Exports para uso externo
module.exports = orchestrator;
