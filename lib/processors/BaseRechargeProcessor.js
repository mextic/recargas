const moment = require('moment-timezone');
const { createErrorHandler } = require('../utils/errorHandler');
const { createServiceLogger } = require('../utils/logger');

/**
 * Clase base abstracta para todos los procesadores de recargas
 * Centraliza lógica común y define template method pattern
 * Incluye manejo inteligente de errores y logging estructurado
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
        
        // Inicializar sistema de errores y logging
        const serviceType = this.getServiceType ? this.getServiceType() : 'UNKNOWN';
        this.errorHandler = createErrorHandler(serviceType);
        this.logger = createServiceLogger(serviceType);
        
        this.logger.info('Processor inicializado con sistema de errores inteligente', {
            operation: 'processor_init',
            serviceType,
            configKeys: Object.keys(config || {})
        });
    }

    // ===== TEMPLATE METHOD PATTERN =====
    async process() {
        const stats = { processed: 0, success: 0, failed: 0 };
        const lockKey = `recharge_${this.getServiceType()}`;
        const lockId = `${lockKey}_${process.pid}_${Date.now()}`;
        let lockAcquired = false;

        this.logger.info('Iniciando proceso de recarga', {
            operation: 'process_start',
            serviceType: this.getServiceType(),
            lockKey,
            lockId
        });

        try {
            // 1. Adquirir lock distribuido
            const lockExpirationMinutes = parseInt(process.env.LOCK_EXPIRATION_MINUTES) || 60;
            const lockTimeoutSeconds = lockExpirationMinutes * 60;
            
            const lockResult = await this.executeWithRetry(
                async () => await this.lockManager.acquireLock(lockKey, lockId, lockTimeoutSeconds),
                {
                    operationName: 'acquire_lock',
                    transactionId: lockId
                }
            );
            
            if (!lockResult.success) {
                this.logger.warn('No se pudo adquirir lock distribuido', {
                    operation: 'lock_acquisition_failed',
                    lockKey,
                    serviceType: this.getServiceType()
                });
                return stats;
            }
            lockAcquired = true;

            this.logger.info('Lock adquirido exitosamente', {
                operation: 'lock_acquired',
                lockKey,
                expirationSeconds: lockTimeoutSeconds
            });

            // 2. RECOVERY ESTRICTO - Procesar cola auxiliar primero
            this.logger.info('Verificando cola auxiliar para recovery', {
                operation: 'check_recovery_queue',
                serviceType: this.getServiceType()
            });

            const pendingStats = await this.executeWithRetry(
                async () => await this.persistenceQueue.getQueueStats(),
                {
                    operationName: 'get_queue_stats',
                    transactionId: `stats_${Date.now()}`
                }
            );
            
            if (pendingStats.auxiliaryQueue.pendingDb > 0) {
                this.logger.info('Procesando recargas de recovery', {
                    operation: 'processing_recovery',
                    pendingCount: pendingStats.auxiliaryQueue.pendingDb,
                    serviceType: this.getServiceType()
                });

                const recoveryResult = await this.executeWithRetry(
                    async () => await this.processAuxiliaryQueueRecharges(),
                    {
                        operationName: 'process_auxiliary_queue',
                        transactionId: `recovery_${Date.now()}`
                    }
                );

                this.logger.info('Recovery completado', {
                    operation: 'recovery_completed',
                    processed: recoveryResult.processed,
                    failed: recoveryResult.failed,
                    serviceType: this.getServiceType()
                });
                
                // POLÍTICA ESTRICTA: Si hay fallas en recovery, NO procesar nuevos registros
                if (recoveryResult.failed > 0) {
                    this.logger.warn('Registros pendientes sin procesar, saltando nuevos registros', {
                        operation: 'recovery_failed_skip_new',
                        failedCount: recoveryResult.failed,
                        serviceType: this.getServiceType()
                    });
                    stats.failed = recoveryResult.failed;
                }
            } else {
                // 3. Procesar nuevos registros solo si no hay recovery pendiente
                let records = [];
                try {
                    records = await this.executeWithRetry(
                        async () => await this.getRecordsToProcess(),
                        {
                            operationName: 'get_records_to_process',
                            transactionId: `records_${Date.now()}`
                        }
                    );

                    this.logger.info('Registros obtenidos para procesamiento', {
                        operation: 'records_fetched',
                        recordCount: records.length,
                        serviceType: this.getServiceType()
                    });

                    if (records.length > 0) {
                        // 4. Procesar registros usando implementación específica
                        const processResult = await this.executeWithRetry(
                            async () => await this.processRecords(records, stats),
                            {
                                operationName: 'process_records',
                                transactionId: `process_${Date.now()}`,
                                recordCount: records.length
                            }
                        );
                        Object.assign(stats, processResult);
                    }
                } catch (error) {
                    this.logger.error('Error al obtener registros para procesamiento', {
                        operation: 'get_records_error',
                        error: error.message,
                        serviceType: this.getServiceType()
                    });
                    // Continuar con stats vacíos en caso de error
                    stats.processed = 0;
                    stats.success = 0;
                    stats.failed = 0;
                }
            }

            this.logger.info('Proceso completado exitosamente', {
                operation: 'process_completed',
                stats,
                serviceType: this.getServiceType()
            });

            return stats;

        } catch (error) {
            this.logger.error('Error crítico en proceso de recarga', error, {
                operation: 'process_critical_error',
                serviceType: this.getServiceType(),
                lockAcquired
            });
            throw error;
        } finally {
            if (lockAcquired) {
                try {
                    await this.lockManager.releaseLock(lockKey, lockId);
                    this.logger.info('Lock liberado exitosamente', {
                        operation: 'lock_released',
                        lockKey
                    });
                } catch (error) {
                    this.logger.error('Error liberando lock', error, {
                        operation: 'lock_release_error',
                        lockKey
                    });
                }
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
        // Usar el nuevo sistema de error handling inteligente
        const context = {
            operation: config.operationName || 'unknown_operation',
            serviceName: this.getServiceType(),
            transactionId: config.transactionId || `txn_${Date.now()}`,
            startTime: Date.now()
        };

        const options = {
            alternateProviderCallback: config.alternateProviderCallback
        };

        return await this.errorHandler.executeWithSmartRetry(operation, context, options);
    }

    // ===== RECOVERY COMÚN =====
    async processAuxiliaryQueueRecharges() {
        const stats = { processed: 0, failed: 0, success: 0 };
        const serviceType = this.getServiceType();

        this.logger.info('Iniciando procesamiento de cola auxiliar', {
            operation: 'process_auxiliary_queue_start',
            serviceType
        });

        try {
            // Usar la cola auxiliar específica del servicio
            const auxiliaryQueue = this.persistenceQueue.auxiliaryQueue;
            
            if (!auxiliaryQueue || auxiliaryQueue.length === 0) {
                this.logger.info('Cola auxiliar vacía', {
                    operation: 'auxiliary_queue_empty',
                    serviceType
                });
                return stats;
            }

            // Filtrar registros pendientes del servicio específico
            const pendingRecharges = auxiliaryQueue.filter(item =>
                item.tipo === `${serviceType}_recharge` &&
                (item.status === 'webservice_success_pending_db' ||
                 item.status === 'db_insertion_failed_pending_recovery')
            );

            this.logger.info('Recargas pendientes filtradas', {
                operation: 'filter_pending_recharges',
                serviceType,
                totalInQueue: auxiliaryQueue.length,
                pendingForService: pendingRecharges.length
            });

            if (pendingRecharges.length === 0) {
                return stats;
            }

            // Procesar recargas pendientes - usar batch processing si está disponible
            const processedSims = new Set();

            // Verificar si el servicio soporta batch processing
            if (this.insertBatchRecharges && typeof this.insertBatchRecharges === 'function') {
                // BATCH PROCESSING: Procesar todas las recargas como un lote maestro/detalle
                this.logger.info('Procesando recargas como lote', {
                    operation: 'batch_processing_start',
                    serviceType,
                    batchSize: pendingRecharges.length
                });

                try {
                    await this.executeWithRetry(
                        async () => await this.insertBatchRecharges(pendingRecharges),
                        {
                            operationName: 'insert_batch_recharges',
                            transactionId: `batch_recovery_${Date.now()}`,
                            batchSize: pendingRecharges.length
                        }
                    );
                    
                    stats.processed = pendingRecharges.length;
                    pendingRecharges.forEach(recharge => processedSims.add(recharge.sim));
                    
                    this.logger.info('Lote de recovery procesado exitosamente', {
                        operation: 'batch_processing_success',
                        serviceType,
                        processed: stats.processed,
                        sims: Array.from(processedSims)
                    });
                } catch (error) {
                    stats.failed = pendingRecharges.length;
                    this.logger.error('Error procesando lote de recovery', error, {
                        operation: 'batch_processing_error',
                        serviceType,
                        batchSize: pendingRecharges.length
                    });
                }
            } else {
                // PROCESAMIENTO INDIVIDUAL: Para servicios sin batch (VOZ)
                this.logger.info('Procesando recargas individualmente', {
                    operation: 'individual_processing_start',
                    serviceType,
                    count: pendingRecharges.length
                });

                for (const recharge of pendingRecharges) {
                    try {
                        await this.executeWithRetry(
                            async () => await this.processCompletePendingRecharge(recharge),
                            {
                                operationName: 'process_complete_pending_recharge',
                                transactionId: `recovery_${recharge.sim}_${Date.now()}`,
                                sim: recharge.sim
                            }
                        );
                        
                        stats.processed++;
                        processedSims.add(recharge.sim);
                        
                        this.logger.info('Recarga individual procesada exitosamente', {
                            operation: 'individual_recharge_success',
                            serviceType,
                            sim: recharge.sim
                        });
                    } catch (error) {
                        stats.failed++;
                        this.logger.error('Error procesando recarga individual', error, {
                            operation: 'individual_recharge_error',
                            serviceType,
                            sim: recharge.sim
                        });
                    }
                }
            }

            // Limpiar registros procesados exitosamente usando sistema de persistencia
            if (stats.processed > 0) {
                const originalLength = this.persistenceQueue.auxiliaryQueue.length;
                
                this.persistenceQueue.auxiliaryQueue = this.persistenceQueue.auxiliaryQueue.filter(item => {
                    if (item.tipo === `${serviceType}_recharge` && processedSims.has(item.sim)) {
                        return false; // Remover exitosos
                    }
                    return true; // Mantener los demás
                });
                
                await this.executeWithRetry(
                    async () => await this.persistenceQueue.saveAuxiliaryQueue(),
                    {
                        operationName: 'save_auxiliary_queue',
                        transactionId: `cleanup_${Date.now()}`
                    }
                );
                
                const cleanedCount = originalLength - this.persistenceQueue.auxiliaryQueue.length;
                this.logger.info('Cola auxiliar limpiada exitosamente', {
                    operation: 'auxiliary_queue_cleanup',
                    serviceType,
                    removedCount: cleanedCount,
                    remainingInQueue: this.persistenceQueue.auxiliaryQueue.length
                });
            }

        } catch (error) {
            stats.failed++;
            this.logger.error('Error crítico procesando cola auxiliar', error, {
                operation: 'auxiliary_queue_critical_error',
                serviceType
            });
        }

        this.logger.info('Procesamiento de cola auxiliar completado', {
            operation: 'process_auxiliary_queue_completed',
            serviceType,
            stats
        });

        return stats;
    }

    // ===== MÉTODOS DE PROVIDERS COMUNES =====
    async getProvidersOrderedByBalance() {
        const providers = [];
        
        // Obtener balance TAECEL con error handling inteligente
        const taecelBalance = await this.executeWithRetry(
            async () => {
                this.logger.info('Consultando saldo TAECEL', { operation: 'get_taecel_balance' });
                return await this.getTaecelBalance();
            },
            { 
                operationName: 'get_taecel_balance',
                transactionId: `balance_check_${Date.now()}`
            }
        ).catch(error => {
            this.logger.error('Error consultando saldo TAECEL, usando 0', error, {
                operation: 'get_taecel_balance_fallback'
            });
            return 0;
        });

        providers.push({ name: 'TAECEL', balance: taecelBalance });
        this.logger.info(`Balance TAECEL obtenido: $${taecelBalance}`, {
            operation: 'balance_result',
            provider: 'TAECEL',
            balance: taecelBalance
        });

        // Obtener balance MST con error handling inteligente
        const mstBalance = await this.executeWithRetry(
            async () => {
                this.logger.info('Consultando saldo MST', { operation: 'get_mst_balance' });
                return await this.getMstBalance();
            },
            { 
                operationName: 'get_mst_balance',
                transactionId: `balance_check_${Date.now()}`
            }
        ).catch(error => {
            this.logger.error('Error consultando saldo MST, usando 0', error, {
                operation: 'get_mst_balance_fallback'
            });
            return 0;
        });

        providers.push({ name: 'MST', balance: mstBalance });
        this.logger.info(`Balance MST obtenido: $${mstBalance}`, {
            operation: 'balance_result',
            provider: 'MST',
            balance: mstBalance
        });

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