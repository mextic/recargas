const moment = require('moment-timezone');
const { BaseRechargeProcessor } = require('./BaseRechargeProcessor');
const { WebserviceClient } = require('../webservices/WebserviceClient');
const { ProgressFactory } = require('../utils/progressBar');
const serviceConfig = require('../../config/services');
const performanceMonitor = require('../performance/PerformanceMonitor');
const { getPerformanceCache } = require('../database');
const { getEventBus } = require('../events/EventBus');
const { EventTypes, Services } = require('../events/EventTypes');

class GPSRechargeProcessor extends BaseRechargeProcessor {
    constructor(dbConnection, lockManager, persistenceQueue, alertManager = null, slaMonitor = null) {
        super(dbConnection, lockManager, persistenceQueue, serviceConfig.GPS);
        this.performanceCache = getPerformanceCache();
        this.alertManager = alertManager;
        this.slaMonitor = slaMonitor;

        // EventBus para sistema unificado de eventos
        this.eventBus = getEventBus();

        // Contadores para SLA monitoring
        this.operationStats = {
            totalRequests: 0,
            successfulRequests: 0,
            failedRequests: 0,
            totalResponseTime: 0
        };
    }

    getServiceType() {
        return 'gps';
    }

    getServiceConfig() {
        return this.config;
    }

    // ===== IMPLEMENTACIÓN ESPECÍFICA GPS =====
    async getRecordsToProcess() {
        // Preservar contexto this para usar dentro de measureDatabaseQuery
        const self = this;
        
        // Usar performance monitor para medir tiempo de consulta OPTIMIZADA
        return await performanceMonitor.measureDatabaseQuery(
            'gps_records_to_process_optimized',
            async () => {
                const fin_dia = moment.tz("America/Mazatlan").endOf("day").unix();
                const hoy = moment.tz("America/Mazatlan").format("YYYY-MM-DD");
                const dias_limite = self.config.DIAS_SIN_REPORTAR_LIMITE || 30;
                const minutos_sin_reportar = self.config.MINUTOS_SIN_REPORTAR_PARA_RECARGA || 10;

                // Obtener filtro de empresa antes de construir la consulta
                const companyFilter = typeof self.getCompanyFilter === 'function'
                    ? self.getCompanyFilter()
                    : '';

                // CONSULTA OPTIMIZADA: Todo en una sola query con JOIN
                const sql = `
            SELECT
                UCASE(v.descripcion) AS descripcion,
                UCASE(e.nombre) AS empresa,
                d.nombre AS dispositivo,
                d.sim AS sim,
                d.unix_saldo AS unix_saldo,
                v.status as vehiculo_estatus,
                -- EFICIENTE: Subconsulta ORDER BY + LIMIT 1 para último registro
                (
                    SELECT t.fecha
                    FROM track t
                    WHERE t.dispositivo = d.nombre
                    ORDER BY t.fecha DESC
                    LIMIT 1
                ) AS ultimo_registro,
                -- Calcular minutos sin reportar
                (
                    SELECT TRUNCATE((UNIX_TIMESTAMP() - t.fecha) / 60, 0)
                    FROM track t
                    WHERE t.dispositivo = d.nombre
                    ORDER BY t.fecha DESC
                    LIMIT 1
                ) AS minutos_sin_reportar,
                -- Calcular días sin reportar
                (
                    SELECT TRUNCATE((UNIX_TIMESTAMP() - t.fecha) / 60 / 60 / 24, 2)
                    FROM track t
                    WHERE t.dispositivo = d.nombre
                    ORDER BY t.fecha DESC
                    LIMIT 1
                ) AS dias_sin_reportar
            FROM vehiculos v
            JOIN empresas e ON v.empresa = e.id
            JOIN dispositivos d ON v.dispositivo = d.id
            WHERE d.prepago = 1
                AND v.status = 1  -- Vehículo en estado 'Activo'
                AND e.status = 1  -- Empresa en estado 'Activo'
                AND d.unix_saldo IS NOT NULL  -- Debe tener fecha de vencimiento
                -- Dispositivos vencidos o que vencen hoy
                AND (d.unix_saldo <= ${fin_dia})
                ${companyFilter}
                -- Filtros de exclusión
                AND (
                    e.nombre NOT LIKE '%stock%'
                    AND e.nombre NOT LIKE '%mextic los cabos%'
                    AND e.nombre NOT LIKE '%jesar%'
                    AND e.nombre NOT LIKE '%distribuidores%'
                    AND e.nombre NOT LIKE '%demo%'
                    AND e.nombre NOT LIKE '%_old%'
                    AND v.descripcion NOT LIKE '%_old%'
                    AND v.descripcion NOT LIKE '%demo%'
                )
                -- MEJORA: Sin recargas exitosas en los últimos 6 días (considerando vigencia de 7 días)
                AND NOT EXISTS (
                    SELECT 1
                    FROM detalle_recargas dr
                    JOIN recargas r ON dr.id_recarga = r.id
                    WHERE dr.sim = d.sim
                        AND dr.status = 1
                        AND r.tipo = 'rastreo'
                        -- Buscar recargas de los últimos 6 días en lugar de solo hoy
                        AND r.fecha >= UNIX_TIMESTAMP(DATE_SUB(CURDATE(), INTERVAL 6 DAY))
                )
            HAVING dias_sin_reportar <= ${dias_limite}
                AND vehiculo_estatus = 1
                -- MODIFICADO: Removido filtro minutos_sin_reportar para traer TODOS los vencidos/por vencer
            ORDER BY descripcion, v.descripcion
        `;

                self.logger.info('Ejecutando consulta GPS optimizada', {
                    operation: 'get_records_query_optimized',
                    serviceType: 'GPS',
                    variables: {
                        fin_dia,
                        hoy,
                        dias_limite,
                        minutos_sin_reportar,
                        dias_validacion_duplicados: 6,
                        optimizationType: 'efficient_subqueries_orderby_limit'
                    }
                });

                // Medir tiempo de ejecución de la consulta optimizada
                const queryStartTime = Date.now();
                const records = await self.executeWithRetry(
                    async () => await self.db.querySequelize(sql),
                    {
                        operationName: 'get_gps_records_optimized',
                        transactionId: `gps_query_${Date.now()}`
                    }
                );
                const queryTime = Date.now() - queryStartTime;

                // Log de performance de la consulta optimizada
                // console.log(`🚀 OPTIMIZACIÓN GPS - Consulta completada:`);
                // console.log(`   • Tiempo: ${queryTime}ms`);
                // console.log(`   • Estrategia: Subconsultas ORDER BY + LIMIT 1 (eficientes con millones de registros)`);
                // console.log(`   • Registros: ${records.length}`);
                // console.log(`   • Performance: ${queryTime < 3000 ? '✅ EXCELENTE' : queryTime < 10000 ? '⚠️ ACEPTABLE' : '❌ LENTA'} (${queryTime}ms)`);

                self.logger.info('Consulta GPS optimizada completada', {
                    operation: 'get_records_result',
                    recordCount: records.length,
                    queryType: 'single_optimized_query',
                    queryTimeMs: queryTime,
                    performanceImprovement: `${Math.round((1 - queryTime / 7500) * 100)}%`
                });

                if (records.length === 0) {
                    this.logger.warn('Sin registros GPS encontrados, ejecutando diagnóstico', {
                        operation: 'diagnostic_start',
                        serviceType: 'GPS'
                    });

                    try {
                        // Consulta simplificada para diagnóstico - solo contar registros base
                        const sqlDiagnostic = `
                    SELECT COUNT(*) as total,
                           SUM(CASE WHEN (unix_saldo <= ${fin_dia}) THEN 1 ELSE 0 END) as con_saldo_vencido,
                           SUM(CASE WHEN d.prepago = 1 THEN 1 ELSE 0 END) as prepago_activos
                    FROM vehiculos v
                    JOIN empresas e ON v.empresa = e.id
                    JOIN dispositivos d ON v.dispositivo = d.id
                    JOIN sucursales s ON v.sucursal = s.id
                    WHERE v.status = 1 AND e.status = 1 AND d.unix_saldo IS NOT NULL
                `;

                        const diagnostic = await this.executeWithRetry(
                            async () => await this.db.querySequelize(sqlDiagnostic),
                            {
                                operationName: 'gps_diagnostic_base',
                                transactionId: `diagnostic_${Date.now()}`
                            }
                        );

                        this.logger.info('Diagnóstico base GPS completado', {
                            operation: 'diagnostic_base',
                            totalActivos: diagnostic[0].total,
                            conSaldoVencido: diagnostic[0].con_saldo_vencido,
                            dispositivosPrepago: diagnostic[0].prepago_activos
                        });

                        // Verificar filtros de exclusión
                        const sqlExclusions = `
                    SELECT COUNT(*) as total_excluidos
                    FROM vehiculos v
                    JOIN empresas e ON v.empresa = e.id
                    JOIN dispositivos d ON v.dispositivo = d.id
                    WHERE v.status = 1 AND e.status = 1 AND d.prepago = 1
                    AND (
                        e.nombre LIKE '%stock%'
                        OR e.nombre LIKE '%mextic los cabos%'
                        OR e.nombre LIKE '%jesar%'
                        OR e.nombre LIKE '%distribuidores%'
                        OR e.nombre LIKE '%demo%'
                        OR e.nombre LIKE '%_old%'
                        OR v.descripcion LIKE '%_old%'
                        OR v.descripcion LIKE '%demo%'
                    )
                `;

                        const exclusions = await this.executeWithRetry(
                            async () => await this.db.querySequelize(sqlExclusions),
                            {
                                operationName: 'gps_diagnostic_exclusions',
                                transactionId: `exclusions_${Date.now()}`
                            }
                        );

                        this.logger.info('Diagnóstico de exclusiones GPS completado', {
                            operation: 'diagnostic_exclusions',
                            totalExcluidos: exclusions[0].total_excluidos
                        });

                    } catch (diagError) {
                        this.logger.error('Error en diagnóstico GPS', diagError, {
                            operation: 'diagnostic_error',
                            serviceType: 'GPS'
                        });
                    }
                }

                return records;
            }
        );
    }

    /**
     * Filtra registros GPS para separar los que requieren recarga vs los que están en ahorro
     * @param {Array} records - Registros obtenidos de getRecordsToProcess
     * @returns {Object} - { toRecharge: [], savings: [], metrics: {} }
     */
    async filterRecordsForRecharge(records) {
        const umbralMinutos = this.config.MINUTOS_SIN_REPORTAR_PARA_RECARGA; // GPS_MINUTOS_SIN_REPORTAR

        const toRecharge = [];
        const savings = [];
        let vencidos = 0, porVencer = 0;

        const ahora = Math.floor(Date.now() / 1000);
        const finDiaHoy = moment.tz("America/Mazatlan").endOf("day").unix();

        // Log detallado en modo TEST
        if (process.env.TEST_GPS === 'true') {
            console.log(`🔍 GPS FILTRADO DETALLADO:`);
            console.log(`   • Total registros recibidos: ${records.length}`);
            console.log(`   • Umbral minutos sin reportar: ${umbralMinutos}`);
            console.log(`   • Timestamp actual: ${ahora} (${moment.unix(ahora).tz('America/Mazatlan').format('YYYY-MM-DD HH:mm:ss')})`);
            console.log(`   • Fin día hoy: ${finDiaHoy} (${moment.unix(finDiaHoy).tz('America/Mazatlan').format('YYYY-MM-DD HH:mm:ss')})`);
        }

        records.forEach((record, index) => {
            const unixSaldo = parseInt(record.unix_saldo);
            const minutosSinReportar = parseFloat(record.minutos_sin_reportar || 0);

            // Clasificar por estado de saldo
            if (unixSaldo < ahora) {
                vencidos++;
            } else if (unixSaldo <= finDiaHoy) {
                porVencer++;
            }

            // Log detallado por registro en modo TEST
            if (process.env.TEST_GPS === 'true' && index < 5) { // Solo primeros 5 para no saturar
                const fechaSaldo = moment.unix(unixSaldo).tz('America/Mazatlan').format('YYYY-MM-DD HH:mm:ss');
                const estadoSaldo = unixSaldo < ahora ? 'VENCIDO' : (unixSaldo <= finDiaHoy ? 'POR_VENCER' : 'VIGENTE');
                console.log(`   📱 ${index + 1}: SIM ${record.sim} - ${estadoSaldo} (${fechaSaldo}) - ${minutosSinReportar} min sin reportar`);
            }

            // Decidir si recargar o es ahorro
            if (minutosSinReportar >= umbralMinutos) {
                toRecharge.push(record);
                if (process.env.TEST_GPS === 'true' && index < 5) {
                    console.log(`      ➡️  REQUIERE RECARGA (≥${umbralMinutos} min sin reportar)`);
                }
            } else {
                // AHORRO: Vencido/por vencer pero reportando en tiempo
                savings.push(record);
                if (process.env.TEST_GPS === 'true' && index < 5) {
                    console.log(`      💰 AHORRO DETECTADO (reportando recientemente: ${minutosSinReportar} min)`);
                }
            }
        });

        const metrics = {
            vencidos,
            porVencer,
            umbralMinutos,
            algorithm: 'GPS_MINUTOS_SIN_REPORTAR'
        };

        if (process.env.TEST_GPS === 'true') {
            console.log(`📊 RESULTADO FILTRADO GPS:`);
            console.log(`   • Para recargar: ${toRecharge.length}`);
            console.log(`   • Ahorro detectado: ${savings.length}`);
            console.log(`   • Vencidos: ${vencidos}`);
            console.log(`   • Por vencer: ${porVencer}`);
            if (records.length > 5) {
                console.log(`   • (Solo se mostraron primeros 5 de ${records.length} registros)`);
            }
        }

        this.logger.info('Filtrado GPS completado en BaseRechargeProcessor', {
            operation: 'gps_filtering_base_processor',
            totalEvaluados: records.length,
            vencidos,
            porVencer,
            toRecharge: toRecharge.length,
            savings: savings.length,
            umbralMinutos
        });

        return {
            toRecharge,
            savings,
            metrics
        };
    }

    /**
     * MÉTODO LEGACY: Mantener para compatibilidad con código existente en processRecords
     * Filtra dispositivos entre los que necesitan recarga y los que son ahorro
     * @param {Array} records - Registros obtenidos de la query (TODOS los vencidos/por vencer)
     * @returns {Object} - Datos de filtrado con paraRecargar, ahorroReportando, métricas
     */
    filterDevicesForRecharge(records) {
        const umbralMinutos = this.config.MINUTOS_SIN_REPORTAR_PARA_RECARGA; // GPS_MINUTOS_SIN_REPORTAR

        const paraRecargar = [];
        const ahorroReportando = [];
        let vencidos = 0, porVencer = 0;

        const ahora = Math.floor(Date.now() / 1000);
        const finDiaHoy = moment.tz("America/Mazatlan").endOf("day").unix();

        records.forEach(record => {
            const unixSaldo = parseInt(record.unix_saldo);
            const minutosSinReportar = parseFloat(record.minutos_sin_reportar || 0);

            // Clasificar por estado de saldo
            if (unixSaldo < ahora) {
                vencidos++;
            } else if (unixSaldo <= finDiaHoy) {
                porVencer++;
            }

            // Decidir si recargar o es ahorro
            if (minutosSinReportar >= umbralMinutos) {
                paraRecargar.push(record);
            } else {
                // AHORRO: Vencido/por vencer pero reportando en tiempo
                ahorroReportando.push(record);
            }
        });

        this.logger.info('Filtrado GPS post-query completado', {
            operation: 'gps_filtering_post_query',
            totalEvaluados: records.length,
            vencidos,
            porVencer,
            paraRecargar: paraRecargar.length,
            ahorroReportando: ahorroReportando.length,
            umbralMinutos
        });

        return {
            paraRecargar,
            ahorroReportando,
            vencidos,
            porVencer,
            totalEvaluados: records.length
        };
    }

    async processRecords(records, stats) {
        console.log('🔥 GPSRechargeProcessor.processRecords EJECUTÁNDOSE!', {
            recordsCount: records.length,
            currentStats: stats,
            serviceType: this.getServiceType()
        });

        this.logger.info('GPS procesamiento iniciado con registros pre-filtrados', {
            operation: 'gps_process_records_start_v3',
            serviceType: 'GPS',
            recordsReceived: records.length,
            flow: 'gps_with_filtered_records'
        });

        try {
            // PASO 1: Verificar y procesar cola auxiliar (OBLIGATORIO - paranoid-safe)
            const pendingItems = await this.checkPendingItems();

            if (pendingItems.length > 0) {
                console.warn(`⚠️ GPS: ${pendingItems.length} recargas pendientes en cola auxiliar`);

                // Procesar cola auxiliar primero
                const resolvedStats = await this.processAuxiliaryQueueRecharges();

                console.log(`📊 GPS: Procesamiento cola auxiliar:`, {
                    processed: resolvedStats.processed || 0,
                    duplicatesSkipped: resolvedStats.duplicatesSkipped || 0,
                    pendingInQueue: resolvedStats.pendingInQueue || 0,
                    errors: resolvedStats.failed || 0
                });

                // PASO 7.0 CRÍTICO: Verificar si cola quedó vacía
                const remainingItems = await this.checkPendingItems();

                if (remainingItems.length > 0) {
                    // Cola NO vacía - BLOQUEAR webservice
                    console.error(`❌ GPS: ${remainingItems.length} items pendientes en cola auxiliar`);
                    console.log('⛔ BLOQUEANDO consumo webservice hasta resolver cola auxiliar');

                    this.logger.error('GPS bloqueado por cola auxiliar no vacía (paso 7.0)', {
                        operation: 'gps_blocked_auxiliary_queue_step_7_0',
                        pendingItems: remainingItems.length,
                        processedInCycle: resolvedStats.processed || 0,
                        flowStep: '7.0_verification_failed'
                    });

                    stats.blocked = true;
                    stats.blockedReason = 'auxiliary_queue_not_empty_after_processing';
                    stats.pendingItems = remainingItems.length;

                    return stats; // TERMINAR AQUÍ - NO continuar a webservice
                }

                console.log('✅ GPS: Cola auxiliar completamente procesada y vacía (paso 7.0 OK)');

                // Actualizar stats con lo procesado en auxiliary
                stats.processed = resolvedStats.processed || 0;
                stats.success = (resolvedStats.processed || 0) - (resolvedStats.failed || 0);
                stats.failed = resolvedStats.failed || 0;
            }

            // PASO 8: PROCESAR REGISTROS YA FILTRADOS (los que vienen del BaseRechargeProcessor)
            if (!records || records.length === 0) {
                this.logger.info('GPS sin registros filtrados para procesar', {
                    operation: 'gps_no_filtered_records',
                    serviceType: 'GPS'
                });
                return stats;
            }

            console.log(`📡 GPS: Procesando ${records.length} registros filtrados vía webservice...`);

            this.logger.info('GPS iniciando procesamiento de webservice con registros filtrados', {
                operation: 'gps_starting_webservice_with_filtered_records',
                recordCount: records.length,
                serviceType: 'GPS'
            });

            // PASO 9: OBTENER PROVEEDORES ORDENADOS POR SALDO
            const providers = await this.getProvidersOrderedByBalance();
            let provider = providers[0];

            this.logger.info('Proveedor GPS seleccionado', {
                operation: 'provider_selected',
                serviceType: 'GPS',
                provider: provider.name,
                balance: provider.balance
            });

            console.log(`🏦 Proveedor seleccionado: ${provider.name} (Saldo: $${provider.balance})`);

            if (provider.balance < this.config.IMPORTE) {
                this.logger.error('Saldo insuficiente en proveedor GPS', {
                    operation: 'insufficient_balance',
                    serviceType: 'GPS',
                    provider: provider.name,
                    currentBalance: provider.balance,
                    requiredAmount: this.config.IMPORTE
                });
                console.error(`❌ Saldo insuficiente: $${provider.balance} < $${this.config.IMPORTE}`);
                return stats;
            }

            // PASO 10: PROCESAR CADA DISPOSITIVO
            for (let i = 0; i < records.length; i++) {
                const record = records[i];

                this.logger.info('Procesando dispositivo GPS', {
                    operation: 'process_device',
                    serviceType: 'GPS',
                    currentIndex: i + 1,
                    totalCount: records.length,
                    sim: record.sim,
                    descripcion: record.descripcion
                });

                // Información para logs
                const vehicleInfo = record.descripcion || record.dispositivo || 'N/A';
                const companyInfo = record.empresa || 'N/A';
                const minutosInfo = record.minutos_sin_reportar ? ` - ${record.minutos_sin_reportar} min sin reportar` : '';

                // En modo TEST, mostrar log detallado
                if (process.env.TEST_GPS === 'true') {
                    console.log(`     📱 ${i + 1}/${records.length} - ${record.sim} - ${vehicleInfo} [${companyInfo}]${minutosInfo}`);
                }

                try {
                    // PASO 11: EJECUTAR WEBSERVICE
                    const { WebserviceClient } = require('../webservices/WebserviceClient');

                    const rechargeResult = await this.executeWithRetry(
                        async () => await WebserviceClient.executeRecharge(provider, record.sim, this.config.CODIGO),
                        {
                            operationName: 'gps_webservice_recharge',
                            transactionId: `gps_${record.sim}_${Date.now()}`,
                            sim: record.sim,
                            alternateProviderCallback: async (attempt) => {
                                // Cambiar a siguiente proveedor si está disponible
                                if (attempt > 2 && providers.length > 1) {
                                    const alternateProvider = providers[1];
                                    this.logger.info('Cambiando a proveedor alternativo para GPS', {
                                        operation: 'switch_provider',
                                        from: provider.name,
                                        to: alternateProvider.name,
                                        sim: record.sim
                                    });
                                    provider = alternateProvider;
                                }
                            }
                        }
                    );

                    if (rechargeResult.success) {
                        // PASO 12: GUARDAR INMEDIATAMENTE EN COLA AUXILIAR
                        const auxItem = {
                            id: `aux_${Date.now()}_${Math.random()}`,
                            tipo: 'gps_recharge',
                            sim: record.sim,
                            transId: rechargeResult.transID,
                            monto: this.config.IMPORTE,
                            record: {
                                descripcion: record.descripcion,
                                empresa: record.empresa,
                                dispositivo: record.dispositivo,
                                sim: record.sim,
                                minutos_sin_reportar: record.minutos_sin_reportar || 0,
                                unix_saldo: record.unix_saldo
                            },
                            webserviceResponse: rechargeResult.response,
                            noteData: {
                                currentIndex: i + 1,
                                totalToRecharge: records.length,
                                totalRecords: records.length
                            },
                            provider: rechargeResult.provider,
                            status: 'webservice_success_pending_db',
                            timestamp: Date.now(),
                            addedAt: Date.now(),
                            tipoServicio: 'GPS',
                            diasVigencia: this.config.DIAS
                        };

                        // CRÍTICO: Guardar en cola auxiliar
                        await this.executeWithRetry(
                            async () => await this.persistenceQueue.addToAuxiliaryQueue(auxItem, 'gps'),
                            {
                                operationName: 'add_to_auxiliary_queue_critical',
                                transactionId: `aux_queue_${record.sim}_${Date.now()}`,
                                maxRetries: 5,
                                baseDelay: 500
                            }
                        );

                        this.logger.info('GPS webservice exitoso y guardado en cola auxiliar', {
                            operation: 'gps_webservice_and_queue_success',
                            sim: record.sim,
                            folio: rechargeResult.response?.folio || 'N/A',
                            transId: rechargeResult.transID
                        });

                        stats.processed++;
                        stats.success++;

                        if (process.env.TEST_GPS === 'true') {
                            console.log(`     ✅ ${record.sim}: Recarga exitosa - Folio: ${rechargeResult.response?.folio || 'N/A'}`);
                        }

                        // Pausa en modo TEST
                        if (process.env.TEST_GPS === 'true') {
                            await new Promise(resolve => setTimeout(resolve, 300));
                        }

                    } else {
                        // Error en webservice
                        if (process.env.TEST_GPS === 'true') {
                            console.log(`     ❌ Error en ${record.sim}: ${rechargeResult.error}`);
                        }

                        stats.failed++;
                        this.logger.error('Recarga GPS falló', {
                            operation: 'gps_recharge_failed',
                            serviceType: 'GPS',
                            sim: record.sim,
                            error: rechargeResult.error
                        });
                    }

                    // Delay entre llamadas
                    if (this.config.DELAY_BETWEEN_CALLS > 0 && i < records.length - 1) {
                        await this.delay(this.config.DELAY_BETWEEN_CALLS);
                    }

                } catch (error) {
                    // Excepción durante procesamiento
                    if (process.env.TEST_GPS === 'true') {
                        console.log(`     💥 Excepción en ${record.sim}: ${error.message}`);
                    }

                    stats.failed++;

                    this.logger.error('Error procesando dispositivo GPS', error, {
                        operation: 'process_device_error',
                        serviceType: 'GPS',
                        sim: record.sim,
                        currentIndex: i + 1
                    });
                }
            }

                // PASO 13: PROCESAR INMEDIATAMENTE LAS RECARGAS EXITOSAS
            if (stats.success > 0) {
                console.log(`📦 GPS: Procesando ${stats.success} recargas exitosas para inserción en BD...`);

                this.logger.info('Procesando recargas exitosas para inserción en BD', {
                    operation: 'process_successful_recharges',
                    serviceType: 'GPS',
                    successCount: stats.success
                });

                const insertionResult = await this.executeWithRetry(
                    async () => await this.processAuxiliaryQueueRecharges(),
                    {
                        operationName: 'process_current_cycle_queue',
                        transactionId: `current_cycle_${Date.now()}`
                    }
                );

                this.logger.info('Inserción en BD completada', {
                    operation: 'db_insertion_completed',
                    serviceType: 'GPS',
                    inserted: insertionResult.processed,
                    failed: insertionResult.failed
                });

                console.log(`✅ GPS: ${insertionResult.processed} recargas insertadas en BD`);
            }

            console.log(`🏁 GPS: Procesamiento completado - ${stats.success} exitosos, ${stats.failed} errores`);

        } catch (error) {
            this.logger.error('Error en processRecords GPS', {
                operation: 'process_records_error',
                error: error.message,
                stack: error.stack,
                flowVersion: '3.0_with_filtered_records'
            });
            stats.failed++;
        }

        return stats;
    }

    /**
                    ejemplos: ahorroReportando.slice(0, 3).map(d => ({
                        sim: d.sim,
                        vehiculo: d.descripcion,
                        minutosSinReportar: d.minutos_sin_reportar,
                        diasSinReportar: d.dias_sin_reportar,
                        estadoSaldo: parseInt(d.unix_saldo) < Math.floor(Date.now() / 1000) ? 'VENCIDO' : 'POR_VENCER'
                    }))
                });
            }

            // Crear barra de progreso ajustada
            const progressBar = ProgressFactory.createServiceProgressBar(
                'GPS',
                Math.max(totalEvaluados, 1),
                `Evaluados: ${totalEvaluados} | Recargar: ${paraRecargar.length} | Ahorro: ${ahorroReportando.length}`
            );

            if (totalEvaluados === 0) {
                progressBar.update(1, 'Sin dispositivos para evaluar - Sistema saludable');
                progressBar.complete('✅ Análisis completado - Todos los dispositivos están saludables');

                this.logger.info('Sin dispositivos GPS para evaluar', {
                    operation: 'no_records_to_evaluate',
                    serviceType: 'GPS',
                    possibleCauses: [
                        'Todos los dispositivos ya tienen recarga del día',
                        'No hay dispositivos con saldo vencido o por vencer',
                        'Filtros de exclusión eliminaron todos los registros',
                        `Dispositivos no cumplen límite de días sin reportar (${this.config.DIAS_SIN_REPORTAR_LIMITE} días)`
                    ]
                });
                return stats;
            }

            // ACTUALIZADO: Usar datos del filtrado post-query
            const registrosArecargar = paraRecargar; // Solo los que necesitan recarga
            const registrosVencenFinDiaReportando = ahorroReportando; // Los que son ahorro

            // Estadísticas mejoradas con filtrado post-query
            this.logger.info('Estadísticas GPS con filtrado post-query', {
                operation: 'gps_statistics_post_filter',
                serviceType: 'GPS',
                stats: {
                    totalEvaluados: totalEvaluados,
                    vencidos: vencidos,
                    porVencer: porVencer,
                    paraRecargar: paraRecargar.length,
                    ahorroReal: ahorroReportando.length,
                    umbralMinutos: this.config.MINUTOS_SIN_REPORTAR_PARA_RECARGA,
                    algoritmoVersion: 'v2.3_post_filter'
                }
            });

            // Estadísticas para evaluación
            const totalDispositivos = totalEvaluados;
            const porcentajeRecargar = 100; // Todos los registros ya vienen filtrados para recargar
            const porcentajePendientes = 0; // Ya no aplica
            const porcentajeEnTiempo = 0; // Ya no aplica

            this.logger.info('Indicadores de algoritmo GPS', {
                operation: 'gps_algorithm_indicators',
                serviceType: 'GPS',
                indicators: {
                    eficienciaRecarga: `${porcentajeRecargar}%`,
                    dispositivosEnGracia: `${porcentajePendientes}%`,
                    dispositivosEstables: `${porcentajeEnTiempo}%`
                }
            });

            // Análisis simplificado para query optimizada
            if (totalDispositivos > 0) {
                // console.log(`📊 ANÁLISIS GPS OPTIMIZADO:`);
                // console.log(`   • Dispositivos filtrados por query: ${totalDispositivos}`);
                // console.log(`   • Listos para recargar: ${registrosArecargar.length} (100%)`);
                // console.log(`   • Umbral aplicado: ≥${this.config.MINUTOS_SIN_REPORTAR_PARA_RECARGA} minutos sin reportar`);
                // console.log(`   • Validación anti-duplicados: últimos 6 días`);

                // Análisis de distribución simplificado usando datos ya calculados en query
                if (records.length > 0) {
                    const minutosPromedio = records.reduce((sum, r) => sum + parseFloat(r.minutos_sin_reportar || 0), 0) / records.length;
                    const diasPromedio = records.reduce((sum, r) => sum + parseFloat(r.dias_sin_reportar || 0), 0) / records.length;

                    console.log(`   • Promedio minutos sin reportar: ${minutosPromedio.toFixed(1)} min`);
                    console.log(`   • Promedio días sin reportar: ${diasPromedio.toFixed(1)} días`);
                }

                const ahora = moment.tz("America/Mazatlan");
                // console.log(`   • Optimización: Query unificada (N+1 → 1 query)`);
                // console.log(`   • Hora actual: ${ahora.format('HH:mm')} (Mazatlán)`);
            }

            if (registrosArecargar.length === 0) {
                if (totalDispositivos > 0) {
                    this.logger.info('Todos los dispositivos GPS en buen estado', {
                        operation: 'all_devices_healthy',
                        serviceType: 'GPS',
                        totalDispositivos
                    });
                }
                return stats;
            }

            // Actualizar barra de progreso con datos de filtrado
            progressBar.total = registrosArecargar.length;
            progressBar.update(0, `Procesando ${registrosArecargar.length} dispositivos filtrados`);

            if (progressBar.updateThreshold) {
                progressBar.updateThreshold = 200; // Actualizar máximo cada 200ms para menor overhead
            }

            // Obtener proveedores ordenados por saldo
            const providers = await this.getProvidersOrderedByBalance();
            let provider = providers[0]; // Cambio a let para poder modificar en alternate provider

            this.logger.info('Proveedor GPS seleccionado', {
                operation: 'provider_selected',
                serviceType: 'GPS',
                provider: provider.name,
                balance: provider.balance
            });

            progressBar.update(0, `Usando proveedor: ${provider.name} (Saldo: $${provider.balance})`);

            if (provider.balance < this.config.IMPORTE) {
                this.logger.error('Saldo insuficiente en proveedor GPS', {
                    operation: 'insufficient_balance',
                    serviceType: 'GPS',
                    provider: provider.name,
                    currentBalance: provider.balance,
                    requiredAmount: this.config.IMPORTE
                });
                progressBar.fail(`Saldo insuficiente: $${provider.balance} < $${this.config.IMPORTE}`);
                return stats;
            }

            // Procesar cada dispositivo
            for (let i = 0; i < registrosArecargar.length; i++) {
                const record = registrosArecargar[i];

                this.logger.info('Procesando dispositivo GPS', {
                    operation: 'process_device',
                    serviceType: 'GPS',
                    currentIndex: i + 1,
                    totalCount: registrosArecargar.length,
                    sim: record.sim,
                    descripcion: record.descripcion
                });

                // Actualizar progreso con información detallada del vehículo y empresa
                const vehicleInfo = record.descripcion || record.dispositivo || 'N/A';
                const companyInfo = record.empresa || 'N/A';
                const minutosInfo = record.minutos_sin_reportar ? ` - ${record.minutos_sin_reportar} min sin reportar` : '';
                const progressMessage = `GPS - Procesando: ${vehicleInfo} [${companyInfo}]${minutosInfo}`;
                progressBar.update(i, progressMessage);

                // En modo TEST, mostrar también un log detallado
                if (process.env.TEST_GPS === 'true') {
                    // console.log(`     📱 ${i + 1}/${registrosArecargar.length} - ${record.sim} - ${vehicleInfo} [${companyInfo}]`);
                }

                try {
                    // Usar WebserviceClient centralizado con error handling inteligente
                    const rechargeResult = await this.executeWithRetry(
                        async () => await WebserviceClient.executeRecharge(provider, record.sim, this.config.CODIGO),
                        {
                            operationName: 'gps_webservice_recharge',
                            transactionId: `gps_${record.sim}_${Date.now()}`,
                            sim: record.sim,
                            alternateProviderCallback: async (attempt) => {
                                // Cambiar a siguiente proveedor si está disponible
                                if (attempt > 2 && providers.length > 1) {
                                    const alternateProvider = providers[1];
                                    this.logger.info('Cambiando a proveedor alternativo para GPS', {
                                        operation: 'switch_provider',
                                        from: provider.name,
                                        to: alternateProvider.name,
                                        sim: record.sim
                                    });
                                    provider = alternateProvider;
                                }
                            }
                        }
                    );

                    if (rechargeResult.success) {
                        // CRÍTICO: Guardar INMEDIATAMENTE en cola auxiliar para prevenir pérdida de datos
                        let auxItem = null;
                        try {
                            auxItem = {
                                id: `aux_${Date.now()}_${Math.random()}`,
                                tipo: 'gps_recharge',
                                sim: record.sim,
                                transId: rechargeResult.transID,
                                monto: this.config.IMPORTE,
                                record: {
                                    descripcion: record.descripcion,
                                    empresa: record.empresa,
                                    dispositivo: record.dispositivo,
                                    sim: record.sim,
                                    minutos_sin_reportar: record.minutos_sin_reportar || 0,
                                    unix_saldo: record.unix_saldo  // NUEVO: preservar unix_saldo original
                                },
                                webserviceResponse: rechargeResult.response,
                                noteData: {
                                    currentIndex: i + 1,
                                    totalToRecharge: registrosArecargar.length,
                                    reportandoEnTiempo: ahorroReportando.length,
                                    totalRecords: totalEvaluados,
                                    ahorroInmediato: registrosVencenFinDiaReportando.length,
                                    totalCandidatos: totalEvaluados
                                },
                                provider: rechargeResult.provider,
                                status: 'webservice_success_pending_db',
                                timestamp: Date.now(),
                                addedAt: Date.now(),
                                tipoServicio: 'GPS',
                                diasVigencia: this.config.DIAS
                            };

                            // CRÍTICO: Guardar en cola auxiliar con máximo retry para prevenir pérdida
                            await this.executeWithRetry(
                                async () => await this.persistenceQueue.addToAuxiliaryQueue(auxItem, 'gps'),
                                {
                                    operationName: 'add_to_auxiliary_queue_critical',
                                    transactionId: `aux_queue_${record.sim}_${Date.now()}`,
                                    maxRetries: 5,  // Más intentos para operación crítica
                                    baseDelay: 500  // Menor delay para recuperación rápida
                                }
                            );

                            this.logger.info('GPS webservice exitoso y guardado en cola auxiliar', {
                                operation: 'gps_webservice_and_queue_success',
                                sim: record.sim,
                                folio: rechargeResult.response?.folio || 'N/A',
                                transId: rechargeResult.transID
                            });

                        } catch (queueError) {
                            // CRÍTICO: Si falla guardar en cola auxiliar, es pérdida de datos
                            this.logger.error('CRÍTICO: Webservice GPS exitoso pero falló guardar en cola auxiliar', queueError, {
                                operation: 'critical_data_loss_risk',
                                sim: record.sim,
                                transId: rechargeResult.transID,
                                folio: rechargeResult.response?.folio || 'N/A',
                                auxItem: JSON.stringify(auxItem)
                            });

                            // Enviar alerta crítica
                            if (this.alertManager) {
                                await this.alertManager.sendAlert({
                                    level: 'critical',
                                    title: 'PÉRDIDA DE DATOS GPS',
                                    message: `Webservice exitoso pero falló cola auxiliar. SIM: ${record.sim}, Folio: ${rechargeResult.response?.folio}`,
                                    service: 'GPS',
                                    metadata: { sim: record.sim, auxItem }
                                });
                            }

                            // Re-lanzar error para manejo apropiado
                            throw new Error(`CRÍTICO: Pérdida de datos GPS - SIM: ${record.sim}, Error cola: ${queueError.message}`);
                        }

                        // Actualizar progreso - éxito (con pausa para visibilidad)
                        const vehicleInfo = record.descripcion || record.dispositivo || 'N/A';
                        const companyInfo = record.empresa || 'N/A';
                        const minutosInfo = record.minutos_sin_reportar ? ` - ${record.minutos_sin_reportar} min` : '';
                        progressBar.update(i + 1, `GPS ✅ ${vehicleInfo} [${companyInfo}]${minutosInfo} - OK`);

                        // Pausa breve para visualizar el mensaje (solo en modo TEST para no ralentizar producción)
                        if (process.env.TEST_GPS === 'true' || process.env.TEST_VOZ === 'true' || process.env.TEST_ELIOT === 'true') {
                            await new Promise(resolve => setTimeout(resolve, 300)); // 300ms pausa
                        }

                        this.logger.info('GPS recargado exitosamente', {
                            operation: 'gps_recharge_success',
                            serviceType: 'GPS',
                            sim: record.sim,
                            dias: this.config.DIAS,
                            importe: this.config.IMPORTE,
                            provider: rechargeResult.provider
                        });
                    } else {
                        // Actualizar progreso - error (con detalles mejorados)
                        const vehicleInfo = record.descripcion || record.dispositivo || 'N/A';
                        const companyInfo = record.empresa || 'N/A';
                        const minutosInfo = record.minutos_sin_reportar ? ` - ${record.minutos_sin_reportar} min` : '';
                        const errorMessage = `GPS ❌ ${vehicleInfo} [${companyInfo}]${minutosInfo} - Error: ${rechargeResult.error?.slice(0, 30) || 'Error desconocido'}`;
                        progressBar.update(i + 1, errorMessage);

                        // En modo TEST, mostrar error detallado
                        if (process.env.TEST_GPS === 'true') {
                            console.log(`     ❌ Error en ${record.sim}: ${rechargeResult.error}`);
                        }

                        stats.failed++;
                        this.logger.error('Recarga GPS falló', {
                            operation: 'gps_recharge_failed',
                            serviceType: 'GPS',
                            sim: record.sim,
                            error: rechargeResult.error
                        });
                    }

                    // Delay entre llamadas (unificado)
                    if (this.config.DELAY_BETWEEN_CALLS > 0 && i < registrosArecargar.length - 1) {
                        await this.delay(this.config.DELAY_BETWEEN_CALLS);
                    }

                    // Mostrar progreso si está habilitado
                    if (this.config.SHOW_PROGRESS_BAR) {
                        const progressBar = this.generateProgressBar(i + 1, registrosArecargar.length);
                        this.logger.info('Progreso GPS', {
                            operation: 'progress_update',
                            serviceType: 'GPS',
                            progress: progressBar,
                            currentIndex: i + 1,
                            total: registrosArecargar.length
                        });
                    }

                } catch (error) {
                    // Actualizar progreso - excepción (con detalles del error)
                    const vehicleInfo = record.descripcion || record.dispositivo || 'N/A';
                    const companyInfo = record.empresa || 'N/A';
                    const minutosInfo = record.minutos_sin_reportar ? ` - ${record.minutos_sin_reportar} min` : '';
                    const exceptionMessage = `GPS 💥 ${vehicleInfo} [${companyInfo}]${minutosInfo} - Excepción: ${error.message?.slice(0, 20) || 'Error crítico'}`;
                    progressBar.update(i + 1, exceptionMessage);

                    // En modo TEST, mostrar excepción completa
                    if (process.env.TEST_GPS === 'true') {
                        console.log(`     💥 Excepción en ${record.sim}: ${error.message}`);
                    }

                    stats.failed++;
                    this.operationStats.failedRequests++;

                    this.logger.error('Error procesando dispositivo GPS', error, {
                        operation: 'process_device_error',
                        serviceType: 'GPS',
                        sim: record.sim,
                        currentIndex: i + 1
                    });

                    // Enviar alerta si hay demasiados errores consecutivos
                    await this.handleProcessingError(error, record, stats);

                    // Registrar error en SLA monitor
                    if (this.slaMonitor) {
                        this.slaMonitor.recordMetric('error', true, {
                            service: 'GPS',
                            error: error.message,
                            type: 'processing_error'
                        });
                    }
                }
            }

            // FLUJO MEJORADO: Procesar inmediatamente las recargas exitosas del ciclo actual
            if (stats.success > 0) {
                this.logger.info('Procesando recargas exitosas para inserción en BD', {
                    operation: 'process_successful_recharges',
                    serviceType: 'GPS',
                    successCount: stats.success
                });

                const insertionResult = await this.executeWithRetry(
                    async () => await this.processAuxiliaryQueueRecharges(),
                    {
                        operationName: 'process_current_cycle_queue',
                        transactionId: `current_cycle_${Date.now()}`
                    }
                );

                this.logger.info('Inserción en BD completada', {
                    operation: 'db_insertion_completed',
                    serviceType: 'GPS',
                    inserted: insertionResult.processed,
                    failed: insertionResult.failed
                });

                if (insertionResult.failed > 0) {
                    this.logger.warn('Recargas quedaron en cola auxiliar para recovery', {
                        operation: 'recharges_pending_recovery',
                        serviceType: 'GPS',
                        failedCount: insertionResult.failed
                    });
                }
            }

            // Completar la barra de progreso con resumen final
            const elapsedTime = Math.round((Date.now() - progressBar.startTime) / 1000);
            progressBar.complete(`✅ Completado: ${stats.success} exitosos, ${stats.failed} errores en ${elapsedTime > 60 ? Math.floor(elapsedTime / 60) + 'm ' + (elapsedTime % 60) + 's' : elapsedTime + 's'}`);

        } catch (error) {
            this.logger.error('Error en processRecords GPS', {
                operation: 'process_records_error',
                error: error.message,
                stack: error.stack,
                flowVersion: '2.0_con_paso_7_0'
            });
            stats.failed++;
        }

        return stats;
    }

    // ===== MÉTODOS WEBSERVICE (ahora delegados a WebserviceClient) =====
    async getTaecelBalance() {
        return await WebserviceClient.getTaecelBalance();
    }

    async getMstBalance() {
        return await WebserviceClient.getMstBalance();
    }

    // ===== LÓGICA DE FILTRADO ESPECÍFICA GPS =====

    // ===== MÉTODOS AUXILIARES GPS =====
    getCompanyFilter() {
        const testCompany = process.env.GPS_TEST_COMPANY;
        if (testCompany && testCompany.trim()) {
            console.log(`🧪 [TEST] Filtrando por empresa: ${testCompany}`);
            return `AND UPPER(e.nombre) LIKE UPPER('%${testCompany.trim()}%')`;
        }
        return '';
    }

    analyzeDistributionByDays(records) {
        const limiteMaximo = this.config.DIAS_SIN_REPORTAR_LIMITE; // Variable de entorno GPS_DIAS_SIN_REPORTAR

        // Rangos dinámicos basados en porcentajes del límite máximo
        const rango1 = Math.ceil(limiteMaximo * 0.10); // 10% del límite (ej: 1-2 días si límite=14)
        const rango2 = Math.ceil(limiteMaximo * 0.35); // 35% del límite (ej: 3-5 días si límite=14)
        const rango3 = Math.ceil(limiteMaximo * 0.70); // 70% del límite (ej: 6-10 días si límite=14)
        // rango4 = 71-100% del límite (ej: 11-14 días si límite=14)

        const distribution = {
            '0 días (reportando hoy)': 0,
            [`1-${rango1} días (10% - muy reciente)`]: 0,
            [`${rango1 + 1}-${rango2} días (35% - reciente)`]: 0,
            [`${rango2 + 1}-${rango3} días (70% - moderado)`]: 0,
            [`${rango3 + 1}-${limiteMaximo} días (100% - límite crítico)`]: 0
        };

        records.forEach(record => {
            const dias = parseFloat(record.dias_sin_reportar) || 0;

            if (dias === 0) {
                distribution['0 días (reportando hoy)']++;
            } else if (dias <= rango1) {
                distribution[`1-${rango1} días (10% - muy reciente)`]++;
            } else if (dias <= rango2) {
                distribution[`${rango1 + 1}-${rango2} días (35% - reciente)`]++;
            } else if (dias <= rango3) {
                distribution[`${rango2 + 1}-${rango3} días (70% - moderado)`]++;
            } else if (dias <= limiteMaximo) {
                distribution[`${rango3 + 1}-${limiteMaximo} días (100% - límite crítico)`]++;
            }
            // Nota: No puede haber > limiteMaximo por el HAVING en SQL
        });

        return distribution;
    }

    getTimeOfDayDescription(hour) {
        if (hour >= 6 && hour < 12) return "Mañana";
        if (hour >= 12 && hour < 18) return "Tarde";
        if (hour >= 18 && hour < 22) return "Noche";
        return "Madrugada";
    }

    // ===== PROCESAMIENTO INMEDIATO DEL CICLO ACTUAL =====
    async processCurrentCycleAuxiliaryQueue() {
        const stats = { processed: 0, failed: 0, success: 0 };
        const serviceType = this.getServiceType();

        try {
            const auxiliaryQueue = this.persistenceQueue.auxiliaryQueue;

            if (!auxiliaryQueue || auxiliaryQueue.length === 0) {
                return stats;
            }

            // Filtrar recargas del ciclo actual (webservice exitoso, pendiente BD)
            const currentCycleRecharges = auxiliaryQueue.filter(item =>
                item.tipo === `${serviceType}_recharge` &&
                item.status === 'webservice_success_pending_db'
            );

            if (currentCycleRecharges.length === 0) {
                return stats;
            }

            // console.log(`   🔄 Insertando ${currentCycleRecharges.length} recargas GPS del ciclo actual como LOTE...`);

            // NUEVA LÓGICA: 1 registro maestro + múltiples detalles
            let processedSims = new Set(); // Declarar fuera para uso posterior

            try {
                await this.insertBatchRecharges(currentCycleRecharges, false); // isRecovery=false (ciclo actual)
                // console.log(`   ✅ LOTE GPS: ${currentCycleRecharges.length} recargas insertadas en BD como un solo registro maestro`);

                // VALIDACIÓN CRÍTICA: Verificar que realmente se insertaron en BD
                // console.log(`   🔍 Verificando inserción real en BD...`);
                const { verified, notVerified } = await this.validateRechargesInDB(currentCycleRecharges);

                if (notVerified.length > 0) {
                    console.error(`   ❌ ALERTA GPS: ${notVerified.length}/${currentCycleRecharges.length} recargas NO verificadas en BD`);

                    // Log detallado de no verificadas
                    // console.log('   📋 Recargas NO verificadas:');
                    for (const item of notVerified) {
                        const folio = this.extractFolio(item);
                        const saldoInfo = await this.getSaldoInfo(item.sim, 'gps');
                        // console.log(`      - SIM: ${item.sim}, Folio: ${folio}, Saldo: ${saldoInfo}`);

                        // Marcar para reintento
                        item.status = 'db_verification_failed';
                        item.attempts = (item.attempts || 0) + 1;
                    }
                }

                // Solo marcar como procesadas las VERIFICADAS
                processedSims = new Set(verified);
                stats.processed = verified.length;
                stats.failed = notVerified.length;

                // console.log(`   📊 Resultado GPS: ${verified.length} verificadas, ${notVerified.length} falló verificación`);

            } catch (error) {
                stats.failed = currentCycleRecharges.length;
                console.error(`   ❌ Error insertando lote GPS: ${error.message}`);

                // Marcar todas como fallidas para recovery
                currentCycleRecharges.forEach(recharge => {
                    recharge.status = 'db_insertion_failed_pending_recovery';
                });
                processedSims = new Set(); // Ninguna procesada si falla
            }

            // Limpiar recargas exitosamente insertadas
            if (stats.processed > 0) {
                this.persistenceQueue.auxiliaryQueue = this.persistenceQueue.auxiliaryQueue.filter(item => {
                    if (item.tipo === `${serviceType}_recharge` && processedSims.has(item.sim)) {
                        return false; // Remover exitosos
                    }
                    return true; // Mantener los demás
                });

                await this.persistenceQueue.saveAuxiliaryQueue();
                // console.log(`   🧹 ${processedSims.size} recargas GPS removidas de cola auxiliar`);
            }

        } catch (error) {
            console.error(`   ❌ Error procesando ciclo actual GPS: ${error.message}`);
        }

        return stats;
    }

    // ===== INSERCIÓN POR LOTES GPS (1 MAESTRO + N DETALLES) =====
    async insertBatchRecharges(recharges, isRecovery = false) {
        let transaction = null;

        try {
            transaction = await this.db.getSequelizeClient().transaction();

            const fecha = Math.floor(Date.now() / 1000);
            const totalRecargas = recharges.length;
            const totalImporte = recharges.reduce((sum, r) => sum + (r.importe || this.config.IMPORTE), 0);

            // Extraer estadísticas del primer registro para la nota
            const firstRecharge = recharges[0];
            const noteData = firstRecharge.noteData || {};
            const ahorroReportando = noteData.reportandoEnTiempo || 0;
            const totalRecords = noteData.totalRecords || totalRecargas;

            // Preparar datos de analytics para nota optimizada
            const filterResults = {
                ahorroReportando: Array(ahorroReportando).fill({}),
                vencidos: Math.floor(totalRecords * 0.8), // Estimación para compatibilidad
                porVencer: Math.floor(totalRecords * 0.2),
                totalEvaluados: totalRecords
            };
            const processStats = {
                processed: totalRecargas,
                success: totalRecargas,
                failed: 0
            };

            const analyticsData = this.prepareAnalyticsData(filterResults, processStats, totalRecords);

            // Generar nota maestra optimizada con KPIs
            let masterNote = this.generateOptimizedMasterNote(analyticsData);

            // CRÍTICO: Agregar prefijo de recuperación si es recovery
            if (isRecovery) {
                masterNote = `< RECUPERACIÓN GPS > ${masterNote}`;
                this.logger.info('Aplicando prefijo de recuperación a nota maestra', {
                    operation: 'recovery_prefix_applied',
                    serviceType: 'GPS',
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
                        recharges[0]?.provider || 'TAECEL',
                        'rastreo', // GPS usa 'rastreo'
                        JSON.stringify(resumen)
                    ],
                    type: this.db.getSequelizeClient().QueryTypes.INSERT,
                    transaction
                }
            );

            // Guardar analytics de la recarga en BD DENTRO de la transacción
            await this.saveGPSAnalytics(idRecarga, analyticsData, transaction);

            // 2. INSERTAR MÚLTIPLES DETALLES LIGADOS AL MAESTRO
            this.logger.info('Iniciando inserción de detalles en detalle_recargas', {
                operation: 'inserting_detalle_recargas',
                serviceType: 'GPS',
                batchSize: recharges.length,
                isRecovery: isRecovery,
                idRecarga: idRecarga
            });

            for (let i = 0; i < recharges.length; i++) {
                const recharge = recharges[i];
                const webserviceData = recharge.webserviceResponse || {};

                // Extraer datos del webservice
                const saldoFinal = webserviceData.saldoFinal || '$0.00';
                const folio = webserviceData.folio || '';
                const telefono = recharge.sim;
                const carrier = 'Telcel';
                const fechaRecarga = moment.tz("America/Mazatlan").format('YYYY-MM-DD HH:mm:ss');
                const transID = recharge.transId || webserviceData.transId || '';
                // CORRECCIÓN: timeout e ip están en webserviceData.response (según estructura en cola auxiliar)
                const timeout = webserviceData.response?.timeout || webserviceData.timeout || '0.00';
                const ip = webserviceData.response?.ip || webserviceData.ip || '0.0.0.0';

                // NUEVO: Agregar minutos sin reportar al detalle
                const minutosSinReportar = recharge.record?.minutos_sin_reportar || 'N/A';

                const detalleText = `[ Saldo Final: ${saldoFinal} ] Folio: ${folio}, Cantidad: $${recharge.importe || this.config.IMPORTE}, Teléfono: ${telefono}, Carrier: ${carrier}, Fecha: ${fechaRecarga}, TransID: ${transID}, Timeout: ${timeout}, IP: ${ip}, Sin Reportar: ${minutosSinReportar} min`;

                this.logger.info(`Insertando detalle ${i + 1}/${recharges.length}`, {
                    operation: 'inserting_single_detalle',
                    sim: recharge.sim,
                    folio: folio,
                    transID: transID,
                    isRecovery: isRecovery
                });

                // Insertar detalle ligado al maestro con manejo de duplicados
                try {
                    await this.db.querySequelize(
                        `INSERT INTO detalle_recargas (id_recarga, sim, importe, dispositivo, vehiculo, detalle, folio, status)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                        {
                            replacements: [
                                idRecarga,                                    // Ligado al registro maestro
                                recharge.sim,
                                recharge.importe || this.config.IMPORTE,
                                recharge.record.dispositivo || '',
                                `${recharge.record.descripcion} [${recharge.record.empresa}]`, // Formato: "VEHÍCULO [EMPRESA]"
                                detalleText,
                                folio || transID || null,                   // Usar folio, transID o null
                                1
                            ],
                            type: this.db.getSequelizeClient().QueryTypes.INSERT,
                            transaction
                        }
                    );

                    // Marcar como insertado exitosamente
                    recharge.insertionStatus = 'inserted';

                    // Marcar en cola auxiliar como insertado si es recovery
                    if (isRecovery && this.persistenceQueue) {
                        await this.persistenceQueue.markItemAsInserted(null, recharge.sim);
                    }

                    this.logger.info(`Detalle insertado exitosamente`, {
                        operation: 'detalle_inserted_success',
                        sim: recharge.sim,
                        folio: folio,
                        idRecarga: idRecarga
                    });

                } catch (insertError) {
                    // Verificar si es error de duplicado
                    if (this.isDuplicateError(insertError)) {
                        // Error de duplicado = La recarga ya existe = Considerar como éxito
                        recharge.insertionStatus = 'duplicate';

                        // Marcar en cola auxiliar como duplicado si es recovery
                        if (isRecovery && this.persistenceQueue) {
                            await this.persistenceQueue.markItemAsDuplicate(null, recharge.sim);
                        }

                        this.logger.info(`Detalle ya existe (duplicado detectado)`, {
                            operation: 'detalle_duplicate_detected',
                            sim: recharge.sim,
                            folio: folio,
                            error: insertError.message,
                            isRecovery: isRecovery
                        });

                        console.log(`   ✓ Duplicado detectado: SIM ${recharge.sim}, Folio ${folio} - Ya existe en BD`);

                    } else {
                        // Error real - propagar
                        recharge.insertionStatus = 'failed';

                        // Marcar en cola auxiliar como fallido si es recovery
                        if (isRecovery && this.persistenceQueue) {
                            await this.persistenceQueue.markItemAsFailed(null, recharge.sim, insertError);
                        }

                        this.logger.error(`Error real insertando detalle`, insertError, {
                            operation: 'detalle_insertion_real_error',
                            sim: recharge.sim,
                            folio: folio,
                            idRecarga: idRecarga
                        });
                        throw insertError;
                    }
                }

                // 3. ACTUALIZAR unix_saldo EN DISPOSITIVOS (+DIAS días) - AL FINAL DEL DÍA
                const nuevaFechaExpiracion = moment.tz("America/Mazatlan").add(this.config.DIAS, 'days').endOf('day').unix();

                await this.db.querySequelize(
                    `UPDATE dispositivos SET unix_saldo = ? WHERE sim = ?`,
                    {
                        replacements: [nuevaFechaExpiracion, recharge.sim],
                        type: this.db.getSequelizeClient().QueryTypes.UPDATE,
                        transaction
                    }
                );
            }

            await transaction.commit();

        } catch (error) {
            if (transaction) await transaction.rollback();
            throw error;
        }
    }

}

module.exports = { GPSRechargeProcessor };
