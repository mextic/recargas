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

                // POLÍTICA ESTRICTA: NO procesar nuevos registros si hay CUALQUIER elemento en cola auxiliar
                this.logger.warn('Cola auxiliar con elementos pendientes - BLOQUEANDO consumo de webservice', {
                    operation: 'auxiliary_queue_blocking_webservice',
                    pendingCount: pendingStats.auxiliaryQueue.pendingDb,
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
                stats.blockedReason = 'auxiliary_queue_not_empty';
                stats.pendingInQueue = pendingStats.auxiliaryQueue.pendingDb;

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
                        async () => await this.insertBatchRecharges(pendingRecharges, true), // isRecovery=true
                        {
                            operationName: 'insert_batch_recharges',
                            transactionId: `batch_recovery_${Date.now()}`,
                            batchSize: pendingRecharges.length
                        }
                    );

                    // VALIDACIÓN CRÍTICA: Verificar que realmente se insertaron en BD
                    this.logger.info('Verificando inserción en BD', {
                        operation: 'validate_batch_insertion',
                        serviceType,
                        batchSize: pendingRecharges.length
                    });

                    const { verified, notVerified } = await this.validateRechargesInDB(pendingRecharges);

                    if (notVerified.length > 0) {
                        this.logger.error('Recargas no verificadas en BD', {
                            operation: 'batch_validation_failed',
                            serviceType,
                            notVerified: notVerified.length,
                            totalBatch: pendingRecharges.length
                        });

                        // Marcar no verificadas para reintento
                        notVerified.forEach(item => {
                            item.status = 'db_verification_failed';
                            item.attempts = (item.attempts || 0) + 1;
                        });
                    }

                    // Solo marcar como procesadas las VERIFICADAS
                    stats.processed = verified.length;
                    stats.failed = notVerified.length;
                    verified.forEach(sim => processedSims.add(sim));

                    this.logger.info('Lote de recovery validado', {
                        operation: 'batch_processing_success',
                        serviceType,
                        verified: verified.length,
                        notVerified: notVerified.length,
                        verifiedSims: verified
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

            // LIMPIEZA INTELIGENTE: Limpiar items procesados exitosamente
            if (stats.processed > 0) {
                console.log(`   🧹 LIMPIEZA INTELIGENTE: Limpiando items procesados exitosamente de cola auxiliar...`);

                // Usar el nuevo método de limpieza selectiva
                const cleanupResult = await this.executeWithRetry(
                    async () => await this.persistenceQueue.cleanProcessedItems(),
                    {
                        operationName: 'clean_processed_queue_items',
                        transactionId: `cleanup_processed_${Date.now()}`
                    }
                );

                console.log(`   ✅ LIMPIEZA COMPLETADA: ${cleanupResult.cleaned} items procesados removidos, ${cleanupResult.remaining} items pendientes`);

                this.logger.info('Cola auxiliar limpiada inteligentemente', {
                    operation: 'auxiliary_queue_intelligent_cleanup',
                    serviceType,
                    cleanedItems: cleanupResult.cleaned,
                    remainingItems: cleanupResult.remaining,
                    totalProcessed: stats.processed
                });

                // Mostrar estadísticas detalladas de la cola
                const queueStats = await this.persistenceQueue.getQueueStats();
                console.log(`   📊 ESTADO COLA: Total: ${queueStats.auxiliaryQueue.total}, ` +
                           `Pendientes: ${queueStats.auxiliaryQueue.pending}, ` +
                           `Insertados: ${queueStats.auxiliaryQueue.inserted}, ` +
                           `Duplicados: ${queueStats.auxiliaryQueue.duplicate}, ` +
                           `Fallidos: ${queueStats.auxiliaryQueue.failed}`);
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

        if (!global.PROGRESS_ACTIVE) {
            console.log(`   🏆 Proveedor con más saldo: ${validProviders[0].name} ($${validProviders[0].balance})`);
        }
        return validProviders;
    }

    // ===== VALIDACIÓN BD PARA PREVENIR PÉRDIDA DE RECARGAS =====

    /**
     * Valida que las recargas realmente se insertaron en BD
     * Verifica tanto el folio en detalle_recargas como la actualización del saldo
     */
    async validateRechargesInDB(recharges) {
        const serviceType = this.getServiceType();
        const verified = [];
        const notVerified = [];

        this.logger.info('Iniciando validación de recargas en BD', {
            operation: 'validate_recharges_start',
            serviceType,
            rechargesToValidate: recharges.length
        });

        for (const recharge of recharges) {
            const folio = this.extractFolio(recharge);

            if (!folio) {
                this.logger.warn(`No se pudo extraer folio para SIM ${recharge.sim}`, {
                    operation: 'folio_extraction_failed',
                    sim: recharge.sim,
                    serviceType
                });
                notVerified.push(recharge);
                continue;
            }

            try {
                // Verificar folio en detalle_recargas
                const folioExists = await this.checkFolioExists(folio, recharge.sim);

                if (folioExists) {
                    // Verificar que el saldo se actualizó según el servicio
                    const saldoUpdated = await this.verifySaldoUpdate(recharge, serviceType);

                    if (saldoUpdated) {
                        verified.push(recharge.sim);
                        this.logger.info(`Recarga verificada exitosamente`, {
                            operation: 'recharge_verified',
                            sim: recharge.sim,
                            folio,
                            serviceType
                        });
                    } else {
                        this.logger.warn(`Folio existe pero saldo no actualizado`, {
                            operation: 'saldo_not_updated',
                            sim: recharge.sim,
                            folio,
                            serviceType
                        });
                        notVerified.push(recharge);
                    }
                } else {
                    this.logger.warn(`Folio no encontrado en BD`, {
                        operation: 'folio_not_found',
                        sim: recharge.sim,
                        folio,
                        serviceType
                    });
                    notVerified.push(recharge);
                }

            } catch (error) {
                this.logger.error(`Error validando recarga ${recharge.sim}`, error, {
                    operation: 'validation_error',
                    sim: recharge.sim,
                    folio,
                    serviceType
                });
                notVerified.push(recharge);
            }
        }

        this.logger.info('Validación de recargas completada', {
            operation: 'validate_recharges_completed',
            serviceType,
            verified: verified.length,
            notVerified: notVerified.length,
            totalProcessed: recharges.length
        });

        return { verified, notVerified };
    }

    /**
     * Extrae el folio de TAECEL de la estructura de respuesta del webservice
     */
    extractFolio(recharge) {
        // Intentar múltiples ubicaciones donde puede estar el folio
        const webserviceData = recharge.webserviceData || {};
        const webserviceResponse = recharge.webserviceResponse || {};

        return webserviceResponse?.folio ||
               webserviceResponse?.response?.originalResponse?.Folio ||
               webserviceResponse?.data?.Folio ||
               webserviceData?.data?.Folio ||
               webserviceData?.response?.Folio ||
               webserviceData?.data?.folio ||
               webserviceData?.response?.folio ||
               webserviceData?.transID ||
               webserviceData?.TransID ||
               null;
    }

    /**
     * Verifica que el folio existe en la tabla detalle_recargas
     */
    async checkFolioExists(folio, sim) {
        try {
            this.logger.info(`Verificando folio en detalle_recargas`, {
                operation: 'checking_folio_exists',
                folio: folio,
                sim: sim
            });

            const result = await this.db.querySequelize(
                `SELECT id_recarga FROM detalle_recargas
                 WHERE folio = ? AND sim = ?
                 LIMIT 1`,
                {
                    replacements: [folio, sim],
                    type: this.db.getSequelizeClient().QueryTypes.SELECT
                }
            );

            const exists = result && result.length > 0;

            this.logger.info(`Resultado verificación folio`, {
                operation: 'folio_check_result',
                folio: folio,
                sim: sim,
                exists: exists,
                resultCount: result ? result.length : 0
            });

            return exists;
        } catch (error) {
            this.logger.error(`Error verificando folio ${folio}`, error, {
                operation: 'folio_check_error',
                folio: folio,
                sim: sim
            });
            return false;
        }
    }

    /**
     * Verifica que el saldo se actualizó según el servicio específico
     */
    async verifySaldoUpdate(recharge, serviceType) {
        let query, dbClient;

        try {
            switch(serviceType.toLowerCase()) {
                case 'gps':
                    query = `SELECT unix_saldo FROM dispositivos WHERE sim = ?`;
                    dbClient = this.db;
                    break;

                case 'voz':
                    query = `SELECT fecha_expira_saldo FROM prepagos_automaticos WHERE sim = ?`;
                    dbClient = this.db;
                    break;

                case 'eliot':
                    query = `SELECT fecha_saldo FROM agentes WHERE sim = ?`;
                    // ELIoT usa BD diferente - delegado a implementación específica
                    dbClient = this.getELIoTDatabase ? this.getELIoTDatabase() : this.db;
                    break;

                default:
                    this.logger.warn(`Tipo de servicio desconocido: ${serviceType}`);
                    return false;
            }

            const result = await dbClient.querySequelize(
                query,
                {
                    replacements: [recharge.sim],
                    type: dbClient.getSequelizeClient().QueryTypes.SELECT
                }
            );

            if (result && result.length > 0) {
                const saldoValue = Object.values(result[0])[0]; // Primer valor del objeto

                if (serviceType.toLowerCase() === 'gps') {
                    // Para GPS verificar que unix_saldo sea futuro
                    const now = Math.floor(Date.now() / 1000);
                    return saldoValue > now;
                } else {
                    // Para VOZ y ELIoT verificar que la fecha sea futura
                    // Asumir formato timestamp o fecha válida
                    const saldoDate = new Date(saldoValue);
                    const now = new Date();
                    return saldoDate > now;
                }
            }

            return false;

        } catch (error) {
            this.logger.error(`Error verificando saldo para ${recharge.sim}`, error, {
                operation: 'verify_saldo_error',
                serviceType,
                sim: recharge.sim
            });
            return false;
        }
    }

    /**
     * Verifica si hay items pendientes en la cola auxiliar (REFORZADO)
     * NO permite nuevas recargas hasta que TODAS estén verificadas al 100% en BD
     */
    async checkPendingItems() {
        const auxiliaryQueue = this.persistenceQueue.auxiliaryQueue || [];
        const serviceType = this.getServiceType();

        // Filtrar items pendientes del servicio
        const pendingItems = auxiliaryQueue.filter(item =>
            item.tipo === `${serviceType}_recharge` && (
                item.status === 'webservice_success_pending_db' ||
                item.status === 'db_verification_failed' ||
                item.status === 'db_insertion_failed_pending_recovery'
            )
        );

        // VALIDACIÓN EXHAUSTIVA: Si hay items pendientes, verificar REALMENTE si están en BD
        if (pendingItems.length > 0) {
            console.log(`   🔍 BLOQUEO SEGURIDAD: Verificando ${pendingItems.length} items pendientes...`);

            try {
                const { verified, notVerified } = await this.validateRechargesInDB(pendingItems);

                if (notVerified.length > 0) {
                    console.log(`   🚫 BLOQUEO ACTIVO: ${notVerified.length}/${pendingItems.length} recargas NO verificadas en BD`);
                    console.log(`   📋 SIMs pendientes: ${notVerified.join(', ')}`);

                    // Actualizar status de los no verificados
                    pendingItems.forEach(item => {
                        if (notVerified.includes(item.sim)) {
                            item.status = 'db_verification_failed';
                            item.lastValidationAttempt = Date.now();
                        }
                    });

                    // Guardar estado actualizado
                    await this.persistenceQueue.saveAuxiliaryQueue();

                    return pendingItems.filter(item => notVerified.includes(item.sim));
                } else {
                    console.log(`   ✅ Sorpresa: ${verified.length} recargas ya están en BD - Limpiando cola automáticamente`);

                    // Si todas están verificadas, limpiar automáticamente
                    const verifiedSet = new Set(verified);
                    this.persistenceQueue.auxiliaryQueue = this.persistenceQueue.auxiliaryQueue.filter(item => {
                        if (item.tipo === `${serviceType}_recharge` && verifiedSet.has(item.sim)) {
                            console.log(`   🗑️ Auto-limpieza: ${item.sim} encontrado en BD`);
                            return false; // Remover verificados
                        }
                        return true;
                    });

                    await this.persistenceQueue.saveAuxiliaryQueue();
                    return []; // No hay pendientes reales
                }

            } catch (error) {
                this.logger.error('Error en validación exhaustiva de items pendientes', error, {
                    operation: 'pending_items_validation_error',
                    serviceType,
                    pendingCount: pendingItems.length
                });

                // En caso de error, ser conservador y bloquear
                return pendingItems;
            }
        }

        return []; // No hay items pendientes
    }

    /**
     * Obtiene información de saldo según el servicio
     */
    async getSaldoInfo(sim, serviceType) {
        try {
            switch(serviceType.toLowerCase()) {
                case 'gps':
                    const gpsResult = await this.db.querySequelize(
                        `SELECT unix_saldo FROM dispositivos WHERE sim = ?`,
                        {
                            replacements: [sim],
                            type: this.db.getSequelizeClient().QueryTypes.SELECT
                        }
                    );
                    if (gpsResult && gpsResult.length > 0) {
                        const unixSaldo = gpsResult[0].unix_saldo;
                        const fecha = new Date(unixSaldo * 1000).toISOString();
                        return `unix_saldo=${unixSaldo} (${fecha})`;
                    }
                    return 'No encontrado en dispositivos';

                case 'voz':
                    const vozResult = await this.db.querySequelize(
                        `SELECT fecha_expira_saldo FROM prepagos_automaticos WHERE sim = ?`,
                        {
                            replacements: [sim],
                            type: this.db.getSequelizeClient().QueryTypes.SELECT
                        }
                    );
                    return vozResult && vozResult.length > 0 ?
                        `fecha_expira_saldo=${vozResult[0].fecha_expira_saldo}` :
                        'No encontrado en prepagos_automaticos';

                case 'eliot':
                    // ELIoT requiere BD diferente - delegado a implementación específica
                    if (this.getELIoTSaldoInfo) {
                        return await this.getELIoTSaldoInfo(sim);
                    }
                    return 'ELIoT BD no configurada';

                default:
                    return `Servicio desconocido: ${serviceType}`;
            }
        } catch (error) {
            return `Error: ${error.message}`;
        }
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