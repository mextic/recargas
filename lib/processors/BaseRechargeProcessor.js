const moment = require('moment-timezone');

/**
 * Clase base abstracta para todos los procesadores de recargas
 * Centraliza lógica común y define template method pattern
 */
class BaseRechargeProcessor {
    constructor(dbConnection, lockManager, persistenceQueue, config) {
        if (this.constructor === BaseRechargeProcessor) {
            throw new Error('BaseRechargeProcessor es una clase abstracta');
        }
        
        this.db = dbConnection;
        this.lockManager = lockManager;
        this.persistenceQueue = persistenceQueue;
        this.config = config;
    }

    // ===== TEMPLATE METHOD PATTERN =====
    async process() {
        const stats = { processed: 0, success: 0, failed: 0 };
        const lockKey = `recharge_${this.getServiceType()}`;
        const lockId = `${lockKey}_${process.pid}_${Date.now()}`;
        let lockAcquired = false;

        try {
            // 1. Adquirir lock distribuido
            const lockExpirationMinutes = parseInt(process.env.LOCK_EXPIRATION_MINUTES) || 60;
            const lockTimeoutSeconds = lockExpirationMinutes * 60;
            const lockResult = await this.lockManager.acquireLock(lockKey, lockId, lockTimeoutSeconds);
            
            if (!lockResult.success) {
                console.log(`   ⚠️ No se pudo adquirir lock ${this.getServiceType().toUpperCase()}`);
                return stats;
            }
            lockAcquired = true;

            // 2. RECOVERY ESTRICTO - Procesar cola auxiliar primero
            console.log(`🔄 Verificando cola auxiliar ${this.getServiceType().toUpperCase()} para recovery...`);
            const pendingStats = await this.persistenceQueue.getQueueStats();
            
            if (pendingStats.auxiliaryQueue.pendingDb > 0) {
                console.log(`⚡ Procesando ${pendingStats.auxiliaryQueue.pendingDb} recargas ${this.getServiceType().toUpperCase()} de recovery...`);
                const recoveryResult = await this.processAuxiliaryQueueRecharges();
                console.log(`   • Cola auxiliar ${this.getServiceType().toUpperCase()}: ${recoveryResult.processed} recuperadas, ${recoveryResult.failed} fallidas`);
                
                // POLÍTICA ESTRICTA: Si hay fallas en recovery, NO procesar nuevos registros
                if (recoveryResult.failed > 0) {
                    console.log(`   ⚠️ HAY ${recoveryResult.failed} REGISTROS PENDIENTES SIN PROCESAR. NO CONSUMIENDO WEBSERVICES.`);
                    stats.failed = recoveryResult.failed;
                    return stats;
                }
            }

            // 3. Procesar nuevos registros (cada servicio implementa su lógica)
            const records = await this.getRecordsToProcess();
            console.log(`   📋 ${records.length} registros ${this.getServiceType().toUpperCase()} para procesar`);

            if (records.length === 0) {
                return stats;
            }

            // 4. Procesar registros usando implementación específica
            return await this.processRecords(records, stats);

        } finally {
            if (lockAcquired) {
                await this.lockManager.releaseLock(lockKey, lockId);
            }
        }
    }

    // ===== UTILIDADES COMUNES =====
    async delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    generateProgressBar(current, total, length = 20) {
        const percentage = Math.round((current / total) * 100);
        const filled = Math.round((current / total) * length);
        const empty = length - filled;
        
        return `[${'█'.repeat(filled)}${' '.repeat(empty)}] ${percentage}% (${current}/${total})`;
    }

    async executeWithRetry(operation, config = {}) {
        const { 
            maxRetries = this.config.MAX_RETRIES || 3, 
            delayStrategy = this.config.RETRY_STRATEGY || 'exponential',
            baseDelay = this.config.RETRY_BASE_DELAY || 1000,
            serviceName = this.getServiceType().toUpperCase()
        } = config;
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await operation();
            } catch (error) {
                if (attempt === maxRetries) {
                    throw error;
                }
                
                const delay = delayStrategy === 'exponential' 
                    ? attempt * baseDelay 
                    : baseDelay;
                
                console.log(`   ⏳ ${serviceName} reintento ${attempt}/${maxRetries} en ${delay}ms...`);
                await this.delay(delay);
            }
        }
    }

    // ===== RECOVERY COMÚN =====
    async processAuxiliaryQueueRecharges() {
        const stats = { processed: 0, failed: 0 };

        try {
            // Usar la cola auxiliar específica del servicio
            const auxiliaryQueue = this.persistenceQueue.auxiliaryQueue;
            
            if (!auxiliaryQueue || auxiliaryQueue.length === 0) {
                console.log(`   📋 Cola auxiliar ${this.getServiceType().toUpperCase()} vacía`);
                return stats;
            }

            // Filtrar registros pendientes del servicio específico
            const serviceType = this.getServiceType();
            const pendingRecharges = auxiliaryQueue.filter(item =>
                item.tipo === `${serviceType}_recharge` &&
                (item.status === 'webservice_success_pending_db' ||
                 item.status === 'db_insertion_failed_pending_recovery')
            );

            console.log(`   🔄 Procesando ${pendingRecharges.length} recargas ${serviceType.toUpperCase()} pendientes...`);

            if (pendingRecharges.length === 0) {
                return stats;
            }

            // Procesar cada recarga pendiente
            const processedSims = new Set();

            for (const recharge of pendingRecharges) {
                try {
                    await this.processCompletePendingRecharge(recharge);
                    stats.processed++;
                    processedSims.add(recharge.sim);
                    console.log(`   ✅ Recarga ${serviceType.toUpperCase()} ${recharge.sim} procesada exitosamente`);
                } catch (error) {
                    stats.failed++;
                    console.error(`   ❌ Error procesando recarga ${serviceType.toUpperCase()} ${recharge.sim}:`, error.message);
                }
            }

            // Limpiar registros procesados exitosamente usando sistema de persistencia
            if (stats.processed > 0) {
                this.persistenceQueue.auxiliaryQueue = this.persistenceQueue.auxiliaryQueue.filter(item => {
                    if (item.tipo === `${serviceType}_recharge` && processedSims.has(item.sim)) {
                        return false; // Remover exitosos
                    }
                    return true; // Mantener los demás
                });
                
                await this.persistenceQueue.saveAuxiliaryQueue();
                console.log(`   🧹 Cola auxiliar ${serviceType.toUpperCase()} limpiada: ${processedSims.size} recargas removidas`);
            }

        } catch (error) {
            console.error(`   ❌ Error procesando cola auxiliar ${this.getServiceType().toUpperCase()}:`, error.message);
            stats.failed++;
        }

        return stats;
    }

    // ===== MÉTODOS DE PROVIDERS COMUNES =====
    async getProvidersOrderedByBalance() {
        const providers = [];
        
        // Obtener balance TAECEL
        try {
            console.log('   💰 Consultando saldo TAECEL...');
            const balanceTaecel = await this.getTaecelBalance();
            console.log(`   💰 Balance TAECEL: $${balanceTaecel}`);
            providers.push({ name: 'TAECEL', balance: balanceTaecel });
        } catch (error) {
            console.error('   ❌ Error consultando saldo TAECEL:', error.message);
            providers.push({ name: 'TAECEL', balance: 0 });
        }

        // Obtener balance MST
        try {
            console.log('   💰 Consultando saldo MST...');
            const balanceMst = await this.getMstBalance();
            console.log(`   💰 Balance MST: $${balanceMst}`);
            providers.push({ name: 'MST', balance: balanceMst });
        } catch (error) {
            console.error('   ❌ Error consultando saldo MST:', error.message);
            providers.push({ name: 'MST', balance: 0 });
        }

        // Filtrar proveedores con saldo suficiente
        const minBalance = this.config.MIN_BALANCE_THRESHOLD || 100;
        const validProviders = providers.filter(p => p.balance > minBalance);

        // Ordenar por saldo descendente
        validProviders.sort((a, b) => b.balance - a.balance);

        if (validProviders.length === 0) {
            const balanceInfo = providers.map(p => `${p.name}: $${p.balance}`).join(', ');
            throw new Error(`No hay proveedores con saldo suficiente (>$${minBalance}). ${balanceInfo}`);
        }

        console.log(`   🏆 Proveedor con más saldo: ${validProviders[0].name} ($${validProviders[0].balance})`);
        return validProviders;
    }

    // ===== MÉTODOS ABSTRACTOS - CADA SERVICIO DEBE IMPLEMENTAR =====
    
    /**
     * Retorna el tipo de servicio (gps, voz, iot)
     */
    getServiceType() {
        throw new Error('getServiceType() debe ser implementado por la subclase');
    }

    /**
     * Obtiene los registros a procesar según la lógica del servicio
     */
    async getRecordsToProcess() {
        throw new Error('getRecordsToProcess() debe ser implementado por la subclase');
    }

    /**
     * Procesa los registros usando la lógica específica del servicio
     */
    async processRecords(records, stats) {
        throw new Error('processRecords() debe ser implementado por la subclase');
    }

    /**
     * Procesa una recarga pendiente específica del servicio
     */
    async processCompletePendingRecharge(recharge) {
        throw new Error('processCompletePendingRecharge() debe ser implementado por la subclase');
    }

    // ===== MÉTODOS WEBSERVICE DELEGADOS =====
    
    /**
     * Obtiene balance de TAECEL (delegado a WebserviceClient)
     */
    async getTaecelBalance() {
        const { WebserviceClient } = require('../webservices/WebserviceClient');
        return await WebserviceClient.getTaecelBalance();
    }

    /**
     * Obtiene balance de MST (delegado a WebserviceClient)
     */
    async getMstBalance() {
        const { WebserviceClient } = require('../webservices/WebserviceClient');
        return await WebserviceClient.getMstBalance();
    }
}

module.exports = { BaseRechargeProcessor };