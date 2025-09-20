const moment = require('moment-timezone');
const { BaseRechargeProcessor } = require('./BaseRechargeProcessor');
const { WebserviceClient } = require('../webservices/WebserviceClient');
const serviceConfig = require('../../config/services');

class VozRechargeProcessor extends BaseRechargeProcessor {
    constructor(dbConnection, lockManager, persistenceQueue) {
        super(dbConnection, lockManager, persistenceQueue, serviceConfig.VOZ);

        // Configuración específica de paquetes VOZ desde config
        this.paquetes = this.config.PAQUETES;
    }

    getServiceType() {
        return 'voz';
    }

    getServiceConfig() {
        return this.config;
    }

    // ===== IMPLEMENTACIÓN ESPECÍFICA VOZ =====
    async getRecordsToProcess() {
        const tomorrow = moment().add(1, "days").endOf("day").unix();
        const hoy = moment.tz(this.config.GLOBAL?.DEFAULT_TIMEZONE || "America/Mazatlan").format("YYYY-MM-DD");

        const sql = `
            SELECT *
            FROM prepagos_automaticos
            WHERE status = 1
                AND fecha_expira_saldo <= ${tomorrow}
                AND sim NOT IN (
                    SELECT DISTINCT dr.sim
                    FROM detalle_recargas dr
                    INNER JOIN recargas r ON dr.id_recarga = r.id
                    WHERE DATE(FROM_UNIXTIME(r.fecha)) = '${hoy}'
                        AND r.tipo = 'paquete'
                        AND dr.status = 1
                )
            LIMIT 300
        `;

        return await this.executeWithRetry(
            async () => await this.db.querySequelize(sql),
            {
                operationName: 'get_voz_records',
                transactionId: `voz_query_${Date.now()}`
            }
        );
    }

    /**
     * Filtra registros VOZ para separar los que requieren recarga vs los que están en ahorro
     * NOTA: En VOZ no hay concepto de "reportando" - solo se basa en vencimiento
     * @param {Array} records - Registros de prepagos_automaticos
     * @returns {Object} - { toRecharge: [], savings: [], metrics: {} }
     */
    async filterRecordsForRecharge(records) {
        // En VOZ, no existe el concepto de "ahorro por reportar"
        // Todos los registros que vencen/han vencido requieren recarga

        const ahora = moment.tz('America/Mazatlan');
        const ahoraUnix = ahora.unix();
        const finDiaHoy = ahora.clone().endOf('day').unix();
        const mañanaFin = ahora.clone().add(1, 'day').endOf('day').unix();

        let vencidos = 0, porVencer = 0, vigentes = 0;

        // Clasificar dispositivos por estado de saldo
        records.forEach(record => {
            const fechaExpiraSaldo = parseInt(record.fecha_expira_saldo);

            if (fechaExpiraSaldo < ahoraUnix) {
                vencidos++;
            } else if (fechaExpiraSaldo >= ahoraUnix && fechaExpiraSaldo <= mañanaFin) {
                porVencer++;
            } else {
                vigentes++;
            }
        });

        const metrics = {
            vencidos,
            porVencer,
            vigentes,
            algorithm: 'VOZ_EXPIRATION_BASED',
            note: 'VOZ no tiene filtrado por reportes - solo por vencimiento'
        };

        this.logger.info('Filtrado VOZ completado en BaseRechargeProcessor', {
            operation: 'voz_filtering_base_processor',
            totalEvaluados: records.length,
            vencidos,
            porVencer,
            vigentes,
            toRecharge: records.length,
            savings: 0,
            note: 'All VOZ records require recharge - no reporting-based savings'
        });

        return {
            toRecharge: records, // Todos los registros VOZ requieren recarga
            savings: [], // VOZ no tiene concepto de ahorro por reportar
            metrics
        };
    }

    async processRecords(records, stats) {
        // BLOQUEO DE SEGURIDAD: Verificar cola auxiliar antes de procesar nuevas recargas
        const pendingItems = await this.checkPendingItems();

        if (pendingItems.length > 0) {
            console.warn(`⚠️ VOZ BLOQUEO: ${pendingItems.length} recargas pendientes de confirmación en BD`);
            // console.log('📋 Items pendientes VOZ:');

            // for (const item of pendingItems) {
            //     const folio = this.extractFolio(item);
            //     const saldoInfo = await this.getSaldoInfo(item.sim, 'voz');
            //     console.log(`   - ${item.sim}: ${item.status} (folio: ${folio}, saldo: ${saldoInfo})`);
            // }

            // console.log('🔄 Intentando resolver pendientes antes de nuevas recargas...');

            // Intentar procesar pendientes
            const resolvedStats = await this.processAuxiliaryQueueRecharges();

            if (resolvedStats.processed < pendingItems.length) {
                const remaining = pendingItems.length - resolvedStats.processed;
                console.error(`❌ VOZ: No se pudieron resolver todos los pendientes (${remaining} restantes)`);
                // console.log('⛔ ABORTANDO nuevas recargas VOZ para evitar inconsistencias de saldo');

                this.logger.error('VOZ bloqueado por items no confirmados', {
                    operation: 'voz_blocked_pending_items',
                    pendingItems: remaining,
                    resolvedItems: resolvedStats.processed
                });

                // Retornar stats indicando bloqueo
                stats.blocked = true;
                stats.pendingItems = remaining;
                return stats;
            }

            // console.log(`✅ VOZ: ${resolvedStats.processed} items pendientes resueltos. Continuando con nuevas recargas...`);
        }

        if (records.length === 0) {
            this.logger.info('Sin registros VOZ para procesar', {
                operation: 'no_voz_records',
                serviceType: 'VOZ'
            });
            return stats;
        }

        this.logger.info('Estadísticas VOZ', {
            operation: 'voz_statistics',
            serviceType: 'VOZ',
            totalPaquetes: records.length
        });

        // SIMPLIFICADO: Progress tracking con logs simples
        console.log(`📊 [VOZ] Iniciando procesamiento de ${records.length} paquetes`);
        const processStartTime = Date.now();

        // Obtener proveedores ordenados por saldo
        console.log(`📊 [VOZ] Obteniendo proveedores...`);
        const providers = await this.getProvidersOrderedByBalance();
        const provider = providers[0]; // Usar el de mayor saldo

        this.logger.info('Proveedor VOZ seleccionado', {
            operation: 'voz_provider_selected',
            serviceType: 'VOZ',
            provider: provider.name,
            balance: provider.balance
        });

        console.log(`📊 [VOZ] Usando proveedor: ${provider.name} (Saldo: $${provider.balance})`);

        // Procesar cada paquete VOZ
        for (let i = 0; i < records.length; i++) {
            const record = records[i];

            try {
                const paqueteConfig = this.paquetes[record.codigo_paquete];
                if (!paqueteConfig) {
                    this.logger.warn('Código de paquete VOZ desconocido', {
                        operation: 'unknown_package_code',
                        serviceType: 'VOZ',
                        codigoPaquete: record.codigo_paquete,
                        sim: record.sim
                    });
                    const descripcionInfo = record.descripcion || 'N/A';
                    // progressBar.update(i + 1, `VOZ ❌ ${descripcionInfo} [${record.sim}] - Código desconocido`);
                    stats.failed++;
                    continue;
                }

                // Actualizar progreso con información detallada
                const descripcionInfo = record.descripcion || 'N/A';
                // progressBar.update(i, `VOZ - Procesando: ${descripcionInfo} [${record.sim}] - ${paqueteConfig.descripcion} ($${paqueteConfig.monto})`);

                this.logger.info('Procesando paquete VOZ', {
                    operation: 'process_voz_package',
                    serviceType: 'VOZ',
                    currentIndex: i + 1,
                    totalCount: records.length,
                    sim: record.sim,
                    codigoPaquete: record.codigo_paquete,
                    descripcion: paqueteConfig.descripcion,
                    monto: paqueteConfig.monto
                });

                // Usar WebserviceClient centralizado con error handling inteligente
                const rechargeResult = await this.executeWithRetry(
                    async () => await WebserviceClient.executeRecharge(provider, record.sim, paqueteConfig.codigo),
                    {
                        operationName: 'voz_webservice_recharge',
                        transactionId: `voz_${record.sim}_${Date.now()}`,
                        sim: record.sim,
                        codigoPaquete: record.codigo_paquete
                    }
                );

                if (rechargeResult.success) {
                    // Actualizar progreso - éxito
                    const descripcionInfo = record.descripcion || 'N/A';
                    // progressBar.update(i + 1, `VOZ ✅ ${descripcionInfo} [${record.sim}] - Recargado exitosamente`);

                    // Agregar a cola auxiliar VOZ con estructura universal
                    const auxItem = {
                        id: `aux_${Date.now()}_${Math.random()}`,
                        sim: record.sim,
                        vehiculo: record.descripcion || `VOZ-${record.sim}`,
                        empresa: "SERVICIO VOZ",
                        transID: rechargeResult.transID,
                        proveedor: rechargeResult.provider,
                        provider: rechargeResult.provider,

                        // ESTRUCTURA UNIVERSAL PARA VOZ
                        tipo: "voz_recharge",
                        tipoServicio: "VOZ",
                        monto: paqueteConfig.monto,
                        diasVigencia: paqueteConfig.dias,

                        // Datos específicos de VOZ
                        codigoPaquete: record.codigo_paquete,
                        codigoPSL: paqueteConfig.codigo,

                        webserviceResponse: rechargeResult.response,

                        status: "webservice_success_pending_db",
                        timestamp: Date.now(),
                        addedAt: Date.now()
                    };

                    await this.executeWithRetry(
                        async () => await this.persistenceQueue.addToAuxiliaryQueue(auxItem, 'voz'),
                        {
                            operationName: 'add_voz_to_auxiliary_queue',
                            transactionId: `voz_aux_${record.sim}_${Date.now()}`
                        }
                    );

                    stats.processed++;
                    stats.success++;

                    this.logger.info('VOZ recargado exitosamente', {
                        operation: 'voz_recharge_success',
                        serviceType: 'VOZ',
                        sim: record.sim,
                        dias: paqueteConfig.dias,
                        monto: paqueteConfig.monto,
                        provider: rechargeResult.provider,
                        codigoPaquete: record.codigo_paquete
                    });
                } else {
                    // Actualizar progreso - error
                    const descripcionInfo = record.descripcion || 'N/A';
                    // progressBar.update(i + 1, `VOZ ❌ ${descripcionInfo} [${record.sim}] - Error: ${rechargeResult.error}`);

                    stats.failed++;
                    this.logger.error('Recarga VOZ falló', {
                        operation: 'voz_recharge_failed',
                        serviceType: 'VOZ',
                        sim: record.sim,
                        error: rechargeResult.error,
                        codigoPaquete: record.codigo_paquete
                    });
                }

                // Delay entre llamadas (UNIFICADO con GPS: 500ms)
                if (this.config.DELAY_BETWEEN_CALLS > 0 && i < records.length - 1) {
                    await this.delay(this.config.DELAY_BETWEEN_CALLS);
                }

            } catch (error) {
                stats.failed++;
                this.logger.error('Error procesando paquete VOZ', error, {
                    operation: 'process_voz_package_error',
                    serviceType: 'VOZ',
                    sim: record.sim,
                    currentIndex: i + 1
                });
            }
        }

        // SIMPLIFICADO: Log de finalización  
        const elapsedTime = Math.round((Date.now() - processStartTime) / 1000);
        console.log(`✅ [VOZ] Completado: ${stats.successful} exitosos, ${stats.failed} errores en ${elapsedTime > 60 ? Math.floor(elapsedTime / 60) + 'm ' + (elapsedTime % 60) + 's' : elapsedTime + 's'}`);

        return stats;
    }

    // ===== MÉTODOS WEBSERVICE (ahora delegados a WebserviceClient) =====
    async getTaecelBalance() {
        return await WebserviceClient.getTaecelBalance();
    }

    async getMstBalance() {
        return await WebserviceClient.getMstBalance();
    }

    // ===== RECOVERY ESPECÍFICO VOZ =====
    async processCompletePendingRecharge(recharge) {
        let transaction = null;

        try {
            transaction = await this.db.getSequelizeClient().transaction();

            // Insertar en tabla recargas (maestro) - campos correctos según estructura real
            const insertSql = `
                INSERT INTO recargas (fecha, tipo, total, notas, quien, proveedor)
                VALUES (UNIX_TIMESTAMP(), 'paquete', ?, ?, 'SISTEMA_VOZ', ?)
            `;

            const nota = `Recarga VOZ SIM ${recharge.sim} - Paquete ${recharge.codigoPaquete} (${recharge.codigoPSL}) - ${recharge.diasVigencia} días - $${recharge.monto}`;

            const [results] = await this.db.querySequelize(insertSql, {
                replacements: [recharge.monto, nota, recharge.proveedor],
                type: this.db.getSequelizeClient().QueryTypes.INSERT,
                transaction
            });

            const idRecarga = results;

            // Insertar en tabla detalle_recargas (con campo importe que sí existe)
            const detalleSql = `
                INSERT INTO detalle_recargas (id_recarga, sim, importe, dispositivo, vehiculo, detalle, folio, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `;

            // Extraer información de respuesta del webservice
            const folio = recharge.webserviceResponse?.folio || '';
            const saldoFinal = recharge.webserviceResponse?.saldoFinal || 'N/A';
            const timeout = recharge.webserviceResponse?.response?.timeout || '0.00';
            const ip = recharge.webserviceResponse?.response?.ip || '0.0.0.0';
            const telefono = recharge.sim;
            const carrier = recharge.webserviceResponse?.carrier || 'Telcel';
            const fechaRecarga = recharge.webserviceResponse?.fecha || new Date().toISOString().split('T')[0];
            const transID = recharge.webserviceResponse?.transId || '';

            const detalleText = `[ Saldo Final: ${saldoFinal} ] Folio: ${folio}, Cantidad: $${recharge.monto}, Teléfono: ${telefono}, Carrier: ${carrier}, Fecha: ${fechaRecarga}, TransID: ${transID}, Timeout: ${timeout}, IP: ${ip}, Paquete: ${recharge.codigoPaquete} (${recharge.codigoPSL}), Días: ${recharge.diasVigencia}, Provider: ${recharge.proveedor}`;

            await this.db.querySequelize(detalleSql, {
                replacements: [
                    idRecarga,
                    recharge.sim,
                    recharge.monto, // importe
                    '', // No hay dispositivo en VOZ
                    recharge.vehiculo || `VOZ-${recharge.sim}`,
                    detalleText,
                    folio || transID || null,
                    1 // Status: exitosa
                ],
                type: this.db.getSequelizeClient().QueryTypes.INSERT,
                transaction
            });

            // Actualizar fecha_expira_saldo en prepagos_automaticos (+diasVigencia días)
            const updateSql = `
                UPDATE prepagos_automaticos
                SET fecha_expira_saldo = DATE_ADD(NOW(), INTERVAL ? DAY)
                WHERE sim = ?
            `;

            await this.db.querySequelize(updateSql, {
                replacements: [recharge.diasVigencia, recharge.sim],
                type: this.db.getSequelizeClient().QueryTypes.UPDATE,
                transaction
            });

            await transaction.commit();

            this.logger.info('VOZ insertado en BD exitosamente', {
                operation: 'voz_db_insert_success',
                serviceType: 'VOZ',
                sim: recharge.sim,
                diasVigencia: recharge.diasVigencia,
                codigoPaquete: recharge.codigoPaquete,
                monto: recharge.monto
            });

        } catch (error) {
            if (transaction) await transaction.rollback();
            throw error;
        }
    }

    // ===== BATCH PROCESSING VOZ =====
    async insertBatchRecharges(recharges, isRecovery = false) {
        if (!recharges || recharges.length === 0) {
            throw new Error('No hay recargas para insertar en lote VOZ');
        }

        let transaction = null;

        try {
            transaction = await this.db.getSequelizeClient().transaction();

            const fecha = Math.floor(Date.now() / 1000);
            const totalRecargas = recharges.length;
            const totalImporte = recharges.reduce((sum, r) => sum + (r.monto || 0), 0);
            const provider = recharges[0].proveedor || 'TAECEL';

            // Nota del registro maestro VOZ
            let masterNote = `[ ${String(totalRecargas).padStart(3, '0')} / ${String(totalRecargas).padStart(3, '0')} ] Recarga Automática VOZ - ${totalRecargas} paquetes procesados`;

            // CRÍTICO: Agregar prefijo de recuperación si es recovery
            if (isRecovery) {
                masterNote = `< RECUPERACIÓN VOZ > ${masterNote}`;
                this.logger.info('Aplicando prefijo de recuperación a nota maestra VOZ', {
                    operation: 'recovery_prefix_applied',
                    serviceType: 'VOZ',
                    batchSize: totalRecargas
                });
            }

            const resumen = {
                error: 0,
                success: totalRecargas,
                refund: 0
            };

            // 1. INSERTAR REGISTRO MAESTRO EN RECARGAS
            const [idRecarga] = await this.db.querySequelize(
                `INSERT INTO recargas (total, fecha, notas, quien, proveedor, tipo, resumen)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                {
                    replacements: [
                        totalImporte,
                        fecha,
                        masterNote,
                        'mextic.app',
                        provider,
                        'paquete',
                        JSON.stringify(resumen)
                    ],
                    type: this.db.getSequelizeClient().QueryTypes.INSERT,
                    transaction
                }
            );

            // 2. INSERTAR MÚLTIPLES DETALLES LIGADOS AL MAESTRO
            for (let i = 0; i < recharges.length; i++) {
                const recharge = recharges[i];

                // Extraer información de respuesta del webservice para cada registro
                const folio = recharge.webserviceResponse?.folio || '';
                const saldoFinal = recharge.webserviceResponse?.saldoFinal || 'N/A';
                const timeout = recharge.webserviceResponse?.response?.timeout || '0.00';
                const ip = recharge.webserviceResponse?.response?.ip || '0.0.0.0';
                const telefono = recharge.sim;
                const carrier = recharge.webserviceResponse?.carrier || 'Telcel';
                const fechaRecarga = recharge.webserviceResponse?.fecha || new Date().toISOString().split('T')[0];
                const transID = recharge.webserviceResponse?.transId || '';

                const detalleText = `[ Saldo Final: ${saldoFinal} ] Folio: ${folio}, Cantidad: $${recharge.monto}, Teléfono: ${telefono}, Carrier: ${carrier}, Fecha: ${fechaRecarga}, TransID: ${transID}, Timeout: ${timeout}, IP: ${ip}, Paquete: ${recharge.codigoPaquete} (${recharge.codigoPSL}), Días: ${recharge.diasVigencia}, Provider: ${recharge.proveedor}`;

                await this.db.querySequelize(
                    `INSERT INTO detalle_recargas (id_recarga, sim, importe, dispositivo, vehiculo, detalle, folio, status)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    {
                        replacements: [
                            idRecarga,
                            recharge.sim,
                            recharge.monto,
                            '', // VOZ no tiene dispositivo
                            recharge.codigoPaquete, // Usar código de paquete como vehículo
                            detalleText,
                            folio || transID || null,
                            1
                        ],
                        type: this.db.getSequelizeClient().QueryTypes.INSERT,
                        transaction
                    }
                );

                // 3. ACTUALIZAR FECHA DE EXPIRACIÓN EN TABLA ESPECÍFICA
                await this.db.querySequelize(
                    `UPDATE prepagos_automaticos SET fecha_expira_saldo = ? WHERE sim = ?`,
                    {
                        replacements: [recharge.diasVigencia, recharge.sim],
                        type: this.db.getSequelizeClient().QueryTypes.UPDATE,
                        transaction
                    }
                );
            }

            await transaction.commit();

            this.logger.info('Lote VOZ insertado exitosamente', {
                operation: 'voz_batch_insert_success',
                serviceType: 'VOZ',
                totalRecargas,
                idRecarga,
                totalImporte,
                provider
            });

        } catch (error) {
            if (transaction) await transaction.rollback();
            this.logger.error('Error insertando lote VOZ', error, {
                operation: 'voz_batch_insert_error',
                serviceType: 'VOZ',
                totalRecargas,
                totalImporte
            });
            throw error;
        }
    }

    /**
     * Inserta recargas en lote con manejo de duplicados para VOZ
     * Similar a GPS pero adaptado para estructura de datos VOZ
     */
    async insertBatchRechargesWithDuplicateHandling(recharges, isRecovery = false) {
        const results = { inserted: [], duplicates: [], errors: [] };
        const serviceType = this.getServiceType();

        this.logger.info('Iniciando inserción batch con manejo de duplicados VOZ', {
            operation: 'insert_batch_with_duplicate_handling',
            serviceType,
            rechargeCount: recharges.length,
            isRecovery
        });

        // TRANSACCIÓN ATÓMICA: Todo o nada
        const transaction = await this.db.getSequelizeClient().transaction();

        try {
            // Calcular totales específicos para VOZ
            const totalRecargas = recharges.length;
            const totalImporte = recharges.reduce((sum, r) => sum + (r.monto || 0), 0);
            const provider = recharges[0].proveedor || 'TAECEL';

            // Generar nota maestra con o sin prefijo de recuperación
            let masterNote = `[ ${String(totalRecargas).padStart(3, '0')} / ${String(totalRecargas).padStart(3, '0')} ] Recarga Automática VOZ - ${totalRecargas} paquetes procesados`;

            if (isRecovery) {
                masterNote = `< RECUPERACIÓN ${serviceType.toUpperCase()} > ${masterNote}`;
                this.logger.info('Aplicando prefijo de recuperación', {
                    operation: 'recovery_prefix_applied',
                    serviceType,
                    originalNote: `[ ${String(totalRecargas).padStart(3, '0')} / ${String(totalRecargas).padStart(3, '0')} ] Recarga Automática VOZ - ${totalRecargas} paquetes procesados`,
                    finalNote: masterNote
                });
            }

            // Insertar registro maestro DENTRO DE LA TRANSACCIÓN
            const fecha = Math.floor(Date.now() / 1000);
            const resumen = {
                error: 0,
                success: recharges.length,
                refund: 0
            };

            const [idRecarga] = await this.db.querySequelize(
                `INSERT INTO recargas (total, fecha, notas, quien, proveedor, tipo, resumen)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                {
                    replacements: [
                        totalImporte,
                        fecha,
                        masterNote,
                        'mextic.app',
                        provider,
                        'paquete', // VOZ usa 'paquete'
                        JSON.stringify(resumen)
                    ],
                    type: this.db.getSequelizeClient().QueryTypes.INSERT,
                    transaction: transaction
                }
            );

            this.logger.info('Registro maestro VOZ insertado', {
                operation: 'master_record_inserted',
                serviceType,
                idRecarga,
                totalImporte,
                provider
            });

            // Insertar detalles uno por uno para capturar duplicados
            for (const recharge of recharges) {
                try {
                    const folio = recharge.webserviceResponse?.folio;
                    const sim = recharge.sim || recharge.record?.sim;

                    if (!folio || !sim) {
                        results.errors.push(recharge);
                        this.logger.error('Datos incompletos para inserción VOZ', {
                            sim: sim,
                            folio: folio,
                            hasWebserviceResponse: !!recharge.webserviceResponse
                        });
                        continue;
                    }

                    // Generar el detalle completo con información de la transacción VOZ
                    const webResponse = recharge.webserviceResponse;
                    const saldoFinal = webResponse?.saldoFinal || 'RECOVERY';
                    const carrier = webResponse?.carrier || 'Telcel';
                    const fechaRecarga = webResponse?.fecha || new Date().toISOString().slice(0, 19).replace('T', ' ');
                    const transID = webResponse?.transId || recharge.transId || '';
                    const monto = recharge.monto || 0;

                    // Para VOZ agregar información específica del paquete
                    const codigoPaquete = recharge.record?.codigo_paquete || 'N/A';
                    const descripcion = recharge.record?.descripcion || 'Recarga Automática';

                    const detalleText = `[ Saldo Final: ${saldoFinal} ] Folio: ${folio}, Cantidad: $${monto}, Teléfono: ${sim}, Carrier: ${carrier}, Fecha: ${fechaRecarga}, TransID: ${transID}, Paquete: ${codigoPaquete}, Servicio: ${descripcion}`;

                    // Formato vehículo para VOZ: usar descripción como vehículo
                    const vehiculoFormatted = descripcion;

                    // Insertar detalle DENTRO DE LA TRANSACCIÓN
                    await this.db.querySequelize(
                        `INSERT INTO detalle_recargas
                         (id_recarga, sim, importe, dispositivo, vehiculo, detalle, folio, status)
                         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
                        {
                            replacements: [
                                idRecarga,
                                sim,
                                monto,
                                sim, // VOZ usa sim como dispositivo
                                vehiculoFormatted,
                                detalleText,
                                folio
                            ],
                            type: this.db.getSequelizeClient().QueryTypes.INSERT,
                            transaction: transaction
                        }
                    );

                    results.inserted.push(recharge);

                    this.logger.debug('Detalle VOZ insertado exitosamente', {
                        sim: sim,
                        folio: folio,
                        monto: monto,
                        idRecarga: idRecarga
                    });

                } catch (error) {
                    // Detectar duplicado por índice único
                    if (error.name === 'SequelizeUniqueConstraintError' ||
                        (error.original && error.original.code === 'ER_DUP_ENTRY')) {
                        results.duplicates.push(recharge);
                        this.logger.info('Folio duplicado detectado VOZ - ya procesado anteriormente', {
                            sim: recharge.sim,
                            folio: recharge.webserviceResponse?.folio,
                            message: 'Tratando como exitoso - ya está en BD'
                        });
                    } else {
                        // 🔴 MODO PARANOICO: Error NO duplicado = FATAL - ROLLBACK
                        throw new Error(`Atomicidad violada VOZ: Error insertando detalle para SIM ${recharge.sim}: ${error.message}`);
                    }
                }
            }

            // Actualizar fechas de expiración VOZ usando datos del record
            this.logger.info('Actualizando fechas de expiración VOZ', {
                operation: 'updating_expiration_dates',
                count: results.inserted.length
            });

            for (const recharge of results.inserted) {
                const moment = require('moment-timezone');
                const diasVigencia = recharge.diasVigencia;
                // CRÍTICO: Usar endOf('day') para fijar al final del día
                const nuevaFechaExpiracion = moment().tz('America/Mazatlan').add(diasVigencia, 'days').endOf('day').unix();

                await this.db.querySequelize(
                    `UPDATE prepagos_automaticos SET fecha_expira_saldo = ? WHERE sim = ?`,
                    {
                        replacements: [nuevaFechaExpiracion, recharge.sim],
                        type: this.db.getSequelizeClient().QueryTypes.UPDATE,
                        transaction
                    }
                );

                this.logger.debug('Fecha expiración VOZ actualizada', {
                    sim: recharge.sim,
                    diasVigencia,
                    nuevaFecha: moment.unix(nuevaFechaExpiracion).tz('America/Mazatlan').format('YYYY-MM-DD HH:mm:ss')
                });
            }

            await transaction.commit();

            this.logger.info('Lote VOZ insertado exitosamente con manejo de duplicados', {
                operation: 'voz_batch_insert_with_duplicates_success',
                serviceType,
                totalRecargas,
                idRecarga,
                totalImporte,
                provider,
                inserted: results.inserted.length,
                duplicates: results.duplicates.length,
                errors: results.errors.length,
                isRecovery
            });

            // 🔐 LIMPIEZA SELECTIVA DE COLA AUXILIAR (solo si es recovery desde BaseRechargeProcessor)
            if (isRecovery && (results.inserted.length > 0 || results.duplicates.length > 0)) {
                this.logger.info('Iniciando limpieza selectiva cola auxiliar VOZ', {
                    operation: 'voz_selective_queue_cleanup_start',
                    insertados: results.inserted.length,
                    duplicados: results.duplicates.length,
                    errores: results.errors.length
                });

                // Validar que los elementos exitosos realmente existen en BD antes de limpiar
                const successfulItems = [...results.inserted, ...results.duplicates];
                const validatedItems = [];

                for (const item of successfulItems) {
                    const folio = item.webserviceResponse?.folio;
                    const sim = item.sim;

                    if (folio && sim) {
                        // Verificar que el folio existe en detalle_recargas antes de limpiar de cola
                        const exists = await this.checkFolioExists(folio, sim);
                        if (exists) {
                            validatedItems.push(item);
                            this.logger.info('VOZ item validado para limpieza de cola', {
                                operation: 'voz_queue_item_validated',
                                sim: sim,
                                folio: folio
                            });
                        } else {
                            this.logger.warn('VOZ item NO validado - mantener en cola', {
                                operation: 'voz_queue_item_not_validated',
                                sim: sim,
                                folio: folio,
                                reason: 'No encontrado en detalle_recargas'
                            });
                        }
                    }
                }

                // Solo limpiar elementos validados de la cola auxiliar
                if (validatedItems.length > 0) {
                    const cleanupResult = await this.cleanupAuxiliaryQueueSelective(validatedItems, 'voz');
                    this.logger.info('Limpieza selectiva VOZ completada', {
                        operation: 'voz_selective_queue_cleanup_completed',
                        elementosLimpiados: cleanupResult.cleaned.length,
                        elementosMantenidos: cleanupResult.kept.length,
                        totalOriginal: cleanupResult.originalTotal
                    });
                } else {
                    this.logger.warn('VOZ: Ningún elemento validado para limpieza - manteniendo cola intacta', {
                        operation: 'voz_no_validated_items_for_cleanup'
                    });
                }
            }

            return results;

        } catch (error) {
            if (transaction) await transaction.rollback();
            this.logger.error('Error insertando lote VOZ con manejo de duplicados', error, {
                operation: 'voz_batch_insert_with_duplicates_error',
                serviceType,
                totalRecargas: recharges.length,
                isRecovery
            });
            throw error;
        }
    }
}

module.exports = { VozRechargeProcessor };