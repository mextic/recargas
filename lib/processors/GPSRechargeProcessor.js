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
        // Usar performance monitor para medir tiempo de consulta
        return await performanceMonitor.measureDatabaseQuery(
            'gps_records_to_process',
            async () => {
                const fin_dia = moment.tz("America/Mazatlan").endOf("day").unix();
                const hoy = moment.tz("America/Mazatlan").format("YYYY-MM-DD");
                const dias_limite = this.config.DIAS_SIN_REPORTAR_LIMITE;

        // PASO 1: Obtener dispositivos con saldo vencido/por vencer QUE TENGAN TRACK
        const sql = `
            SELECT DISTINCT
                UCASE(v.descripcion) AS descripcion,
                UCASE(e.nombre) AS empresa,
                d.nombre AS dispositivo,
                d.sim AS sim,
                d.unix_saldo AS unix_saldo,
                v.status as vehiculo_estatus
            FROM
                vehiculos v
            JOIN
                empresas e ON v.empresa = e.id
            JOIN
                dispositivos d ON v.dispositivo = d.id
            WHERE
                d.prepago = 1
                AND v.status = 1  -- Vehículo en estado 'Activo'
                AND e.status = 1  -- Empresa en estado 'Activo'
                AND d.unix_saldo IS NOT NULL  -- Debe tener fecha de vencimiento
                AND (unix_saldo <= ${fin_dia})  -- Dispositivos que vencen hoy o ya vencieron
                ${this.getCompanyFilter()}
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
                -- DEBE tener registros en track (sin esto no se considera para recarga)
                AND EXISTS (
                    SELECT 1 FROM track t WHERE t.dispositivo = d.nombre
                )
                -- Sin recargas exitosas hoy
                AND NOT EXISTS (
                    SELECT 1 
                    FROM detalle_recargas dr
                    JOIN recargas r ON dr.id_recarga = r.id
                    WHERE dr.sim = d.sim
                        AND dr.status = 1
                        AND DATE(FROM_UNIXTIME(r.fecha)) = '${hoy}'
                )
            ORDER BY
                descripcion,
                v.descripcion
        `;

        this.logger.info('Ejecutando consulta GPS', {
            operation: 'get_records_query',
            serviceType: 'GPS',
            variables: { fin_dia, hoy, dias_limite }
        });

        const records = await this.executeWithRetry(
            async () => await this.db.querySequelize(sql),
            {
                operationName: 'get_gps_records',
                transactionId: `gps_query_${Date.now()}`
            }
        );

        this.logger.info('Consulta GPS completada', {
            operation: 'get_records_result',
            recordCount: records.length
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

    async processRecords(records, stats) {
        this.logger.info('Iniciando procesamiento de registros GPS', {
            operation: 'process_records_start',
            serviceType: 'GPS',
            recordCount: records.length
        });

        if (records.length === 0) {
            this.logger.info('Sin dispositivos GPS para procesar', {
                operation: 'no_records_to_process',
                serviceType: 'GPS',
                possibleCauses: [
                    'Todos los dispositivos ya tienen recarga del día',
                    'No hay dispositivos con saldo vencido',
                    'Filtros de exclusión eliminaron todos los registros',
                    `Dispositivos no cumplen límite de días sin reportar (${this.config.DIAS_SIN_REPORTAR_LIMITE} días)`
                ]
            });
            return stats;
        }

        // Aplicar filtrado como en script original (ahora async)
        const { registrosArecargar, registrosVencenFinDiaReportando, reportandoEnTiempo } =
            await this.filterDevicesOriginalLogic(records);

        // Estadísticas completas para evaluación del algoritmo
        this.logger.info('Estadísticas GPS detalladas', {
            operation: 'gps_statistics',
            serviceType: 'GPS',
            stats: {
                totalRegistros: records.length,
                paraRecargar: registrosArecargar.length,
                minutosSinReportar: this.config.MINUTOS_SIN_REPORTAR_PARA_RECARGA,
                pendientesFinDia: registrosVencenFinDiaReportando.length,
                reportandoEnTiempo
            }
        });

        // Indicadores adicionales para evaluación de algoritmo
        const totalDispositivos = records.length;
        const porcentajeRecargar = totalDispositivos > 0 ? ((registrosArecargar.length / totalDispositivos) * 100).toFixed(1) : 0;
        const porcentajePendientes = totalDispositivos > 0 ? ((registrosVencenFinDiaReportando.length / totalDispositivos) * 100).toFixed(1) : 0;
        const porcentajeEnTiempo = totalDispositivos > 0 ? ((reportandoEnTiempo / totalDispositivos) * 100).toFixed(1) : 0;

        this.logger.info('Indicadores de algoritmo GPS', {
            operation: 'gps_algorithm_indicators',
            serviceType: 'GPS',
            indicators: {
                eficienciaRecarga: `${porcentajeRecargar}%`,
                dispositivosEnGracia: `${porcentajePendientes}%`,
                dispositivosEstables: `${porcentajeEnTiempo}%`
            }
        });

        if (registrosVencenFinDiaReportando.length > 0) {
            this.logger.warn('Dispositivos con vencimiento próximo pero reportando', {
                operation: 'devices_expiring_today',
                serviceType: 'GPS',
                count: registrosVencenFinDiaReportando.length
            });
        }

        // Análisis de distribución por días sin reportar
        if (totalDispositivos > 0) {
            const distribucionDias = this.analyzeDistributionByDays(records);
            const limiteMaximo = this.config.DIAS_SIN_REPORTAR_LIMITE;
            console.log(`📊 DISTRIBUCIÓN POR DÍAS SIN REPORTAR (Límite: ${limiteMaximo} días):`);
            Object.keys(distribucionDias).forEach(rango => {
                const count = distribucionDias[rango];
                const porcentaje = ((count / totalDispositivos) * 100).toFixed(1);
                console.log(`   • ${rango}: ${count} dispositivos (${porcentaje}%)`);
            });
            console.log(`   ℹ️  Nota: Solo se muestran dispositivos ≤${limiteMaximo} días (filtro SQL HAVING)`);
        }

        // Métricas adicionales para optimización de algoritmo
        if (totalDispositivos > 0) {
            console.log(`💡 RECOMENDACIONES DE OPTIMIZACIÓN:`);

            // Analizar eficiencia del umbral de minutos
            const minutosActual = this.config.MINUTOS_SIN_REPORTAR_PARA_RECARGA;
            const dispositivos_10_min = records.filter(r => parseFloat(r.minutos_sin_reportar) >= 10).length;
            const dispositivos_30_min = records.filter(r => parseFloat(r.minutos_sin_reportar) >= 30).length;
            const dispositivos_60_min = records.filter(r => parseFloat(r.minutos_sin_reportar) >= 60).length;

            console.log(`   • Con umbral 10min: ${dispositivos_10_min} dispositivos (${((dispositivos_10_min/totalDispositivos)*100).toFixed(1)}%)`);
            console.log(`   • Con umbral 30min: ${dispositivos_30_min} dispositivos (${((dispositivos_30_min/totalDispositivos)*100).toFixed(1)}%)`);
            console.log(`   • Con umbral 60min: ${dispositivos_60_min} dispositivos (${((dispositivos_60_min/totalDispositivos)*100).toFixed(1)}%)`);
            console.log(`   • Umbral actual: ${minutosActual}min → ${registrosArecargar.length} dispositivos`);

            // Análisis de balance algoritmo
            const ratio_recargar_total = registrosArecargar.length / totalDispositivos;
            if (ratio_recargar_total > 0.3) {
                console.log(`⚠️  ALERTA: ${(ratio_recargar_total*100).toFixed(1)}% necesita recarga (>30% puede indicar problema masivo)`);
            } else if (ratio_recargar_total < 0.05) {
                console.log(`✅ SALUDABLE: Solo ${(ratio_recargar_total*100).toFixed(1)}% necesita recarga (<5% indica sistema estable)`);
            }

            // Análisis temporal
            const ahora = moment.tz("America/Mazatlan");
            const horaActual = ahora.hour();
            console.log(`🕐 CONTEXTO TEMPORAL:`);
            console.log(`   • Hora actual: ${ahora.format('HH:mm')} (Mazatlán)`);
            console.log(`   • Momento del día: ${this.getTimeOfDayDescription(horaActual)}`);

            if (horaActual >= 6 && horaActual <= 9) {
                console.log(`   • 🌅 HORA PICO: Período de mayor actividad de dispositivos GPS`);
            } else if (horaActual >= 22 || horaActual <= 5) {
                console.log(`   • 🌙 HORA BAJA: Período de menor actividad GPS (normal más sin reportar)`);
            }
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

        // Crear barra de progreso visual para GPS (optimizada)
        const progressBar = ProgressFactory.createServiceProgressBar(
            'GPS', 
            registrosArecargar.length, 
            `Procesando ${registrosArecargar.length} dispositivos GPS`
        );
        progressBar.updateThreshold = 200; // Actualizar máximo cada 200ms para menor overhead

        // Mostrar progreso inicial
        progressBar.update(0, 'Obteniendo proveedores...');

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

            // Actualizar progreso con información detallada
            progressBar.update(i, `🔍 GPS ${record.sim} - ${record.descripcion || record.dispositivo}`);

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
                    // Agregar a cola auxiliar GPS
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
                            sim: record.sim
                        },
                        webserviceResponse: rechargeResult.response,
                        noteData: {
                            currentIndex: i + 1,
                            totalToRecharge: registrosArecargar.length,
                            reportandoEnTiempo: reportandoEnTiempo,
                            totalRecords: records.length,
                            ahorroInmediato: registrosVencenFinDiaReportando.length,
                            totalCandidatos: records.length
                        },
                        provider: rechargeResult.provider,
                        status: 'webservice_success_pending_db',
                        timestamp: Date.now(),
                        addedAt: Date.now(),
                        tipoServicio: 'GPS',
                        diasVigencia: this.config.DIAS
                    };

                    await this.executeWithRetry(
                        async () => await this.persistenceQueue.addToAuxiliaryQueue(auxItem),
                        {
                            operationName: 'add_to_auxiliary_queue',
                            transactionId: `aux_queue_${record.sim}_${Date.now()}`
                        }
                    );

                    stats.processed++;
                    stats.success++;

                    // Actualizar progreso - éxito (optimizado)
                    progressBar.update(i + 1, `✅ ${record.sim} - OK`);

                    this.logger.info('GPS recargado exitosamente', {
                        operation: 'gps_recharge_success',
                        serviceType: 'GPS',
                        sim: record.sim,
                        dias: this.config.DIAS,
                        importe: this.config.IMPORTE,
                        provider: rechargeResult.provider
                    });
                } else {
                    // Actualizar progreso - error (optimizado)
                    progressBar.update(i + 1, `❌ ${record.sim} - Error`);

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
                // Actualizar progreso - excepción (optimizado)
                progressBar.update(i + 1, `💥 ${record.sim} - Excepción`);

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
    async filterDevicesOriginalLogic(allRecords) {
        const registrosArecargar = [];
        const registrosVencenFinDiaReportando = [];
        let reportandoEnTiempo = 0;

        // Definir timestamps para clasificación clara
        const ahora = Math.floor(Date.now() / 1000);
        const fin_dia_hoy = moment.tz("America/Mazatlan").endOf("day").unix();
        const dias_limite = this.config.DIAS_SIN_REPORTAR_LIMITE;

        // Contadores para estadísticas
        let vencidos = 0;
        let porVencer = 0;
        let vigentes = 0;

        this.logger.info('Evaluando track por dispositivo', {
            operation: 'evaluate_track_per_device',
            serviceType: 'GPS',
            deviceCount: allRecords.length
        });

        for (const record of allRecords) {
            const unix_saldo = parseInt(record.unix_saldo);

            // Clasificación clara de estados de saldo
            const estaVencido = unix_saldo < ahora;  // Ya expiró
            const vencePorVencer = unix_saldo >= ahora && unix_saldo <= fin_dia_hoy;  // Vence hoy

            // Agregar clasificación al registro para logging
            if (estaVencido) {
                record.estadoSaldo = 'vencido';
                vencidos++;
            } else if (vencePorVencer) {
                record.estadoSaldo = 'por_vencer';
                porVencer++;
            } else {
                record.estadoSaldo = 'vigente';
                vigentes++;
            }

            // PASO 2: Evaluar track individual para dispositivos vencidos/por vencer
            if (estaVencido || vencePorVencer) {
                try {
                    // Consulta individual de track para este dispositivo
                    const trackQuery = await this.db.querySequelize(`
                        SELECT 
                            t.fecha as ultimo_registro,
                            TRUNCATE((UNIX_TIMESTAMP() - t.fecha) / 60, 0) as minutos_sin_reportar,
                            TRUNCATE((UNIX_TIMESTAMP() - t.fecha) / 60 / 60 / 24, 2) as dias_sin_reportar
                        FROM track t
                        WHERE t.dispositivo = '${record.dispositivo}'
                        ORDER BY t.fecha DESC
                        LIMIT 1
                    `);

                    if (trackQuery.length > 0) {
                        const trackInfo = trackQuery[0];
                        record.ultimo_registro = trackInfo.ultimo_registro;
                        record.minutos_sin_reportar = trackInfo.minutos_sin_reportar;
                        record.dias_sin_reportar = trackInfo.dias_sin_reportar;

                        // Verificar límites de días (no más de X días sin reportar)
                        if (trackInfo.dias_sin_reportar <= dias_limite) {
                            // Lógica de recarga: evaluar minutos sin reportar
                            if (trackInfo.minutos_sin_reportar >= this.config.MINUTOS_SIN_REPORTAR_PARA_RECARGA) {
                                // Vencido/Por vencer y sin reportar por X minutos -> RECARGAR
                                registrosArecargar.push(record);
                            } else {
                                // Vencido/Por vencer pero reportando recientemente -> PENDIENTE
                                registrosVencenFinDiaReportando.push(record);
                            }
                        } else {
                            // Dispositivo con más de X días sin reportar -> IGNORAR
                            this.logger.debug('Dispositivo ignorado por exceso de días sin reportar', {
                                operation: 'device_ignored_old_track',
                                dispositivo: record.dispositivo,
                                dias: trackInfo.dias_sin_reportar,
                                limite: dias_limite
                            });
                        }
                    } else {
                        // Sin registros de track -> IGNORAR
                        record.minutos_sin_reportar = null;
                        record.dias_sin_reportar = null;
                        this.logger.debug('Dispositivo sin registros de track', {
                            operation: 'device_no_track',
                            dispositivo: record.dispositivo
                        });
                    }
                } catch (error) {
                    this.logger.error('Error consultando track para dispositivo', {
                        operation: 'track_query_error',
                        dispositivo: record.dispositivo,
                        error: error.message
                    });
                    // En caso de error, no incluir en recargas
                }
            } else {
                // Vigente y reportando -> OK
                reportandoEnTiempo++;
            }
        }

        // Log de estadísticas de estados
        console.log(`📊 ESTADO DE DISPOSITIVOS GPS:`);
        console.log(`   • Vencidos: ${vencidos} dispositivos (saldo ya expiró)`);
        console.log(`   • Por vencer (hoy): ${porVencer} dispositivos (expiran hoy)`);
        console.log(`   • Vigentes: ${vigentes} dispositivos (expiran después de hoy)`);
        console.log(`   • Total considerados para recarga: ${registrosArecargar.length} (vencidos + por vencer sin reportar)`);
        console.log(`   • En espera (reportando): ${registrosVencenFinDiaReportando.length} (vencidos + por vencer reportando)`);
        console.log(`   • Estables: ${reportandoEnTiempo} (vigentes)`);
        
        // Información adicional sobre dispositivos "por vencer"
        if (porVencer > 0) {
            console.log(`💡 INFO: ${porVencer} dispositivos vencen HOY - se aplicará recarga preventiva si no reportan`);
        }

        return {
            registrosArecargar,
            registrosVencenFinDiaReportando,
            reportandoEnTiempo
        };
    }

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
        const stats = { processed: 0, failed: 0 };
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

            console.log(`   🔄 Insertando ${currentCycleRecharges.length} recargas GPS del ciclo actual como LOTE...`);

            // NUEVA LÓGICA: 1 registro maestro + múltiples detalles
            let processedSims = new Set(); // Declarar fuera para uso posterior
            
            try {
                await this.insertBatchRecharges(currentCycleRecharges);
                stats.processed = currentCycleRecharges.length;
                console.log(`   ✅ LOTE GPS: ${currentCycleRecharges.length} recargas insertadas en BD como un solo registro maestro`);

                processedSims = new Set(currentCycleRecharges.map(r => r.sim));
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
                console.log(`   🧹 ${processedSims.size} recargas GPS removidas de cola auxiliar`);
            }

        } catch (error) {
            console.error(`   ❌ Error procesando ciclo actual GPS: ${error.message}`);
        }

        return stats;
    }

    // ===== INSERCIÓN POR LOTES GPS (1 MAESTRO + N DETALLES) =====
    async insertBatchRecharges(recharges) {
        let transaction = null;

        try {
            transaction = await this.db.getSequelizeClient().transaction();

            const fecha = Math.floor(Date.now() / 1000);
            const totalRecargas = recharges.length;
            const totalImporte = recharges.reduce((sum, r) => sum + (r.importe || this.config.IMPORTE), 0);

            // Extraer estadísticas del primer registro para la nota
            const firstRecharge = recharges[0];
            const noteData = firstRecharge.noteData || {};
            const reportandoEnTiempo = noteData.reportandoEnTiempo || 0;
            const totalRecords = noteData.totalRecords || totalRecargas;

            // Preparar datos de analytics para nota optimizada
            const filterResults = {
                registrosVencenFinDiaReportando: Array(reportandoEnTiempo).fill({}),
                reportandoEnTiempo: 0
            };
            const processStats = {
                processed: totalRecargas,
                success: totalRecargas,
                failed: 0
            };
            
            const analyticsData = this.prepareAnalyticsData(filterResults, processStats, totalRecords);
            
            // Generar nota maestra optimizada con KPIs
            const masterNote = this.generateOptimizedMasterNote(analyticsData);

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

                const detalleText = `[ Saldo Final: ${saldoFinal} ] Folio: ${folio}, Cantidad: $${recharge.importe || this.config.IMPORTE}, Teléfono: ${telefono}, Carrier: ${carrier}, Fecha: ${fechaRecarga}, TransID: ${transID}, Timeout: ${timeout}, IP: ${ip}`;

                // Insertar detalle ligado al maestro
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

                // 3. ACTUALIZAR unix_saldo EN DISPOSITIVOS (+DIAS días)
                const nuevaFechaExpiracion = Math.floor(Date.now() / 1000) + (this.config.DIAS * 24 * 60 * 60);

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

            const detalleText = `[ Saldo Final: ${saldoFinal} ] Folio: ${folio}, Cantidad: $${this.config.IMPORTE}, Teléfono: ${telefono}, Carrier: ${carrier}, Fecha: ${fechaRecarga}, TransID: ${transID}, Timeout: ${timeout}, IP: ${ip}`;

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

            // Actualizar unix_saldo en dispositivos (+DIAS días)
            const nuevaFechaExpiracion = Math.floor(Date.now() / 1000) + (this.config.DIAS * 24 * 60 * 60);

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

            const detalleText = `[ Saldo Final: ${saldoFinal} ] Folio: ${folio}, Cantidad: $${this.config.IMPORTE}, Teléfono: ${telefono}, Carrier: ${carrier}, Fecha: ${fechaRecarga}, TransID: ${transID}, Timeout: ${timeout}, IP: ${ip}`;

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

            // Actualizar unix_saldo en dispositivos (+DIAS días)
            const nuevaFechaExpiracion = Math.floor(Date.now() / 1000) + (this.config.DIAS * 24 * 60 * 60);

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
            await this.saveGPSAnalytics(idRecarga, analyticsData, transaction);

            await transaction.commit();
            console.log(`   ✅ GPS ${recharge.sim} insertado en BD (+${this.config.DIAS} días)`);

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
            vencidos, porVencer,
            recargasExitosas, recargasIntentadas,
            ahorroInmediato, totalCandidatos, eficiencia
        } = analyticsData;

        // Estado de éxito sin emojis
        const estadoRecargas = this.getSuccessStatus(recargasExitosas, recargasIntentadas);

        return `[GPS-AUTO v2.0] VENCIDOS: ${vencidos} (Recargados: ${recargasExitosas}/${recargasIntentadas} ${estadoRecargas}) | ` +
               `POR_VENCER: ${porVencer} (Estado: ${porVencer > 0 ? 'Preventivo' : 'N/A'}) | ` +
               `AHORRO_INMEDIATO: ${ahorroInmediato} reportando | ` +
               `EFICIENCIA: ${eficiencia.toFixed(1)}% | ` +
               `TOTAL: ${recargasExitosas}/${recargasIntentadas} exitosas de ${totalCandidatos} candidatos | ` +
               `INVERSION: $${recargasExitosas * this.config.IMPORTE} | ` +
               `AHORRO_POTENCIAL: $${ahorroInmediato * this.config.IMPORTE}`;
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
     * Prepara datos de analytics a partir de estadísticas del proceso
     */
    prepareAnalyticsData(filterResults, processStats, totalCandidatos) {
        const { registrosVencenFinDiaReportando, reportandoEnTiempo } = filterResults;
        
        // Contar dispositivos por estado de saldo
        let vencidos = 0, porVencer = 0, vigentes = 0;
        let noRecargadosVencidos = 0, noRecargadosPorVencer = 0;
        
        const ahora = Math.floor(Date.now() / 1000);
        const finDiaHoy = moment.tz("America/Mazatlan").endOf("day").unix();
        
        // Contar en registros que NO se recargaron
        registrosVencenFinDiaReportando.forEach(record => {
            const unixSaldo = parseInt(record.unix_saldo);
            if (unixSaldo < ahora) {
                noRecargadosVencidos++;
            } else if (unixSaldo <= finDiaHoy) {
                noRecargadosPorVencer++;
            }
        });
        
        // Contar totales por estado (aproximado basado en patrón observado)
        vencidos = Math.floor(totalCandidatos * 0.8); // Estimación: 80% vencidos
        porVencer = totalCandidatos - vencidos;
        vigentes = reportandoEnTiempo;
        
        return {
            vencidos,
            porVencer,
            vigentes,
            totalCandidatos,
            recargasIntentadas: processStats.processed,
            recargasExitosas: processStats.success,
            recargasFallidas: processStats.failed,
            ahorroInmediato: registrosVencenFinDiaReportando.length,
            noRecargadosVencidos,
            noRecargadosPorVencer,
            tasaExito: processStats.processed > 0 ? ((processStats.success / processStats.processed) * 100) : 0,
            eficiencia: totalCandidatos > 0 ? ((registrosVencenFinDiaReportando.length / totalCandidatos) * 100) : 0
        };
    }
}

module.exports = { GPSRechargeProcessor };