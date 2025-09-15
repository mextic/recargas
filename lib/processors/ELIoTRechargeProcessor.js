const moment = require('moment-timezone');
const { BaseRechargeProcessor } = require('./BaseRechargeProcessor');
const { WebserviceClient } = require('../webservices/WebserviceClient');
const { ProgressFactory } = require('../utils/progressBar');
const { connectMongoDB } = require('../database/mongoClient');
const { consultarMetricaPorUuid, ensureIndexMetricas } = require('../models/Metrica');
const serviceConfig = require('../../config/services');

class ELIoTRechargeProcessor extends BaseRechargeProcessor {
    constructor(dbConnections, lockManager, persistenceQueue) {
        super(dbConnections.GPS_DB, lockManager, persistenceQueue, serviceConfig.ELIOT);
        
        // ELIoT necesita ambas conexiones
        this.dbEliot = dbConnections.ELIOT_DB; // Para consultar datos
        // this.db ya apunta a GPS_DB para insertar recargas (heredado de BaseRechargeProcessor)
    }

    getServiceType() {
        return 'ELIoT';
    }

    getServiceConfig() {
        return this.config;
    }


    // ===== IMPLEMENTACIÓN ESPECÍFICA ELIoT =====
    async getRecordsToProcess() {
        // Conectar MongoDB y asegurar índices
        await connectMongoDB();
        await ensureIndexMetricas();

        const fecha_limite = moment().add(1, 'days').endOf('day').unix();
        
        const sql = `
            SELECT 
                descripcion,
                nombreEmpresa,
                uuid,
                sim,
                fecha_saldo,
                dias_saldo,
                importe_recarga,
                dias_recarga
            FROM agentesEmpresa_view
            WHERE 
                prepago = 1 AND
                status = 1 AND
                estadoEmpresa = 1 AND
                fecha_saldo IS NOT NULL AND
                comunicacion = 'gsm' AND (
                    nombreEmpresa NOT LIKE '%stock%' AND
                    nombreEmpresa NOT LIKE '%MEXTICOM%' AND
                    nombreEmpresa NOT LIKE '%mextic los cabos%' AND
                    nombreEmpresa NOT LIKE '%jesar%' AND
                    nombreEmpresa NOT LIKE '%distribuidores%' AND
                    nombreEmpresa NOT LIKE '%demo%' AND
                    nombreEmpresa NOT LIKE '%_old%' AND
                    descripcion NOT LIKE '%_old%' AND
                    descripcion NOT LIKE '%demo%'
                ) AND
                importe_recarga > 0 AND
                dias_saldo <= 0
            ORDER BY nombreEmpresa, descripcion
        `;

        this.logger.info('Ejecutando consulta ELIoT', {
            operation: 'get_eliot_records_query',
            serviceType: 'ELIoT',
            variables: { fecha_limite }
        });

        const candidateRecords = await this.executeWithRetry(
            async () => await this.dbEliot.querySequelize(sql),
            {
                operationName: 'get_eliot_candidate_records',
                transactionId: `eliot_query_${Date.now()}`
            }
        );
        
        this.logger.info('Consulta inicial ELIoT completada', {
            operation: 'get_eliot_records_result',
            candidateCount: candidateRecords.length
        });
        
        // Filtrar usando métricas MongoDB - mismo criterio que en script previo
        const validRecords = [];
        const limiteMaximo = this.config.DIAS_SIN_REPORTAR_LIMITE; // Variable ELIOT_DIAS_SIN_REPORTAR
        const minutosMinimos = this.config.MINUTOS_SIN_REPORTAR_PARA_RECARGA; // Variable ELIOT_MINUTOS_SIN_REPORTAR

        this.logger.info('Iniciando filtrado por métricas MongoDB', {
            operation: 'mongodb_metrics_filter_start',
            serviceType: 'ELIoT',
            diasLimite: limiteMaximo,
            minutosMinimos: minutosMinimos
        });

        for (const registro of candidateRecords) {
            try {
                // Consultar última métrica por UUID
                let ultimoRegistro = await consultarMetricaPorUuid(registro.uuid);
                
                if (ultimoRegistro) {
                    // Calcular días sin reportar desde última métrica
                    let dias = moment().diff(moment(ultimoRegistro.fecha * 1000), "days");
                    
                    if (dias > limiteMaximo) {
                        this.logger.warn('Dispositivo ELIoT excluido por días límite', {
                            operation: 'device_excluded_days_limit',
                            serviceType: 'ELIoT',
                            descripcion: registro.descripcion,
                            empresa: registro.nombreEmpresa,
                            diasSinReportar: dias,
                            limiteMaximo
                        });
                        // Registros muy antiguos se excluyen como en tu script
                        continue;
                    } else {
                        // Calcular minutos sin reportar
                        let minutos = moment().diff(moment(ultimoRegistro.fecha * 1000), "minutes");
                        
                        if (minutos >= minutosMinimos) {
                            this.logger.info('Dispositivo ELIoT válido para recarga', {
                                operation: 'device_valid_for_recharge',
                                serviceType: 'ELIoT',
                                descripcion: registro.descripcion,
                                empresa: registro.nombreEmpresa,
                                diasSinReportar: dias,
                                minutosSinReportar: minutos
                            });
                            validRecords.push({
                                ...registro,
                                empresa: registro.nombreEmpresa,
                                importe: registro.importe_recarga
                            });
                        } else {
                            this.logger.debug('Dispositivo ELIoT excluido por minutos mínimos', {
                                operation: 'device_excluded_minutes_limit',
                                serviceType: 'ELIoT',
                                descripcion: registro.descripcion,
                                empresa: registro.nombreEmpresa,
                                minutosSinReportar: minutos,
                                minutosMinimos
                            });
                        }
                    }
                } else {
                    // Sin métricas - asumir que necesita recarga
                    this.logger.info('Dispositivo ELIoT sin métricas - válido para recarga', {
                        operation: 'device_no_metrics_valid',
                        serviceType: 'ELIoT',
                        descripcion: registro.descripcion,
                        empresa: registro.nombreEmpresa
                    });
                    validRecords.push({
                        ...registro,
                        empresa: registro.nombreEmpresa,
                        importe: registro.importe_recarga
                    });
                }
                
            } catch (error) {
                this.logger.error('Error procesando métrica ELIoT', error, {
                    operation: 'metrics_processing_error',
                    serviceType: 'ELIoT',
                    uuid: registro.uuid,
                    descripcion: registro.descripcion
                });
                // En caso de error, incluir el registro para no perder recargas
                validRecords.push({
                    ...registro,
                    empresa: registro.nombreEmpresa,
                    importe: registro.importe_recarga
                });
            }
        }

        this.logger.info('Filtrado por métricas completado', {
            operation: 'mongodb_metrics_filter_completed',
            serviceType: 'ELIoT',
            validRecords: validRecords.length,
            candidateRecords: candidateRecords.length,
            filteredOut: candidateRecords.length - validRecords.length
        });
        
        return validRecords;
    }

    async processRecords(records, stats) {
        this.logger.info('Iniciando procesamiento de registros ELIoT', {
            operation: 'process_eliot_records_start',
            serviceType: 'ELIoT',
            recordCount: records.length
        });

        if (records.length === 0) {
            this.logger.info('Sin dispositivos ELIoT para procesar', {
                operation: 'no_eliot_records_to_process',
                serviceType: 'ELIoT'
            });
            return stats;
        }
        
        // Asegurar que config está disponible
        const config = this.getServiceConfig();

        // Todos los registros de ELIoT que cumplan la consulta se recargan
        const registrosArecargar = records;

        this.logger.info('Estadísticas ELIoT detalladas', {
            operation: 'eliot_detailed_statistics',
            serviceType: 'ELIoT',
            totalRegistros: records.length,
            paraRecargar: registrosArecargar.length
        });

        if (registrosArecargar.length === 0) {
            this.logger.info('Sin dispositivos ELIoT para recargar en este ciclo', {
                operation: 'no_eliot_devices_to_recharge',
                serviceType: 'ELIoT'
            });
            return stats;
        }

        // Seleccionar proveedor con más saldo
        const providers = await this.getProvidersOrderedByBalance();
        const provider = providers[0]; // Usar el de mayor saldo
        if (!provider || provider.balance < this.config.MIN_BALANCE_THRESHOLD) {
            this.logger.error('Sin proveedor con saldo suficiente para ELIoT', {
                operation: 'insufficient_provider_balance',
                serviceType: 'ELIoT',
                requiredThreshold: this.config.MIN_BALANCE_THRESHOLD,
                providerBalance: provider?.balance || 0
            });
            return stats;
        }

        this.logger.info('Proveedor ELIoT seleccionado', {
            operation: 'eliot_provider_selected',
            serviceType: 'ELIoT',
            provider: provider.name,
            balance: provider.balance
        });

        // Crear barra de progreso visual para ELIoT (optimizada)
        const progressBar = ProgressFactory.createServiceProgressBar(
            'ELIOT', 
            registrosArecargar.length, 
            `Procesando ${registrosArecargar.length} dispositivos ELIoT`
        );
        progressBar.updateThreshold = 200; // Actualizar máximo cada 200ms para menor overhead

        progressBar.update(0, `Usando proveedor: ${provider.name} (Saldo: $${provider.balance})`);

        // Procesar cada dispositivo ELIoT
        for (let i = 0; i < registrosArecargar.length; i++) {
            const record = registrosArecargar[i];

            try {
                // Obtener configuración según importe_recarga
                const rechargeConfig = this.getRechargeConfig(record.importe_recarga);
                if (!rechargeConfig) {
                    progressBar.update(i + 1, `❌ ${record.sim} - Importe inválido`);
                    
                    this.logger.warn('Importe ELIoT no válido', {
                        operation: 'invalid_eliot_amount',
                        serviceType: 'ELIoT',
                        sim: record.sim,
                        importeRecarga: record.importe_recarga
                    });
                    stats.failed++;
                    continue;
                }

                // Actualizar progreso con información detallada
                progressBar.update(i, `🔍 ELIoT ${record.sim} - ${record.descripcion || 'Dispositivo'} ($${record.importe_recarga})`);

                this.logger.info('Procesando dispositivo ELIoT', {
                    operation: 'process_eliot_device',
                    serviceType: 'ELIoT',
                    currentIndex: i + 1,
                    totalCount: registrosArecargar.length,
                    sim: record.sim,
                    descripcion: record.descripcion,
                    importeRecarga: record.importe_recarga,
                    diasRecarga: record.dias_recarga
                });

                // Verificar saldo suficiente
                if (provider.balance < record.importe_recarga) {
                    this.logger.error('Saldo insuficiente para dispositivo ELIoT', {
                        operation: 'insufficient_balance_for_device',
                        serviceType: 'ELIoT',
                        sim: record.sim,
                        providerBalance: provider.balance,
                        requiredAmount: record.importe_recarga
                    });
                    break;
                }

                // Ejecutar recarga con WebserviceClient usando error handling inteligente
                const rechargeResult = await this.executeWithRetry(
                    async () => await WebserviceClient.executeRecharge(provider, record.sim, rechargeConfig.codigo),
                    {
                        operationName: 'eliot_webservice_recharge',
                        transactionId: `eliot_${record.sim}_${Date.now()}`,
                        sim: record.sim,
                        importeRecarga: record.importe_recarga
                    }
                );

                stats.processed++;

                if (rechargeResult.success) {
                    // Agregar a cola auxiliar para inserción inmediata
                    const auxItem = {
                        tipo: 'ELIoT_recharge',
                        status: 'webservice_success_pending_db',
                        sim: record.sim,
                        provider: provider.name,
                        webserviceResponse: rechargeResult.response,
                        record: {
                            descripcion: record.descripcion,
                            empresa: record.nombreEmpresa,
                            dispositivo: record.uuid,
                            sim: record.sim
                        },
                        transId: rechargeResult.response?.TransID || rechargeResult.response?.transID,
                        noteData: {
                            currentIndex: i + 1,
                            totalToRecharge: registrosArecargar.length,
                            totalRecords: records.length
                        },
                        addedAt: Date.now(),
                        tipoServicio: 'ELIoT',
                        diasVigencia: record.dias_recarga,
                        importe: record.importe_recarga
                    };

                    await this.executeWithRetry(
                        async () => await this.persistenceQueue.addToAuxiliaryQueue(auxItem),
                        {
                            operationName: 'add_eliot_to_auxiliary_queue',
                            transactionId: `eliot_aux_${record.sim}_${Date.now()}`
                        }
                    );

                    stats.success++;

                    // Actualizar progreso - éxito (optimizado)
                    progressBar.update(i + 1, `✅ ${record.sim} - OK`);

                    this.logger.info('ELIoT recargado exitosamente', {
                        operation: 'eliot_recharge_success',
                        serviceType: 'ELIoT',
                        sim: record.sim,
                        diasRecarga: record.dias_recarga,
                        importeRecarga: record.importe_recarga,
                        provider: provider.name
                    });
                } else {
                    // Actualizar progreso - error (optimizado)
                    progressBar.update(i + 1, `❌ ${record.sim} - Error`);

                    stats.failed++;
                    this.logger.error('Recarga ELIoT falló', {
                        operation: 'eliot_recharge_failed',
                        serviceType: 'ELIoT',
                        sim: record.sim,
                        error: rechargeResult.error,
                        importeRecarga: record.importe_recarga
                    });
                }

                // Delay entre llamadas
                if (this.config.DELAY_BETWEEN_CALLS > 0 && i < registrosArecargar.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, this.config.DELAY_BETWEEN_CALLS));
                }

            } catch (error) {
                // Actualizar progreso - excepción (optimizado)
                progressBar.update(i + 1, `💥 ${record.sim} - Excepción`);

                stats.failed++;
                this.logger.error('Error procesando dispositivo ELIoT', error, {
                    operation: 'process_eliot_device_error',
                    serviceType: 'ELIoT',
                    sim: record.sim,
                    currentIndex: i + 1
                });
            }
        }

        // FLUJO MEJORADO: Procesar inmediatamente las recargas exitosas del ciclo actual
        if (stats.success > 0) {
            this.logger.info('Procesando recargas ELIoT exitosas para inserción en BD', {
                operation: 'process_eliot_successful_recharges',
                serviceType: 'ELIoT',
                successCount: stats.success
            });

            const insertionResult = await this.executeWithRetry(
                async () => await this.processCurrentCycleAuxiliaryQueue(),
                {
                    operationName: 'process_eliot_current_cycle_queue',
                    transactionId: `eliot_current_cycle_${Date.now()}`
                }
            );

            this.logger.info('Inserción ELIoT en BD completada', {
                operation: 'eliot_db_insertion_completed',
                serviceType: 'ELIoT',
                inserted: insertionResult.processed,
                failed: insertionResult.failed
            });

            if (insertionResult.failed > 0) {
                this.logger.warn('Recargas ELIoT quedaron en cola auxiliar para recovery', {
                    operation: 'eliot_recharges_pending_recovery',
                    serviceType: 'ELIoT',
                    failedCount: insertionResult.failed
                });
            }
        }

        return stats;
    }

    // ===== CONFIGURACIÓN DE PRODUCTOS ELIoT =====
    getRechargeConfig(importe_recarga) {
        const importesValidos = {
            10: { codigo: "TEL010", dias: 7 },
            20: { codigo: "TEL020", dias: 10 },
            30: { codigo: "TEL030", dias: 15 },
            50: { codigo: "TEL050", dias: 30 },
            80: { codigo: "TEL080", dias: 30 },
            150: { codigo: "TEL050", dias: 60 },
            200: { codigo: "TEL200", dias: 60 },
            300: { codigo: "TEL300", dias: 60 },
            500: { codigo: "TEL500", dias: 60 },
            150005: { codigo: "PSL150", dias: 25 },
            200005: { codigo: "PSL200", dias: 30 },
            10006: { codigo: "TIL010", dias: 0 },
            15: { codigo: "TIL030", dias: 0 },
        };

        return importesValidos[importe_recarga] || null;
    }

    // ===== PROCESAMIENTO INMEDIATO DEL CICLO ACTUAL =====
    async processCurrentCycleAuxiliaryQueue() {
        const stats = { processed: 0, failed: 0 };
        const serviceType = this.getServiceType();

        try {
            const auxiliaryQueue = this.persistenceQueue.auxiliaryQueue;

            if (!auxiliaryQueue || auxiliaryQueue.length === 0) {
                return stats;
            }

            // Filtrar recargas ELIoT del ciclo actual
            const currentCycleRecharges = auxiliaryQueue.filter(item =>
                item.tipo === `${serviceType}_recharge` &&
                item.status === 'webservice_success_pending_db'
            );

            if (currentCycleRecharges.length === 0) {
                return stats;
            }

            this.logger.info('Procesando lote ELIoT del ciclo actual', {
                operation: 'process_eliot_batch_current_cycle',
                serviceType: 'ELIoT',
                batchSize: currentCycleRecharges.length
            });

            // NUEVA LÓGICA: 1 registro maestro + múltiples detalles
            try {
                await this.executeWithRetry(
                    async () => await this.insertBatchRecharges(currentCycleRecharges),
                    {
                        operationName: 'insert_eliot_batch_recharges',
                        transactionId: `eliot_batch_current_${Date.now()}`,
                        batchSize: currentCycleRecharges.length
                    }
                );
                
                stats.processed = currentCycleRecharges.length;
                
                this.logger.info('Lote ELIoT insertado exitosamente', {
                    operation: 'eliot_batch_insert_success',
                    serviceType: 'ELIoT',
                    processed: currentCycleRecharges.length
                });

                // Limpiar todas las recargas exitosas
                const processedSims = new Set(currentCycleRecharges.map(r => r.sim));
                this.persistenceQueue.auxiliaryQueue = this.persistenceQueue.auxiliaryQueue.filter(item => {
                    if (item.tipo === `${serviceType}_recharge` && processedSims.has(item.sim)) {
                        return false; // Remover exitosos
                    }
                    return true; // Mantener los demás
                });

                await this.executeWithRetry(
                    async () => await this.persistenceQueue.saveAuxiliaryQueue(),
                    {
                        operationName: 'save_eliot_auxiliary_queue_cleanup',
                        transactionId: `eliot_cleanup_${Date.now()}`
                    }
                );
                
                this.logger.info('Cola auxiliar ELIoT limpiada', {
                    operation: 'eliot_auxiliary_queue_cleaned',
                    serviceType: 'ELIoT',
                    removedCount: processedSims.size
                });

            } catch (error) {
                stats.failed = currentCycleRecharges.length;
                this.logger.error('Error insertando lote ELIoT', error, {
                    operation: 'eliot_batch_insert_error',
                    serviceType: 'ELIoT',
                    batchSize: currentCycleRecharges.length
                });
                
                // Marcar todas como fallidas para recovery
                currentCycleRecharges.forEach(recharge => {
                    recharge.status = 'db_insertion_failed_pending_recovery';
                });
            }

        } catch (error) {
            this.logger.error('Error procesando ciclo actual ELIoT', error, {
                operation: 'eliot_current_cycle_error',
                serviceType: 'ELIoT'
            });
        }

        return stats;
    }

    // ===== INSERCIÓN POR LOTES ELIoT (1 MAESTRO + N DETALLES) =====
    async insertBatchRecharges(recharges) {
        let transaction = null;

        try {
            transaction = await this.db.getSequelizeClient().transaction();

            const fecha = Math.floor(Date.now() / 1000);
            const totalRecargas = recharges.length;
            const totalImporte = recharges.reduce((sum, r) => sum + (r.importe || 0), 0);

            // Nota del registro maestro con formato correcto
            const masterNote = `[ ${String(totalRecargas).padStart(3, '0')} / ${String(totalRecargas).padStart(3, '0')} ] Recarga Automática: ELIoT`;

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
                        recharges[0]?.provider || 'TAECEL',
                        'eliot', // ELIoT usa 'eliot'
                        JSON.stringify(resumen)
                    ],
                    type: this.db.getSequelizeClient().QueryTypes.INSERT,
                    transaction
                }
            );

            // 2. INSERTAR MÚLTIPLES DETALLES LIGADOS AL MAESTRO
            for (let i = 0; i < recharges.length; i++) {
                const recharge = recharges[i];
                const webserviceData = recharge.webserviceResponse || {};
                
                // Extraer datos del webservice
                const saldoFinal = webserviceData.saldoFinal || webserviceData['Saldo Final'] || '$0.00';
                const folio = webserviceData.folio || webserviceData.Folio || '';
                const telefono = recharge.sim;
                const carrier = webserviceData.Carrier || 'Telcel';
                const fechaRecarga = moment.tz("America/Mazatlan").format('YYYY-MM-DD HH:mm:ss');
                const transID = recharge.transId || webserviceData.transID || webserviceData.TransID || '';
                // CORRECCIÓN: timeout e ip están anidados en response.response (como en VOZ)
                const timeout = webserviceData.response?.timeout || webserviceData.timeout || webserviceData.Timeout || '0.00';
                const ip = webserviceData.response?.ip || webserviceData.ip || webserviceData.IP || '0.0.0.0';
                const nota = webserviceData.Nota || '';

                let detalleText = `[ Saldo Final: ${saldoFinal} ] Empresa: ${recharge.record.empresa} > Folio: ${folio}, Cantidad: $${recharge.importe}, Teléfono: ${telefono}, Carrier: ${carrier}, Fecha: ${fechaRecarga}, TransID: ${transID}, Timeout: ${timeout}, IP: ${ip}`;
                
                if (nota && nota !== '') {
                    detalleText += `, Nota: ${nota}`;
                }

                // Insertar detalle ligado al maestro
                await this.db.querySequelize(
                    `INSERT INTO detalle_recargas (id_recarga, sim, importe, dispositivo, vehiculo, detalle, folio, status)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    {
                        replacements: [
                            idRecarga,                                    // Ligado al registro maestro
                            recharge.sim,
                            recharge.importe || 50,
                            recharge.record.dispositivo,
                            `${recharge.record.descripcion} [${recharge.record.empresa}]`, // Formato: "VEHÍCULO [EMPRESA]"
                            detalleText,
                            folio || transID || null,                   // Usar folio, transID o null
                            1
                        ],
                        type: this.db.getSequelizeClient().QueryTypes.INSERT,
                        transaction
                    }
                );

                // 3. ACTUALIZAR fecha_saldo EN TABLA AGENTES (ELIOT_DB)
                const fechaExpiracion = moment.tz('America/Mazatlan')
                    .endOf('day')
                    .add(recharge.diasVigencia, 'days')
                    .unix();

                await this.dbEliot.querySequelize(
                    `UPDATE agentes SET fecha_saldo = ? WHERE sim = ?`,
                    {
                        replacements: [fechaExpiracion, recharge.sim],
                        type: this.dbEliot.getSequelizeClient().QueryTypes.UPDATE
                    }
                );
            }

            await transaction.commit();

        } catch (error) {
            if (transaction) await transaction.rollback();
            throw error;
        }
    }

    // ===== INSERCIÓN NORMAL ELIoT (SIN RECUPERACIÓN) =====
    async insertNormalRecharge(recharge) {
        let transaction = null;

        try {
            transaction = await this.db.getSequelizeClient().transaction();

            const fecha = Math.floor(Date.now() / 1000);

            // Nota NORMAL - SIN prefijo "< RECUPERACIÓN >"
            const { currentIndex = 1, totalToRecharge = 1, totalRecords = 1 } = recharge.noteData || {};
            const normalNote = `[ ${String(currentIndex).padStart(3, '0')} / ${String(totalToRecharge).padStart(3, '0')} ] Recarga Automática: ELIoT`;

            const resumen = { error: 0, success: 1, refund: 0 };

            // Insertar en recargas
            const [idRecarga] = await this.db.querySequelize(
                `INSERT INTO recargas (total, fecha, notas, quien, proveedor, tipo, resumen)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                {
                    replacements: [
                        recharge.importe || 50,
                        fecha,
                        normalNote,
                        'mextic.app',
                        recharge.provider || 'TAECEL',
                        'eliot', // ELIoT usa 'eliot'
                        JSON.stringify(resumen)
                    ],
                    type: this.db.getSequelizeClient().QueryTypes.INSERT,
                    transaction
                }
            );

            // Insertar en detalle_recargas con formato ELIoT
            const webserviceData = recharge.webserviceResponse || {};
            const saldoFinal = webserviceData.saldoFinal || webserviceData['Saldo Final'] || '$0.00';
            const folio = webserviceData.folio || webserviceData.Folio || '';
            const telefono = recharge.sim;
            const carrier = webserviceData.Carrier || 'Telcel';
            const fechaRecarga = moment.tz("America/Mazatlan").format('YYYY-MM-DD HH:mm:ss');
            const transID = recharge.transId || webserviceData.transID || webserviceData.TransID || '';
            const timeout = webserviceData.timeout || webserviceData.Timeout || '0.00';
            const ip = webserviceData.ip || webserviceData.IP || '0.0.0.0';
            const nota = webserviceData.Nota || '';

            let detalleText = `[ Saldo Final: ${saldoFinal} ] Empresa: ${recharge.record.empresa} > Folio: ${folio}, Cantidad: $${recharge.importe}, Teléfono: ${telefono}, Carrier: ${carrier}, Fecha: ${fechaRecarga}, TransID: ${transID}, Timeout: ${timeout}, IP: ${ip}`;
            
            if (nota && nota !== '') {
                detalleText += `, Nota: ${nota}`;
            }

            await this.db.querySequelize(
                `INSERT INTO detalle_recargas (id_recarga, sim, importe, dispositivo, vehiculo, detalle, folio, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                {
                    replacements: [
                        idRecarga,
                        recharge.sim,
                        recharge.importe || 50,
                        recharge.record.dispositivo,
                        `${recharge.record.descripcion} [${recharge.record.empresa}]`, // Formato: "VEHÍCULO [EMPRESA]"
                        detalleText,
                        folio || transID, // Usar folio o transID como respaldo
                        1
                    ],
                    type: this.db.getSequelizeClient().QueryTypes.INSERT,
                    transaction
                }
            );

            // Actualizar fecha_saldo en tabla agentes (ELIOT_DB)
            const fechaExpiracion = moment.tz('America/Mazatlan')
                .endOf('day')
                .add(recharge.diasVigencia, 'days')
                .unix();

            await this.dbEliot.querySequelize(
                `UPDATE agentes SET fecha_saldo = ? WHERE sim = ?`,
                {
                    replacements: [fechaExpiracion, recharge.sim],
                    type: this.dbEliot.getSequelizeClient().QueryTypes.UPDATE
                }
            );

            await transaction.commit();

        } catch (error) {
            if (transaction) await transaction.rollback();
            throw error;
        }
    }

    // ===== RECOVERY POR LOTES ELIoT (1 MAESTRO + N DETALLES CON PREFIJO) =====
    async insertBatchRecoveryRecharges(recharges) {
        let transaction = null;

        try {
            transaction = await this.db.getSequelizeClient().transaction();

            const fecha = Math.floor(Date.now() / 1000);
            const totalRecargas = recharges.length;
            const totalImporte = recharges.reduce((sum, r) => sum + (r.importe || 0), 0);

            // Nota del registro maestro RECOVERY con formato correcto
            const recoveryMasterNote = `< RECUPERACIÓN ELIoT > [ ${String(totalRecargas).padStart(3, '0')} / ${String(totalRecargas).padStart(3, '0')} ] Recarga Automática: ELIoT`;

            const resumen = { 
                error: 0, 
                success: totalRecargas, 
                refund: 0 
            };

            // 1. INSERTAR REGISTRO MAESTRO RECOVERY EN RECARGAS
            const [idRecarga] = await this.db.querySequelize(
                `INSERT INTO recargas (total, fecha, notas, quien, proveedor, tipo, resumen)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                {
                    replacements: [
                        totalImporte,
                        fecha,
                        recoveryMasterNote,
                        'mextic.app',
                        recharges[0]?.provider || 'TAECEL',
                        'eliot',
                        JSON.stringify(resumen)
                    ],
                    type: this.db.getSequelizeClient().QueryTypes.INSERT,
                    transaction
                }
            );

            // 2. INSERTAR MÚLTIPLES DETALLES RECOVERY LIGADOS AL MAESTRO
            for (let i = 0; i < recharges.length; i++) {
                const recharge = recharges[i];
                
                // Buscar datos del registro si no están completos
                let record = recharge.record;
                if (!record || !record.descripcion) {
                    record = await this.getRecordDataForRecovery(recharge);
                }
                
                const webserviceData = recharge.webserviceResponse || {};
                
                // Extraer datos del webservice
                const saldoFinal = webserviceData.saldoFinal || webserviceData['Saldo Final'] || '$0.00';
                const folio = webserviceData.folio || webserviceData.Folio || '';
                const telefono = recharge.sim;
                const carrier = webserviceData.Carrier || 'Telcel';
                const fechaRecarga = moment.tz("America/Mazatlan").format('YYYY-MM-DD HH:mm:ss');
                const transID = recharge.transId || webserviceData.transID || webserviceData.TransID || '';
                // CORRECCIÓN: timeout e ip están anidados en response.response (como en VOZ)
                const timeout = webserviceData.response?.timeout || webserviceData.timeout || webserviceData.Timeout || '0.00';
                const ip = webserviceData.response?.ip || webserviceData.ip || webserviceData.IP || '0.0.0.0';
                const nota = webserviceData.Nota || '';

                let detalleText = `[ Saldo Final: ${saldoFinal} ] Empresa: ${record.empresa} > Folio: ${folio}, Cantidad: $${recharge.importe}, Teléfono: ${telefono}, Carrier: ${carrier}, Fecha: ${fechaRecarga}, TransID: ${transID}, Timeout: ${timeout}, IP: ${ip}`;
                
                if (nota && nota !== '') {
                    detalleText += `, Nota: ${nota}`;
                }

                // Insertar detalle recovery ligado al maestro
                await this.db.querySequelize(
                    `INSERT INTO detalle_recargas (id_recarga, sim, importe, dispositivo, vehiculo, detalle, folio, status)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    {
                        replacements: [
                            idRecarga,                                    // Ligado al registro maestro
                            recharge.sim,
                            recharge.importe || 50,
                            record.dispositivo,
                            `${record.descripcion} [${record.empresa}]`,
                            detalleText,
                            folio || transID || null,
                            1
                        ],
                        type: this.db.getSequelizeClient().QueryTypes.INSERT,
                        transaction
                    }
                );

                // 3. ACTUALIZAR fecha_saldo EN TABLA AGENTES (ELIOT_DB)
                const fechaExpiracion = moment.tz('America/Mazatlan')
                    .endOf('day')
                    .add(recharge.diasVigencia, 'days')
                    .unix();

                await this.dbEliot.querySequelize(
                    `UPDATE agentes SET fecha_saldo = ? WHERE sim = ?`,
                    {
                        replacements: [fechaExpiracion, recharge.sim],
                        type: this.dbEliot.getSequelizeClient().QueryTypes.UPDATE
                    }
                );
            }

            await transaction.commit();
            this.logger.info('Lote recovery ELIoT insertado exitosamente', {
                operation: 'eliot_batch_recovery_insert_success',
                serviceType: 'ELIoT',
                totalRecargas,
                totalImporte
            });

        } catch (error) {
            if (transaction) await transaction.rollback();
            throw error;
        }
    }

    // ===== RECOVERY ESPECÍFICO ELIoT =====
    async processCompletePendingRecharge(recharge) {
        let transaction = null;

        try {
            transaction = await this.db.getSequelizeClient().transaction();

            // Buscar datos del registro si no están completos
            let record = recharge.record;
            if (!record || !record.descripcion) {
                record = await this.getRecordDataForRecovery(recharge);
            }

            const fecha = Math.floor(Date.now() / 1000);

            // Nota para recovery ELIoT
            const { currentIndex = 1, totalToRecharge = 1, totalRecords = 1 } = recharge.noteData || {};
            const recoveryNote = `< RECUPERACIÓN ELIoT > [ ${String(currentIndex).padStart(3, '0')} / ${String(totalToRecharge).padStart(3, '0')} ] Recarga Automática: ELIoT`;

            const resumen = { error: 0, success: 1, refund: 0 };

            // Insertar en recargas
            const [idRecarga] = await this.db.querySequelize(
                `INSERT INTO recargas (total, fecha, notas, quien, proveedor, tipo, resumen)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                {
                    replacements: [
                        recharge.importe || 50,
                        fecha,
                        recoveryNote,
                        'mextic.app',
                        recharge.provider || 'TAECEL',
                        'eliot',
                        JSON.stringify(resumen)
                    ],
                    type: this.db.getSequelizeClient().QueryTypes.INSERT,
                    transaction
                }
            );

            // Insertar en detalle_recargas con formato ELIoT (recovery)
            const webserviceData = recharge.webserviceResponse || {};
            const saldoFinal = webserviceData.saldoFinal || webserviceData['Saldo Final'] || '$0.00';
            const folio = webserviceData.folio || webserviceData.Folio || '';
            const telefono = recharge.sim;
            const carrier = webserviceData.Carrier || 'Telcel';
            const fechaRecarga = moment.tz("America/Mazatlan").format('YYYY-MM-DD HH:mm:ss');
            const transID = recharge.transId || webserviceData.transID || webserviceData.TransID || '';
            const timeout = webserviceData.timeout || webserviceData.Timeout || '0.00';
            const ip = webserviceData.ip || webserviceData.IP || '0.0.0.0';
            const nota = webserviceData.Nota || '';

            let detalleText = `[ Saldo Final: ${saldoFinal} ] Empresa: ${record.empresa} > Folio: ${folio}, Cantidad: $${recharge.importe}, Teléfono: ${telefono}, Carrier: ${carrier}, Fecha: ${fechaRecarga}, TransID: ${transID}, Timeout: ${timeout}, IP: ${ip}`;
            
            if (nota && nota !== '') {
                detalleText += `, Nota: ${nota}`;
            }

            await this.db.querySequelize(
                `INSERT INTO detalle_recargas (id_recarga, sim, importe, dispositivo, vehiculo, detalle, folio, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                {
                    replacements: [
                        idRecarga,
                        recharge.sim,
                        recharge.importe || 50,
                        record.dispositivo,
                        `${record.descripcion} [${record.empresa}]`,
                        detalleText,
                        folio || transID,
                        1
                    ],
                    type: this.db.getSequelizeClient().QueryTypes.INSERT,
                    transaction
                }
            );

            // Actualizar fecha_saldo en tabla agentes (ELIOT_DB)
            const fechaExpiracion = moment.tz('America/Mazatlan')
                .endOf('day')
                .add(recharge.diasVigencia, 'days')
                .unix();

            await this.dbEliot.querySequelize(
                `UPDATE agentes SET fecha_saldo = ? WHERE sim = ?`,
                {
                    replacements: [fechaExpiracion, recharge.sim],
                    type: this.dbEliot.getSequelizeClient().QueryTypes.UPDATE
                }
            );

            await transaction.commit();
            this.logger.info('ELIoT recovery insertado en BD exitosamente', {
                operation: 'eliot_recovery_db_insert_success',
                serviceType: 'ELIoT',
                sim: recharge.sim,
                diasVigencia: recharge.diasVigencia,
                importe: recharge.importe
            });

        } catch (error) {
            if (transaction) await transaction.rollback();
            throw error;
        }
    }

    async getRecordDataForRecovery(recharge) {
        // Obtener datos del dispositivo ELIoT para recovery
        const deviceData = await this.dbEliot.querySequelize(
            `SELECT descripcion, nombreEmpresa, uuid, sim
             FROM agentesEmpresa_view
             WHERE sim = ? AND prepago = 1`,
            {
                replacements: [recharge.sim],
                type: this.dbEliot.getSequelizeClient().QueryTypes.SELECT
            }
        );

        return deviceData.length > 0 ? {
            descripcion: deviceData[0].descripcion,
            empresa: deviceData[0].nombreEmpresa,
            dispositivo: deviceData[0].uuid,
            sim: deviceData[0].sim
        } : {
            descripcion: 'DISPOSITIVO_UNKNOWN',
            empresa: 'EMPRESA_UNKNOWN',
            dispositivo: recharge.sim,
            sim: recharge.sim
        };
    }
}

module.exports = { ELIoTRechargeProcessor };
