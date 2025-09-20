const moment = require('moment-timezone');
const { BaseRechargeProcessor } = require('./BaseRechargeProcessor');
const { WebserviceClient } = require('../webservices/WebserviceClient');
const { ProgressFactory } = require('../utils/progressBar');
const serviceConfig = require('../../config/services');
const performanceMonitor = require('../performance/PerformanceMonitor');
const { getPerformanceCache } = require('../database');

class GPSRechargeProcessor extends BaseRechargeProcessor {
    constructor(dbConnection, lockManager, persistenceQueue, alertManager = null, slaMonitor = null) {
        super(dbConnection, lockManager, persistenceQueue, serviceConfig.GPS);
        this.performanceCache = getPerformanceCache();
        this.alertManager = alertManager;
        this.slaMonitor = slaMonitor;

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
        // Usar performance monitor para medir tiempo de consulta OPTIMIZADA
        return await performanceMonitor.measureDatabaseQuery(
            'gps_records_to_process_optimized',
            async () => {
                const fin_dia = moment.tz("America/Mazatlan").endOf("day").unix();
                const hoy = moment.tz("America/Mazatlan").format("YYYY-MM-DD");
                const dias_limite = this.config.DIAS_SIN_REPORTAR_LIMITE || 30;
                const minutos_sin_reportar = this.config.MINUTOS_SIN_REPORTAR_PARA_RECARGA || 10;

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
                ${this.getCompanyFilter()}
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

        this.logger.info('Ejecutando consulta GPS optimizada', {
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
        const records = await this.executeWithRetry(
            async () => await this.db.querySequelize(sql),
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

        this.logger.info('Consulta GPS optimizada completada', {
            operation: 'get_records_result',
            recordCount: records.length,
            queryType: 'single_optimized_query',
            queryTimeMs: queryTime,
            performanceImprovement: `${Math.round((1 - queryTime/7500) * 100)}%`
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
        this.logger.info('Iniciando procesamiento GPS con flujo correcto', {
            operation: 'process_records_start_v2',
            serviceType: 'GPS',
            initialRecordCount: records.length,
            flowVersion: '2.0_con_paso_7_0'
        });

        try {
            // PASO 1-2: Verificar y procesar cola auxiliar
            const pendingItems = await this.checkPendingItems();

            if (pendingItems.length > 0) {
                console.warn(`⚠️ GPS: ${pendingItems.length} recargas pendientes en cola auxiliar`);

                // PASOS 3-6: Procesar cola (INSERT, VALIDATE, CLEANUP)
                const resolvedStats = await this.processCurrentCycleAuxiliaryQueue();

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
            }

            // PASO 7.1 ELIMINADO: No volver a consultar BD después de procesar cola auxiliar
            // Esto causaba duplicaciones al procesar los mismos dispositivos dos veces
            this.logger.info('Cola auxiliar procesada - finalizando sin consulta adicional', {
                operation: 'auxiliary_queue_processed_complete',
                flowStep: 'skip_fresh_query_to_prevent_duplicates'
            });
            return stats;

            // PASO 8: Filtrar y procesar webservice
            const filteredData = this.filterDevicesForRecharge(freshRecords);
            const { paraRecargar, ahorroReportando, vencidos, porVencer, totalEvaluados } = filteredData;

            if (paraRecargar.length === 0) {
                this.logger.info('Sin dispositivos para recargar tras filtrado', {
                    operation: 'no_devices_after_filtering',
                    totalEvaluados: freshRecords.length,
                    ahorro: ahorroReportando.length,
                    flowStep: '8_no_recharge_candidates'
                });
                return stats;
            }

            console.log(`📡 GPS: Procesando ${paraRecargar.length} recargas vía webservice (paso 8)...`);

            // Continuar con el procesamiento de webservice (existente)
            // IMPORTANTE: Este código usará isRecovery=false porque son recargas nuevas

            // Log de ahorro real detectado
        if (ahorroReportando.length > 0) {
            this.logger.info('Dispositivos GPS con AHORRO REAL detectado', {
                operation: 'ahorro_real_detected',
                totalAhorro: ahorroReportando.length,
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

                    stats.processed++;
                    stats.success++;

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
                async () => await this.processCurrentCycleAuxiliaryQueue(),
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
            progressBar.complete(`✅ Completado: ${stats.success} exitosos, ${stats.failed} errores en ${elapsedTime > 60 ? Math.floor(elapsedTime/60) + 'm ' + (elapsedTime%60) + 's' : elapsedTime + 's'}`);

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
            [`${rango1+1}-${rango2} días (35% - reciente)`]: 0,
            [`${rango2+1}-${rango3} días (70% - moderado)`]: 0,
            [`${rango3+1}-${limiteMaximo} días (100% - límite crítico)`]: 0
        };

        records.forEach(record => {
            const dias = parseFloat(record.dias_sin_reportar) || 0;

            if (dias === 0) {
                distribution['0 días (reportando hoy)']++;
            } else if (dias <= rango1) {
                distribution[`1-${rango1} días (10% - muy reciente)`]++;
            } else if (dias <= rango2) {
                distribution[`${rango1+1}-${rango2} días (35% - reciente)`]++;
            } else if (dias <= rango3) {
                distribution[`${rango2+1}-${rango3} días (70% - moderado)`]++;
            } else if (dias <= limiteMaximo) {
                distribution[`${rango3+1}-${limiteMaximo} días (100% - límite crítico)`]++;
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

    // ===== INSERCIÓN NORMAL (SIN RECUPERACIÓN) =====
    async insertNormalRecharge(recharge) {
        let transaction = null;

        try {
            transaction = await this.db.getSequelizeClient().transaction();

            const fecha = Math.floor(Date.now() / 1000);

            // Nota NORMAL optimizada con analytics
            const { ahorroInmediato = 0, totalCandidatos = 1 } = recharge.noteData || {};
            const normalNote = this.generateOptimizedDetailNote(recharge, ahorroInmediato, totalCandidatos);

            const resumen = { error: 0, success: 1, refund: 0 };

            // Insertar en recargas
            const [idRecarga] = await this.db.querySequelize(
                `INSERT INTO recargas (total, fecha, notas, quien, proveedor, tipo, resumen)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                {
                    replacements: [
                        this.config.IMPORTE,
                        fecha,
                        normalNote,
                        'mextic.app',
                        recharge.provider || 'TAECEL',
                        'rastreo', // GPS usa 'rastreo', VOZ usa 'paquete'
                        JSON.stringify(resumen)
                    ],
                    type: this.db.getSequelizeClient().QueryTypes.INSERT,
                    transaction
                }
            );

            // Insertar en detalle_recargas con formato original
            const webserviceData = recharge.webserviceResponse || {};
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

            const detalleText = `[ Saldo Final: ${saldoFinal} ] Folio: ${folio}, Cantidad: $${this.config.IMPORTE}, Teléfono: ${telefono}, Carrier: ${carrier}, Fecha: ${fechaRecarga}, TransID: ${transID}, Timeout: ${timeout}, IP: ${ip}, Sin Reportar: ${minutosSinReportar} min`;

            await this.db.querySequelize(
                `INSERT INTO detalle_recargas (id_recarga, sim, importe, dispositivo, vehiculo, detalle, folio, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                {
                    replacements: [
                        idRecarga,
                        recharge.sim,
                        this.config.IMPORTE,
                        recharge.record.dispositivo || '',
                        `${recharge.record.descripcion} [${recharge.record.empresa}]`, // Formato: VEHÍCULO [EMPRESA]
                        detalleText,
                        folio || transID, // Usar folio o transID como respaldo
                        1
                    ],
                    type: this.db.getSequelizeClient().QueryTypes.INSERT,
                    transaction
                }
            );

            // Actualizar unix_saldo en dispositivos (+DIAS días) - AL FINAL DEL DÍA
            const nuevaFechaExpiracion = moment.tz("America/Mazatlan").add(this.config.DIAS, 'days').endOf('day').unix();

            await this.db.querySequelize(
                `UPDATE dispositivos SET unix_saldo = ? WHERE sim = ?`,
                {
                    replacements: [nuevaFechaExpiracion, recharge.sim],
                    type: this.db.getSequelizeClient().QueryTypes.UPDATE,
                    transaction
                }
            );

            await transaction.commit();

        } catch (error) {
            if (transaction) await transaction.rollback();
            throw error;
        }
    }

    // ===== RECOVERY ESPECÍFICO GPS =====
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

            // Nota para recovery GPS optimizada
            const { ahorroInmediato = 0, totalCandidatos = 1 } = recharge.noteData || {};
            const detailNote = this.generateOptimizedDetailNote(recharge, ahorroInmediato, totalCandidatos);
            const recoveryNote = `< RECUPERACIÓN GPS > ${detailNote}`;

            // Crear resumen JSON para recovery GPS
            const resumen = { error: 0, success: 1, refund: 0 };

            // Insertar en recargas
            const [idRecarga] = await this.db.querySequelize(
                `INSERT INTO recargas (total, fecha, notas, quien, proveedor, tipo, resumen)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                {
                    replacements: [
                        this.config.IMPORTE,
                        fecha,
                        recoveryNote,
                        'mextic.app',
                        recharge.provider || 'TAECEL',
                        'rastreo',
                        JSON.stringify(resumen)
                    ],
                    type: this.db.getSequelizeClient().QueryTypes.INSERT,
                    transaction
                }
            );

            // Insertar en detalle_recargas con formato original (recovery)
            const webserviceData = recharge.webserviceResponse || {};
            const saldoFinal = webserviceData.saldoFinal || '$0.00';
            const folio = webserviceData.folio || '';
            const telefono = recharge.sim;
            const carrier = 'Telcel';
            const fechaRecarga = moment.tz("America/Mazatlan").format('YYYY-MM-DD HH:mm:ss');
            const transID = recharge.transId || webserviceData.transId || '';
            // CORRECCIÓN: timeout e ip están en webserviceData.response (según estructura en cola auxiliar)
            const timeout = webserviceData.response?.timeout || webserviceData.timeout || '0.00';
            const ip = webserviceData.response?.ip || webserviceData.ip || '0.0.0.0';
            // NUEVO: Agregar minutos sin reportar al detalle (recovery individual)
            const minutosSinReportar = record?.minutos_sin_reportar || 'N/A';

            const detalleText = `[ Saldo Final: ${saldoFinal} ] Folio: ${folio}, Cantidad: $${this.config.IMPORTE}, Teléfono: ${telefono}, Carrier: ${carrier}, Fecha: ${fechaRecarga}, TransID: ${transID}, Timeout: ${timeout}, IP: ${ip}, Sin Reportar: ${minutosSinReportar} min`;

            // Insertar detalle con manejo de duplicados (recovery individual)
            try {
                await this.db.querySequelize(
                    `INSERT INTO detalle_recargas (id_recarga, sim, importe, dispositivo, vehiculo, detalle, folio, status)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    {
                        replacements: [
                            idRecarga,
                            recharge.sim,
                            this.config.IMPORTE,
                            record.dispositivo || '',
                            `${record.descripcion} [${record.empresa}]`, // Formato: VEHÍCULO [EMPRESA]
                            detalleText,
                            folio || transID, // Usar folio o transID como respaldo
                            1
                        ],
                        type: this.db.getSequelizeClient().QueryTypes.INSERT,
                        transaction
                    }
                );

                this.logger.info(`Detalle recovery insertado exitosamente`, {
                    operation: 'detalle_recovery_inserted_success',
                    sim: recharge.sim,
                    folio: folio || transID,
                    idRecarga: idRecarga
                });

                // Marcar en cola auxiliar como insertado
                if (this.persistenceQueue) {
                    await this.persistenceQueue.markItemAsInserted(null, recharge.sim);
                }

            } catch (insertError) {
                if (this.isDuplicateError(insertError)) {
                    // Duplicado en recovery individual = Ya existe = OK
                    this.logger.info(`Detalle recovery ya existe (duplicado)`, {
                        operation: 'detalle_recovery_duplicate_detected',
                        sim: recharge.sim,
                        folio: folio || transID,
                        error: insertError.message
                    });

                    console.log(`   ✓ Recovery duplicado: SIM ${recharge.sim}, Folio ${folio || transID} - Ya existe en BD`);

                    // Marcar en cola auxiliar como duplicado
                    if (this.persistenceQueue) {
                        await this.persistenceQueue.markItemAsDuplicate(null, recharge.sim);
                    }

                } else {
                    // Error real en recovery individual
                    this.logger.error(`Error real insertando detalle recovery`, insertError, {
                        operation: 'detalle_recovery_insertion_error',
                        sim: recharge.sim,
                        folio: folio || transID
                    });

                    // Marcar en cola auxiliar como fallido
                    if (this.persistenceQueue) {
                        await this.persistenceQueue.markItemAsFailed(null, recharge.sim, insertError);
                    }

                    throw insertError;
                }
            }

            // Actualizar unix_saldo en dispositivos (+DIAS días) - AL FINAL DEL DÍA
            const nuevaFechaExpiracion = moment.tz("America/Mazatlan").add(this.config.DIAS, 'days').endOf('day').unix();

            await this.db.querySequelize(
                `UPDATE dispositivos SET unix_saldo = ? WHERE sim = ?`,
                {
                    replacements: [nuevaFechaExpiracion, recharge.sim],
                    type: this.db.getSequelizeClient().QueryTypes.UPDATE,
                    transaction
                }
            );

            // Preparar analytics básicos para recovery individual
            const { ahorroInmediato: ahorroRecovery = 0, totalCandidatos: candidatosRecovery = 1 } = recharge.noteData || {};
            const analyticsData = {
                vencidos: 1, // Recovery siempre es de 1 dispositivo vencido
                porVencer: 0,
                vigentes: 0,
                totalCandidatos: candidatosRecovery,
                recargasIntentadas: 1,
                recargasExitosas: 1,
                recargasFallidas: 0,
                tasaExitoPortentaje: 100,
                ahorroInmediato: ahorroRecovery,
                noRecargadosVencidos: ahorroRecovery,
                noRecargadosPorVencer: 0,
                inversionRealizada: this.config.IMPORTE,
                inversionEvitada: ahorroRecovery * this.config.IMPORTE,
                ahorroPotencialPorcentaje: candidatosRecovery > 0 ? (ahorroRecovery / candidatosRecovery) * 100 : 0,
                versionAlgoritmo: 'v2.0',
                tipoServicio: 'GPS',
                minutosUmbral: this.config.MINUTOS_SIN_REPORTAR_PARA_RECARGA,
                diasLimite: this.config.DIAS_SIN_REPORTAR_LIMITE
            };

            // Guardar analytics de recovery DENTRO de la transacción
            // Guardar analytics de recovery DENTRO de la transacción
            await this.saveGPSAnalytics(idRecarga, analyticsData, transaction);

            await transaction.commit();
            // console.log(`   ✅ GPS ${recharge.sim} insertado en BD (+${this.config.DIAS} días)`);

        } catch (error) {
            if (transaction) await transaction.rollback();
            throw error;
        }
    }

    async getRecordDataForRecovery(recharge) {
        // Obtener datos del dispositivo para recovery
        const deviceData = await this.db.querySequelize(
            `SELECT UCASE(v.descripcion) AS descripcion, UCASE(e.nombre) AS empresa, d.nombre AS dispositivo, d.sim
             FROM vehiculos v
             INNER JOIN empresas e ON v.empresa = e.id
             INNER JOIN dispositivos d ON v.dispositivo = d.id
             WHERE d.sim = ? AND d.prepago = 1`,
            {
                replacements: [recharge.sim],
                type: this.db.getSequelizeClient().QueryTypes.SELECT
            }
        );

        if (deviceData.length === 0) {
            throw new Error(`No se encontraron datos para SIM ${recharge.sim}`);
        }

        return deviceData[0];
    }

    // ===== MÉTODO ESPECIALIZADO PARA MANEJO DE DUPLICADOS =====

    async insertBatchRechargesWithDuplicateHandling(recharges, isRecovery = false) {
        const results = { inserted: [], duplicates: [], errors: [] };
        const serviceType = this.getServiceType();

        this.logger.info('Iniciando inserción batch con manejo de duplicados', {
            operation: 'insert_batch_with_duplicate_handling',
            serviceType,
            rechargeCount: recharges.length,
            isRecovery
        });

        // TRANSACCIÓN ATÓMICA: Todo o nada
        const transaction = await this.db.getSequelizeClient().transaction();

        try {
            // Generar nota maestra con o sin prefijo de recuperación
            const noteData = this.generateNoteFromRecharges(recharges);
            let masterNote = this.generateNote(noteData);

            if (isRecovery) {
                masterNote = `< RECUPERACIÓN ${serviceType.toUpperCase()} > ${masterNote}`;
                this.logger.info('Aplicando prefijo de recuperación', {
                    operation: 'recovery_prefix_applied',
                    serviceType,
                    originalNote: this.generateNote(noteData),
                    finalNote: masterNote
                });
            }

            // Insertar registro maestro DENTRO DE LA TRANSACCIÓN
            const fecha = Math.floor(Date.now() / 1000);
            const totalImporte = recharges.length * 10; // GPS siempre $10 por recarga
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
                        recharges[0]?.provider || 'TAECEL',
                        'rastreo', // GPS usa 'rastreo'
                        JSON.stringify(resumen)
                    ],
                    type: this.db.getSequelizeClient().QueryTypes.INSERT,
                    transaction: transaction  // IMPORTANTE: Usar la transacción
                }
            );

            // Insertar detalles uno por uno para capturar duplicados
            for (const recharge of recharges) {
                try {
                    const folio = recharge.webserviceResponse?.folio;
                    const sim = recharge.sim || recharge.record?.sim;

                    if (!folio || !sim) {
                        results.errors.push(recharge);
                        this.logger.error('Datos incompletos para inserción', {
                            sim: sim,
                            folio: folio,
                            hasWebserviceResponse: !!recharge.webserviceResponse
                        });
                        continue;
                    }

                    // Generar el detalle completo con información de la transacción
                    const webResponse = recharge.webserviceResponse;
                    const saldoFinal = webResponse?.saldoFinal || 'RECOVERY';
                    const carrier = webResponse?.carrier || 'Telcel';
                    const fechaRecarga = webResponse?.fecha || new Date().toISOString().slice(0, 19).replace('T', ' ');
                    const transID = webResponse?.transId || recharge.transId || '';
                    const timeout = webResponse?.response?.timeout || '0.00';
                    const ip = webResponse?.response?.ip || '0.0.0.0';
                    const minutosSinReportar = recharge.record?.minutos_sin_reportar || 999;

                    // Agregar fecha de expiración original en timezone America/Mazatlan
                    const unixSaldo = recharge.record?.unix_saldo;
                    const fechaExpirabaText = unixSaldo ? `, Expiraba: ${moment.unix(unixSaldo).tz("America/Mazatlan").format('YYYY-MM-DD HH:mm')}` : '';

                    const detalleText = `[ Saldo Final: ${saldoFinal} ] Folio: ${folio}, Cantidad: $10, Teléfono: ${sim}, Carrier: ${carrier}, Fecha: ${fechaRecarga}, TransID: ${transID}, Timeout: ${timeout}, IP: ${ip}, Sin Reportar: ${minutosSinReportar} min${fechaExpirabaText}`;

                    // Formato correcto del vehículo: "VEHÍCULO [EMPRESA]"
                    const vehiculoFormatted = `${recharge.record?.descripcion || ''} [${recharge.record?.empresa || ''}]`;

                    // Insertar detalle DENTRO DE LA TRANSACCIÓN con campos completos
                    await this.db.querySequelize(
                        `INSERT INTO detalle_recargas
                         (id_recarga, sim, importe, dispositivo, vehiculo, detalle, folio, status)
                         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
                        {
                            replacements: [
                                idRecarga,
                                sim,
                                10,
                                recharge.record?.dispositivo || '',
                                vehiculoFormatted,
                                detalleText,
                                folio
                            ],
                            type: this.db.getSequelizeClient().QueryTypes.INSERT,
                            transaction: transaction  // IMPORTANTE: Usar la transacción
                        }
                    );

                    results.inserted.push(recharge);

                    this.logger.debug('Detalle insertado exitosamente', {
                        sim: sim,
                        folio: folio,
                        idRecarga: idRecarga
                    });

                } catch (error) {
                    // Detectar duplicado por índice único o SequelizeUniqueConstraintError
                    if (error.code === 'ER_DUP_ENTRY' ||
                        error.message?.includes('Duplicate entry') ||
                        error.message?.includes('idx_sim_folio') ||
                        error.name === 'SequelizeUniqueConstraintError' ||
                        error.message?.includes('SequelizeUniqueConstraintError')) {

                        // IMPORTANTE: Los duplicados se consideran EXITOSOS para efectos de limpieza de cola
                        results.duplicates.push(recharge);
                        results.inserted.push(recharge); // Agregarlo también como insertado para validación

                        this.logger.info('Duplicado prevenido por índice único - Considerado exitoso', {
                            sim: recharge.sim || recharge.record?.sim,
                            folio: recharge.webserviceResponse?.folio,
                            isRecovery,
                            indexName: 'idx_sim_folio',
                            reason: 'Folio ya existe en BD - Recarga previamente exitosa'
                        });

                    } else {
                        results.errors.push(recharge);
                        console.error('❌ ERROR DETALLADO AL INSERTAR DETALLE:', {
                            error: error.message,
                            errorCode: error.code,
                            errorDetails: error.toString(),
                            sql: error.sql,
                            sim: recharge.sim || recharge.record?.sim,
                            folio: recharge.webserviceResponse?.folio,
                            dispositivo: recharge.record?.dispositivo,
                            descripcion: recharge.record?.descripcion,
                            idRecarga: idRecarga
                        });
                        this.logger.error('Error insertando detalle de recarga', {
                            error: error.message,
                            errorCode: error.code,
                            errorDetails: error.toString(),
                            sql: error.sql,
                            sim: recharge.sim || recharge.record?.sim,
                            folio: recharge.webserviceResponse?.folio,
                            dispositivo: recharge.record?.dispositivo,
                            descripcion: recharge.record?.descripcion,
                            idRecarga: idRecarga
                        });
                    }
                }
            }

            // Actualizar saldos solo para las recargas insertadas exitosamente
            // DENTRO DE LA TRANSACCIÓN para garantizar atomicidad
            for (const recharge of results.inserted) {
                const sim = recharge.sim || recharge.record?.sim;
                const nuevaFechaExpiracion = moment.tz("America/Mazatlan").add(this.config.DIAS, 'days').endOf('day').unix();

                await this.db.querySequelize(
                    `UPDATE dispositivos SET unix_saldo = ? WHERE sim = ?`,
                    {
                        replacements: [nuevaFechaExpiracion, sim],
                        type: this.db.getSequelizeClient().QueryTypes.UPDATE,
                        transaction: transaction  // IMPORTANTE: Usar la transacción
                    }
                );

                this.logger.debug('Saldo actualizado para dispositivo', {
                    sim: sim,
                    nuevaFechaExpiracion: nuevaFechaExpiracion,
                    fechaLegible: moment.unix(nuevaFechaExpiracion).format('YYYY-MM-DD HH:mm:ss')
                });
            }

            // COMMIT: Si llegamos aquí, TODO salió bien
            await transaction.commit();

            this.logger.info('Transacción atómica completada exitosamente', {
                operation: 'atomic_transaction_completed',
                serviceType,
                inserted: results.inserted.length,
                duplicates: results.duplicates.length,
                errors: results.errors.length,
                idRecarga,
                devicesUpdated: results.inserted.length
            });

        } catch (error) {
            // ROLLBACK: Si hubo CUALQUIER error, deshacer TODO
            await transaction.rollback();

            console.error('❌ ERROR EN TRANSACCIÓN ATÓMICA - ROLLBACK EJECUTADO:', error.message);
            console.error('Stack completo:', error.stack);

            this.logger.error('Error en transacción atómica - rollback ejecutado', {
                error: error.message,
                stack: error.stack,
                serviceType,
                rechargeCount: recharges.length,
                transactionStatus: 'rolledback'
            });

            // IMPORTANTE: Si hay error en la transacción, TODAS las recargas van a errores
            // Esto asegura que NO se limpie la cola auxiliar si algo salió mal
            results.errors = [...recharges];  // TODAS las recargas van a errores
            results.inserted = [];  // Ninguna se considera insertada
            results.duplicates = [];  // Limpiar duplicados también
        }

        return results;
    }

    // Método auxiliar para generar noteData desde recharges
    generateNoteFromRecharges(recharges) {
        const ahora = Math.floor(Date.now() / 1000);
        let vencidos = 0, porVencer = 0;

        recharges.forEach(recharge => {
            const unixSaldo = parseInt(recharge.record?.unix_saldo || 0);
            if (unixSaldo > 0) {
                if (unixSaldo < ahora) {
                    vencidos++;
                } else {
                    porVencer++;
                }
            }
        });

        return {
            totalEvaluados: recharges.length,
            vencidos,
            porVencer,
            totalCandidatos: recharges.length
        };
    }

    // Método para generar nota maestra GPS
    generateNote(noteData) {
        const { totalEvaluados, vencidos, porVencer } = noteData;

        // Formato estándar GPS similar al usado en generateOptimizedMasterNote
        let note = `[${String(totalEvaluados).padStart(3, '0')}/${String(totalEvaluados).padStart(3, '0')}] GPS-AUTO v2.2 | VENCIDOS: ${vencidos} | POR VENCER: ${porVencer}`;

        return note;
    }

    // ===== MÉTODOS DE INTEGRACIÓN DE ALERTAS =====

    async handleProcessingError(error, record, stats) {
        if (!this.alertManager) return;

        // Calcular tasa de error actual
        const errorRate = (stats.failed / (stats.success + stats.failed)) * 100;

        // Enviar alerta si la tasa de error es alta
        if (errorRate > 20 && stats.failed > 5) {
            await this.sendHighErrorRateAlert(errorRate, stats);
        }

        // Enviar alerta para errores críticos específicos
        if (this.isCriticalError(error)) {
            await this.sendCriticalErrorAlert(error, record);
        }
    }

    async sendHighErrorRateAlert(errorRate, stats) {
        try {
            await this.alertManager.sendAlert({
                title: 'Alta Tasa de Error en GPS Processor',
                message: `🚨 **GPS Processor - Alta Tasa de Error**

**Tasa de Error:** ${errorRate.toFixed(1)}%
**Recargas Exitosas:** ${stats.success}
**Recargas Fallidas:** ${stats.failed}
**Total Procesadas:** ${stats.success + stats.failed}

El procesador GPS está experimentando una alta tasa de errores que puede afectar el servicio.`,
                priority: 'HIGH',
                service: 'GPS_PROCESSOR',
                category: 'ERROR_RATE',
                metadata: {
                    errorRate,
                    successCount: stats.success,
                    failedCount: stats.failed
                }
            });
        } catch (alertError) {
            console.error('Error enviando alerta de tasa de error GPS:', alertError.message);
        }
    }

    async sendCriticalErrorAlert(error, record) {
        try {
            await this.alertManager.sendAlert({
                title: 'Error Crítico en GPS Processor',
                message: `🔥 **GPS Processor - Error Crítico**

**SIM:** ${record.sim}
**Dispositivo:** ${record.dispositivo}
**Error:** ${error.message}
**Timestamp:** ${new Date().toLocaleString('es-MX', { timeZone: 'America/Mazatlan' })}

Error crítico detectado durante el procesamiento de recarga GPS.`,
                priority: 'CRITICAL',
                service: 'GPS_PROCESSOR',
                category: 'CRITICAL_ERROR',
                metadata: {
                    sim: record.sim,
                    dispositivo: record.dispositivo,
                    errorMessage: error.message,
                    errorStack: error.stack
                }
            });
        } catch (alertError) {
            console.error('Error enviando alerta crítica GPS:', alertError.message);
        }
    }

    isCriticalError(error) {
        const criticalPatterns = [
            'connection refused',
            'timeout',
            'network',
            'database',
            'authentication',
            'authorization',
            'webservice'
        ];

        const errorMessage = error.message.toLowerCase();
        return criticalPatterns.some(pattern => errorMessage.includes(pattern));
    }

    async recordSLAMetrics(processingTime, isSuccess) {
        if (!this.slaMonitor) return;

        // Registrar tiempo de respuesta
        this.slaMonitor.recordMetric('responseTime', processingTime, {
            service: 'GPS'
        });

        // Registrar disponibilidad
        this.slaMonitor.recordMetric('availability', isSuccess, {
            service: 'GPS'
        });

        // Actualizar estadísticas internas
        this.operationStats.totalRequests++;
        this.operationStats.totalResponseTime += processingTime;

        if (isSuccess) {
            this.operationStats.successfulRequests++;
        }
    }

    async sendProcessingSummaryAlert(stats, duration) {
        if (!this.alertManager || stats.success + stats.failed === 0) return;

        const errorRate = (stats.failed / (stats.success + stats.failed)) * 100;
        const avgProcessingTime = this.operationStats.totalRequests > 0 ?
            (this.operationStats.totalResponseTime / this.operationStats.totalRequests) : 0;

        // Solo enviar alerta si hay problemas significativos
        if (errorRate > 10 || avgProcessingTime > 5000) {
            await this.alertManager.sendAlert({
                title: 'Resumen de Procesamiento GPS',
                message: `📊 **GPS Processor - Resumen de Ciclo**

**Duración Total:** ${Math.round(duration / 1000)}s
**Recargas Exitosas:** ${stats.success}
**Recargas Fallidas:** ${stats.failed}
**Tasa de Error:** ${errorRate.toFixed(1)}%
**Tiempo Promedio:** ${Math.round(avgProcessingTime)}ms

${errorRate > 15 ? '⚠️ Alta tasa de error detectada.' : ''}
${avgProcessingTime > 10000 ? '🐌 Procesamiento lento detectado.' : ''}`,
                priority: errorRate > 15 ? 'HIGH' : 'MEDIUM',
                service: 'GPS_PROCESSOR',
                category: 'PROCESSING_SUMMARY',
                metadata: {
                    duration,
                    successCount: stats.success,
                    failedCount: stats.failed,
                    errorRate,
                    avgProcessingTime
                }
            });
        }
    }

    getProcessorStats() {
        return {
            ...this.operationStats,
            errorRate: this.operationStats.totalRequests > 0 ?
                (this.operationStats.failedRequests / this.operationStats.totalRequests) * 100 : 0,
            avgResponseTime: this.operationStats.totalRequests > 0 ?
                this.operationStats.totalResponseTime / this.operationStats.totalRequests : 0
        };
    }

    // ===== NUEVAS FUNCIONES PARA ANALYTICS Y NOTAS MEJORADAS =====

    /**
     * Genera nota optimizada con KPIs estructurados para el registro maestro
     */
    generateOptimizedMasterNote(analyticsData) {
        const {
            totalEvaluados,
            vencidos,
            porVencer,
            ahorroReal,
            recargasExitosas,
            recargasIntentadas
        } = analyticsData;

        // Formato nuevo: EVALUADOS, VENCIDOS, POR_VENCER y AHORRO
        let note = `[GPS-AUTO v2.3] EVALUADOS: ${totalEvaluados} | VENCIDOS: ${vencidos} | POR_VENCER: ${porVencer}`;

        // AHORRO: solo si es mayor a 0
        if (ahorroReal > 0) {
            note += ` | AHORRO: ${ahorroReal}`;
        }

        // RESULTADO: formato [XXX/YYY] con ceros a la izquierda
        const exitosasFormatted = String(recargasExitosas).padStart(3, '0');
        const intentadasFormatted = String(recargasIntentadas).padStart(3, '0');
        note += ` | [${exitosasFormatted}/${intentadasFormatted}]`;

        return note;
    }

    /**
     * Genera nota detallada para registro individual
     */
    generateOptimizedDetailNote(recharge, ahorroInmediato, totalCandidatos) {
        const { currentIndex, totalToRecharge } = recharge.noteData || {};
        const record = recharge.record;

        return `[ ${String(currentIndex).padStart(3, '0')} / ${String(totalToRecharge).padStart(3, '0')} ] ` +
               `${record.descripcion} [${record.empresa}] - Recarga Automática GPS v2.0 | ` +
               `Estado: ${this.getDeviceState(recharge)} | ` +
               `Ahorro proceso: ${ahorroInmediato} dispositivos | ` +
               `Eficiencia: ${((ahorroInmediato / totalCandidatos) * 100).toFixed(1)}%`;
    }

    /**
     * Determina el estado del dispositivo para la nota
     */
    getDeviceState(recharge) {
        const ahora = Math.floor(Date.now() / 1000);
        const unixSaldo = parseInt(recharge.record.unix_saldo || 0);

        if (unixSaldo < ahora) return 'VENCIDO';

        const finDiaHoy = moment.tz("America/Mazatlan").endOf("day").unix();
        if (unixSaldo <= finDiaHoy) return 'POR_VENCER';

        return 'VIGENTE';
    }

    /**
     * Obtiene estado de éxito basado en tasa (sin emojis)
     */
    getSuccessStatus(exitosas, total) {
        if (total === 0) return 'N/A';
        const tasa = (exitosas / total) * 100;
        if (tasa === 100) return 'PERFECTO';
        if (tasa >= 90) return 'EXCELENTE';
        if (tasa >= 70) return 'BUENO';
        return 'FALLAS';
    }

    /**
     * Calcula y guarda analytics detallados en BD
     */
    async saveGPSAnalytics(idRecarga, analyticsData, transaction = null) {
        try {
            const {
                vencidos, porVencer, vigentes, totalCandidatos,
                recargasIntentadas, recargasExitosas, recargasFallidas,
                ahorroInmediato, noRecargadosVencidos, noRecargadosPorVencer
            } = analyticsData;

            // Calcular métricas derivadas
            const tasaExito = recargasIntentadas > 0 ? ((recargasExitosas / recargasIntentadas) * 100) : 0;
            const ahorroPocentaje = totalCandidatos > 0 ? ((ahorroInmediato / totalCandidatos) * 100) : 0;
            const inversionRealizada = recargasExitosas * this.config.IMPORTE;
            const inversionEvitada = ahorroInmediato * this.config.IMPORTE;

            await this.db.querySequelize(
                `INSERT INTO recharge_analytics (
                    id_recarga, fecha_proceso,
                    total_vencidos, total_por_vencer, total_vigentes, total_candidatos,
                    recargas_intentadas, recargas_exitosas, recargas_fallidas, tasa_exito_porcentaje,
                    no_recargados_reportando, no_recargados_vencidos, no_recargados_por_vencer,
                    inversion_realizada, inversion_evitada, ahorro_potencial_porcentaje,
                    version_algoritmo, tipo_servicio, minutos_umbral, dias_limite
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                {
                    replacements: [
                        idRecarga, new Date(),
                        vencidos, porVencer, vigentes, totalCandidatos,
                        recargasIntentadas, recargasExitosas, recargasFallidas, tasaExito,
                        ahorroInmediato, noRecargadosVencidos, noRecargadosPorVencer,
                        inversionRealizada, inversionEvitada, ahorroPocentaje,
                        'v2.0', 'GPS', this.config.MINUTOS_SIN_REPORTAR_PARA_RECARGA, this.config.DIAS_SIN_REPORTAR_LIMITE
                    ],
                    type: this.db.getSequelizeClient().QueryTypes.INSERT,
                    ...(transaction && { transaction })
                }
            );

            this.logger.info('Analytics GPS guardados exitosamente', {
                operation: 'save_gps_analytics',
                idRecarga,
                inversionRealizada,
                inversionEvitada,
                ahorroPocentaje: ahorroPocentaje.toFixed(1)
            });

        } catch (error) {
            this.logger.error('Error guardando analytics GPS', error, {
                operation: 'save_gps_analytics_error',
                idRecarga
            });
            // No fallar el proceso principal por error en analytics
        }
    }

    /**
     * Prepara datos de analytics con datos del filtrado post-query
     */
    prepareAnalyticsData(filterResults, processStats, totalRecords) {
        const {
            ahorroReportando,
            vencidos,
            porVencer,
            totalEvaluados
        } = filterResults;

        return {
            totalEvaluados,          // NUEVO: Total de dispositivos evaluados
            vencidos,               // Calculado en filtrado post-query
            porVencer,              // Calculado en filtrado post-query
            vigentes: 0,            // Ya no aplica con nueva lógica
            totalCandidatos: totalRecords.length,
            recargasIntentadas: processStats.processed,
            recargasExitosas: processStats.success,
            recargasFallidas: processStats.failed,
            ahorroReal: ahorroReportando.length,  // NUEVO: Ahorro real medible
            ahorroInmediato: ahorroReportando.length,  // Para compatibilidad
            noRecargadosVencidos: 0,  // Deprecado
            noRecargadosPorVencer: 0, // Deprecado
            tasaExito: processStats.processed > 0 ?
                ((processStats.success / processStats.processed) * 100) : 0,
            eficienciaAhorro: totalEvaluados > 0 ?
                ((ahorroReportando.length / totalEvaluados) * 100) : 0
        };
    }

    /**
     * Verifica si un error es de duplicado (restricción UNIQUE violada)
     */
    isDuplicateError(error) {
        return error.name === 'SequelizeUniqueConstraintError' ||
               error.code === 'ER_DUP_ENTRY' ||
               error.errno === 1062 ||
               (error.message && (
                   error.message.includes('Duplicate entry') ||
                   error.message.includes('unique_sim_folio') ||
                   error.message.includes('UNIQUE constraint failed')
               ));
    }
}

module.exports = { GPSRechargeProcessor };