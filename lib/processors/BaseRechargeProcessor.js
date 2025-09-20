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

                // PASO 7.0 CRÍTICO: Verificar si cola auxiliar quedó vacía después de procesamiento
                const remainingItems = await this.checkPendingItems();

                if (remainingItems.length > 0) {
                    // Cola NO vacía - BLOQUEAR webservice
                    this.logger.warn('Cola auxiliar con elementos pendientes - BLOQUEANDO consumo de webservice', {
                        operation: 'auxiliary_queue_blocking_webservice',
                        pendingCount: remainingItems.length,
                        processedInThisCycle: recoveryResult.processed,
                        failedInThisCycle: recoveryResult.failed,
                        serviceType: this.getServiceType(),
                        blockingReason: 'prevent_double_charge_and_ensure_consistency'
                    });

                    // Actualizar estadísticas con recovery
                    stats.processed = recoveryResult.processed;
                    stats.success = recoveryResult.processed - recoveryResult.failed;
                    stats.failed = recoveryResult.failed;
                    stats.blocked = true;
                    stats.blockedReason = 'auxiliary_queue_not_empty_after_processing';
                    stats.pendingItems = remainingItems.length;

                    // NO continuar con nuevos registros - esto es crítico para evitar doble cobro
                    this.logger.info('Proceso completado - Solo recovery ejecutado', {
                        operation: 'process_completed_recovery_only',
                        stats,
                        serviceType: this.getServiceType(),
                        nextAction: 'Execute again to continue recovery until queue is empty'
                    });

                    // CRÍTICO: RETURN aquí para evitar procesar nuevos registros cuando hay cola auxiliar
                    // El finally se ejecutará automáticamente para liberar el lock
                    return stats;
                }

                // Cola auxiliar VACÍA - Actualizar stats y continuar a nuevos registros
                this.logger.info('Cola auxiliar vacía después de recovery - Continuando a nuevos registros', {
                    operation: 'auxiliary_queue_empty_after_recovery',
                    serviceType: this.getServiceType()
                });

                // Actualizar stats base con lo procesado en recovery
                stats.processed = recoveryResult.processed;
                stats.success = recoveryResult.processed - recoveryResult.failed;
                stats.failed = recoveryResult.failed;
            }

            // 3. Procesar nuevos registros (SIEMPRE - tanto si hubo recovery como si no)
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
                    // 4. Filtrar registros para separar los que requieren recarga vs ahorro
                    const filterResult = await this.executeWithRetry(
                        async () => await this.filterRecordsForRecharge(records),
                        {
                            operationName: 'filter_records_for_recharge',
                            transactionId: `filter_${Date.now()}`,
                            recordCount: records.length
                        }
                    );

                    const { toRecharge, savings, metrics } = filterResult;

                    this.logger.info('Filtrado de registros completado', {
                        operation: 'records_filtering_completed',
                        serviceType: this.getServiceType(),
                        totalRecords: records.length,
                        toRecharge: toRecharge.length,
                        savings: savings.length,
                        savingsPercentage: records.length > 0 ? Math.round((savings.length / records.length) * 100) : 0,
                        metrics
                    });

                    // Solo procesar los registros que realmente requieren recarga
                    if (toRecharge.length > 0) {
                        this.logger.info('🚀 INICIANDO PROCESAMIENTO DE WEBSERVICE', {
                            operation: 'about_to_call_process_records',
                            serviceType: this.getServiceType(),
                            recordsToProcess: toRecharge.length,
                            currentStats: stats
                        });

                        // 5. Procesar registros usando implementación específica
                        const processResult = await this.executeWithRetry(
                            async () => await this.processRecords(toRecharge, stats),
                            {
                                operationName: 'process_records',
                                transactionId: `process_${Date.now()}`,
                                recordCount: toRecharge.length
                            }
                        );

                        this.logger.info('✅ PROCESAMIENTO DE WEBSERVICE COMPLETADO', {
                            operation: 'process_records_completed',
                            serviceType: this.getServiceType(),
                            processResult: processResult,
                            originalStats: stats
                        });

                        // Combinar stats de recovery (si los hubo) con los de nuevos registros
                        const combinedStats = {
                            processed: (stats.processed || 0) + (processResult.processed || 0),
                            success: (stats.success || 0) + (processResult.success || 0),
                            failed: (stats.failed || 0) + (processResult.failed || 0)
                        };

                        // Preservar otras propiedades del processResult
                        Object.keys(processResult).forEach(key => {
                            if (!['processed', 'success', 'failed'].includes(key)) {
                                combinedStats[key] = processResult[key];
                            }
                        });

                        // Actualizar stats con los valores combinados
                        Object.assign(stats, combinedStats);

                        this.logger.info('📊 STATS FINALES COMBINADAS', {
                            operation: 'final_stats_combined',
                            serviceType: this.getServiceType(),
                            finalStats: stats
                        });
                    } else {
                        this.logger.info('No hay registros que requieran recarga tras filtrado', {
                            operation: 'no_records_to_recharge',
                            serviceType: this.getServiceType(),
                            totalEvaluated: records.length,
                            allAreSavings: savings.length === records.length
                        });
                    }

                    // Agregar métricas de ahorro a las estadísticas
                    stats.savingsDetected = savings.length;
                    stats.totalEvaluated = records.length;
                    stats.savingsPercentage = records.length > 0 ? Math.round((savings.length / records.length) * 100) : 0;
                }
            } catch (error) {
                this.logger.error('Error al obtener registros para procesamiento', {
                    operation: 'get_records_error',
                    error: error.message,
                    serviceType: this.getServiceType()
                });
                // No sobrescribir stats si ya hay datos de recovery
                if (stats.processed === 0) {
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
        const stats = {
            processed: 0,
            failed: 0,
            success: 0,
            duplicatesSkipped: 0,
            pendingInQueue: 0
        };
        const serviceType = this.getServiceType();

        this.logger.info('Iniciando procesamiento cola auxiliar con manejo de duplicados', {
            operation: 'process_auxiliary_queue_start_v2',
            serviceType,
            flowVersion: '2.0_con_duplicados'
        });

        try {
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
                ['pending', 'webservice_success_pending_db', 'db_insertion_failed_pending_recovery']
                    .includes(item.status)
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

            console.log(`📦 ${serviceType}: Procesando ${pendingRecharges.length} items de cola auxiliar`);

            // PASO 3: INSERT BATCH con manejo de duplicados
            let insertResults;

            // Usar método especializado si está disponible
            if (this.insertBatchRechargesWithDuplicateHandling &&
                typeof this.insertBatchRechargesWithDuplicateHandling === 'function') {

                insertResults = await this.insertBatchRechargesWithDuplicateHandling(
                    pendingRecharges,
                    true  // isRecovery=true para aplicar prefijo "< RECUPERACIÓN >"
                );

            } else {
                // Fallback al método normal
                insertResults = await this.insertBatchRecharges(
                    pendingRecharges,
                    true  // isRecovery=true
                );
                // Simular estructura de resultados para compatibilidad
                insertResults = {
                    inserted: pendingRecharges,
                    duplicates: [],
                    errors: []
                };
            }

            const { inserted, duplicates, errors } = insertResults;

            // Log duplicados detectados por índice único
            if (duplicates && duplicates.length > 0) {
                console.log(`⚠️ ${serviceType}: ${duplicates.length} duplicados prevenidos por índice único`);
                duplicates.forEach(dup => {
                    this.logger.warn('Duplicado prevenido por índice único BD', {
                        sim: dup.sim || dup.record?.sim,
                        folio: dup.webserviceResponse?.folio,
                        serviceType,
                        preventedBy: 'idx_sim_folio'
                    });
                });
                stats.duplicatesSkipped = duplicates.length;
            }

            // PASO 4: VALIDATE - verificar que se insertaron en BD (insertados + duplicados)
            const allProcessed = [...(inserted || []), ...(duplicates || [])];
            const { verified, notVerified } = await this.validateRechargesInDB(allProcessed);

            console.log(`✅ ${serviceType}: ${verified.length} recargas verificadas en BD`);

            if (notVerified.length > 0) {
                console.warn(`⚠️ ${serviceType}: ${notVerified.length} recargas NO verificadas en BD`);

                // Log específico para items que se marcaron como duplicados pero no están en BD
                const duplicatesNotInDB = notVerified.filter(item => item.insertionStatus === 'duplicate');
                if (duplicatesNotInDB.length > 0) {
                    console.warn(`🚨 ${serviceType}: ${duplicatesNotInDB.length} items marcados como duplicados pero NO están en BD - Posible problema de atomicidad`);
                }
            }

            // PASO 5-6: MANEJO COLA y CLEANUP
            // SOLO remover de cola los elementos VERIFICADOS en BD (atomicidad real)
            if (verified.length > 0) {
                await this.cleanupSpecificItems(verified);
                console.log(`🧹 ${serviceType}: ${verified.length} items verificados removidos de cola`);
            }

            // Elementos no verificados permanecen en cola para reintento
            if (notVerified.length > 0) {
                console.log(`⏳ ${serviceType}: ${notVerified.length} items permanecen en cola para reintento`);
            }

            // Actualizar estadísticas finales basadas en verificación real
            stats.processed = verified.length;
            stats.pendingInQueue = notVerified.length;
            stats.duplicatesSkipped = duplicates?.length || 0;
            stats.verifiedInDB = verified.length;
            stats.notVerifiedInDB = notVerified.length;

            this.logger.info('Procesamiento cola auxiliar completado', {
                operation: 'auxiliary_queue_completed',
                serviceType,
                processed: stats.processed,
                duplicatesSkipped: stats.duplicatesSkipped,
                pendingInQueue: stats.pendingInQueue,
                verifiedInDB: stats.verifiedInDB,
                notVerifiedInDB: stats.notVerifiedInDB,
                itemsRemoved: verified.length,
                atomicityCheck: 'verified_before_cleanup'
            });

        } catch (error) {
            this.logger.error('Error procesando cola auxiliar', {
                error: error.message,
                serviceType,
                flowVersion: '2.0_con_duplicados'
            });
            stats.failed = 0; // Error antes de procesar, no hay datos de pendingRecharges
            stats.pendingInQueue = 0;
        }

        return stats;
    }

    // Método auxiliar para manejar limpieza específica de items
    async cleanupSpecificItems(itemsToRemove) {
        if (!itemsToRemove || itemsToRemove.length === 0) {
            console.log('🧹 No hay items para remover');
            return;
        }

        try {
            console.log('🧹 DEBUGGING CLEANUP:', {
                itemsToRemoveCount: itemsToRemove.length,
                firstItemType: typeof itemsToRemove[0],
                firstItemKeys: itemsToRemove[0] ? Object.keys(itemsToRemove[0]) : 'none',
                hasId: itemsToRemove[0]?.id
            });

            // Obtener IDs de items a remover
            const idsToRemove = itemsToRemove.map(item => item.id).filter(id => id);
            console.log('🧹 IDs para remover:', idsToRemove);

            // Filtrar cola auxiliar removiendo items especificados
            const currentQueue = this.persistenceQueue.auxiliaryQueue || [];
            console.log('🧹 Cola actual:', {
                currentCount: currentQueue.length,
                currentIds: currentQueue.map(item => item.id)
            });

            const filteredQueue = currentQueue.filter(item => !idsToRemove.includes(item.id));
            console.log('🧹 Cola filtrada:', {
                filteredCount: filteredQueue.length,
                removedCount: currentQueue.length - filteredQueue.length
            });

            // Actualizar cola auxiliar
            this.persistenceQueue.auxiliaryQueue = filteredQueue;
            await this.persistenceQueue.saveAuxiliaryQueue();

            this.logger.info('Items específicos removidos de cola auxiliar', {
                operation: 'cleanup_specific_items',
                removedCount: idsToRemove.length,
                remainingCount: filteredQueue.length
            });

        } catch (error) {
            console.error('❌ ERROR EN CLEANUP:', error);
            this.logger.error('Error limpiando items específicos', {
                error: error.message,
                itemCount: itemsToRemove.length
            });
        }
    }

    // ===== MÉTODOS AUXILIARES PARA PROCESAMIENTO =====

    /**
     * Verifica si hay items pendientes en la cola auxiliar
     */
    async checkPendingItems() {
        const auxiliaryQueue = this.persistenceQueue.auxiliaryQueue || [];
        const serviceType = this.getServiceType();

        // Filtrar items pendientes del servicio
        const pendingItems = auxiliaryQueue.filter(item =>
            item.tipo === `${serviceType}_recharge` &&
            item.status &&
            item.status.includes('pending')
        );

        return pendingItems;
    }

    /**
     * Verifica si un folio específico existe en detalle_recargas
     */
    async checkFolioExists(folio, sim) {
        try {
            const result = await this.db.querySequelize(
                `SELECT COUNT(*) as count FROM detalle_recargas WHERE folio = ? AND sim = ? AND status = 1`,
                {
                    replacements: [folio, sim],
                    type: this.db.getSequelizeClient().QueryTypes.SELECT
                }
            );

            return result && result[0] && result[0].count > 0;
        } catch (error) {
            this.logger.error('Error verificando folio en BD', {
                error: error.message,
                folio,
                sim
            });
            return false;
        }
    }

    /**
     * Valida que las recargas se insertaron correctamente en BD
     */
    async validateRechargesInDB(recharges) {
        const verified = [];
        const notVerified = [];

        for (const recharge of recharges) {
            const folio = recharge.webserviceResponse?.folio;
            const sim = recharge.sim || recharge.record?.sim;

            if (!folio || !sim) {
                notVerified.push(recharge);
                continue;
            }

            const exists = await this.checkFolioExists(folio, sim);
            if (exists) {
                verified.push(recharge);
            } else {
                notVerified.push(recharge);
            }
        }

        return { verified, notVerified };
    }

    // ===== MÉTODOS ABSTRACTOS (IMPLEMENTAR EN SUBCLASES) =====

    /**
     * Filtra registros para separar los que requieren recarga vs los que están en ahorro
     * @param {Array} records - Registros obtenidos de getRecordsToProcess
     * @returns {Object} - { toRecharge: [], savings: [], metrics: {} }
     */
    async filterRecordsForRecharge(records) {
        throw new Error('filterRecordsForRecharge() debe ser implementado por la subclase');
    }

    /**
     * Retorna el tipo de servicio (GPS, VOZ, ELIoT)
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
     * Inserta un lote de recargas en la base de datos
     */
    async insertBatchRecharges(recharges, isRecovery = false) {
        throw new Error('insertBatchRecharges() debe ser implementado por la subclase');
    }

    /**
     * Obtiene proveedores ordenados por saldo disponible
     */
    async getProvidersOrderedByBalance() {
        const { WebserviceClient } = require('../webservices/WebserviceClient');

        try {
            // Obtener saldos de ambos proveedores
            const [taecelBalance, mstBalance] = await Promise.all([
                WebserviceClient.getTaecelBalance(),
                WebserviceClient.getMstBalance()
            ]);

            // Crear array de proveedores con sus saldos
            const providers = [
                {
                    name: 'TAECEL',
                    balance: parseFloat(taecelBalance) || 0
                },
                {
                    name: 'MST',
                    balance: parseFloat(mstBalance) || 0
                }
            ];

            // Ordenar por balance descendente (mayor saldo primero)
            providers.sort((a, b) => b.balance - a.balance);

            // Verificar que al menos un proveedor tenga saldo suficiente
            const minBalance = this.config?.MIN_BALANCE_THRESHOLD || 100; // Default mínimo
            const providersWithSufficientBalance = providers.filter(p => p.balance >= minBalance);

            if (providersWithSufficientBalance.length === 0) {
                throw new Error('No hay proveedores con saldo suficiente para procesar recargas');
            }

            this.logger.debug('Proveedores ordenados por saldo', {
                operation: 'providers_ordered_by_balance',
                providers: providers,
                minBalanceThreshold: minBalance,
                providersWithSufficientBalance: providersWithSufficientBalance.length
            });

            return providers;

        } catch (error) {
            this.logger.error('Error obteniendo saldos de proveedores', {
                error: error.message,
                operation: 'get_providers_ordered_by_balance_error'
            });
            throw error;
        }
    }
}

module.exports = { BaseRechargeProcessor };
