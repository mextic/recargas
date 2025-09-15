const moment = require('moment-timezone');
const { BaseRechargeProcessor } = require('./BaseRechargeProcessor');
const { WebserviceClient } = require('../webservices/WebserviceClient');
const { ProgressFactory } = require('../utils/progressBar');
const serviceConfig = require('../../config/services');

class GPSRechargeProcessor extends BaseRechargeProcessor {
    constructor(dbConnection, lockManager, persistenceQueue) {
        super(dbConnection, lockManager, persistenceQueue, serviceConfig.GPS);
    }

    getServiceType() {
        return 'gps';
    }

    getServiceConfig() {
        return this.config;
    }

    // ===== IMPLEMENTACIÓN ESPECÍFICA GPS =====
    async getRecordsToProcess() {
        const fin_dia = moment.tz("America/Mazatlan").endOf("day").unix();
        const hoy = moment.tz("America/Mazatlan").format("YYYY-MM-DD");
        const dias_limite = this.config.DIAS_SIN_REPORTAR_LIMITE;

        const sql = `
            SELECT DISTINCT
                UCASE(v.descripcion) AS descripcion,
                UCASE(e.nombre) AS empresa,
                d.nombre AS dispositivo,
                d.sim AS sim,
                d.unix_saldo AS unix_saldo,
                v.status as vehiculo_estatus,
                -- Subconsulta para obtener la última conexión desde la tabla track
                (
                    SELECT t.fecha
                    FROM track t
                    WHERE t.dispositivo = d.nombre
                    ORDER BY t.fecha DESC
                    LIMIT 1
                ) AS ultimo_registro,
                -- Calcular los días sin reportar (IGUAL A VERSIÓN FUNCIONAL)
                (
                    SELECT TRUNCATE((UNIX_TIMESTAMP() - (t.fecha)) / 60 / 60 / 24, 2)
                    FROM track t
                    WHERE t.dispositivo = d.nombre
                    ORDER BY t.fecha DESC
                    LIMIT 1
                ) AS dias_sin_reportar,
                -- Calcular minutos sin reportar (CRÍTICO para lógica de filtrado)
                (
                    SELECT TRUNCATE((UNIX_TIMESTAMP() - (t.fecha)) / 60, 0)
                    FROM track t
                    WHERE t.dispositivo = d.nombre
                    ORDER BY t.fecha DESC
                    LIMIT 1
                ) AS minutos_sin_reportar,
                -- Verificar si ya tiene recarga exitosa hoy (como versión funcional)
                COALESCE((
                    SELECT COUNT(*)
                    FROM detalle_recargas dr
                    JOIN recargas r ON dr.id_recarga = r.id
                    WHERE dr.sim = d.sim
                        AND dr.status = 1
                        AND DATE(FROM_UNIXTIME(r.fecha)) = '${hoy}'
                ), 0) as recargas_hoy
            FROM
                vehiculos v
            JOIN
                empresas e ON v.empresa = e.id
            JOIN
                dispositivos d ON v.dispositivo = d.id
            JOIN
                sucursales s ON v.sucursal = s.id
            WHERE
                d.prepago = 1
                AND v.status = 1  -- Vehículo en estado 'Activo'
                AND e.status = 1  -- Empresa en estado 'Activo'
                AND d.unix_saldo IS NOT NULL
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
                AND (unix_saldo <= ${fin_dia})
                -- Remover filtro de recargas de WHERE - se maneja en HAVING con COALESCE
                -- GPS no filtra por tipo = 'paquete' (eso es de VOZ)
            HAVING
                dias_sin_reportar <= ${dias_limite}
                AND vehiculo_estatus = 1
                AND recargas_hoy = 0  -- Solo incluir los que NO tienen recarga hoy
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

        // Aplicar filtrado como en script original
        const { registrosArecargar, registrosVencenFinDiaReportando, reportandoEnTiempo } =
            this.filterDevicesOriginalLogic(records);

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
                            totalRecords: records.length
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
                this.logger.error('Error procesando dispositivo GPS', error, {
                    operation: 'process_device_error',
                    serviceType: 'GPS',
                    sim: record.sim,
                    currentIndex: i + 1
                });
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
    filterDevicesOriginalLogic(allRecords) {
        const registrosArecargar = [];
        const registrosVencenFinDiaReportando = [];
        let reportandoEnTiempo = 0;

        for (const record of allRecords) {
            const minutosDesdeUltimoReporte = parseInt(record.minutos_sin_reportar);
            const estaVencido = parseInt(record.unix_saldo) <= Math.floor(Date.now() / 1000);

            if (estaVencido) {
                if (minutosDesdeUltimoReporte >= this.config.MINUTOS_SIN_REPORTAR_PARA_RECARGA) {
                    // Vencido y sin reportar por X minutos -> RECARGAR
                    registrosArecargar.push(record);
                } else {
                    // Vencido pero reportando recientemente -> PENDIENTE
                    registrosVencenFinDiaReportando.push(record);
                }
            } else {
                // No vencido y reportando -> OK
                reportandoEnTiempo++;
            }
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

            // Nota del registro maestro GPS con formato correcto
            const masterNote = `[ ${String(totalRecargas).padStart(3, '0')} / ${String(totalRecargas).padStart(3, '0')} ] Recarga Automática **** ${reportandoEnTiempo} Reportando en Tiempo y Forma **** [ ${totalRecords - totalRecargas - reportandoEnTiempo} Pendientes al Finalizar el Día ] (${totalRecargas} procesados de ${totalRecords} total)`;

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

            // Nota NORMAL - SIN prefijo "< RECUPERACIÓN >"
            const { currentIndex = 1, totalToRecharge = 1, reportandoEnTiempo = 0, totalRecords = 1 } = recharge.noteData || {};
            const normalNote = `[ ${String(currentIndex).padStart(3, '0')} / ${String(totalToRecharge).padStart(3, '0')} ] ${recharge.record.descripcion} [${recharge.record.empresa}] - Recarga Automática **** ${reportandoEnTiempo} Reportando en Tiempo y Forma **** [ ${totalRecords - totalToRecharge - reportandoEnTiempo} Pendientes al Finalizar el Día ] (${totalToRecharge} procesados de ${totalRecords} total)`;

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

            // Nota para recovery GPS
            const { currentIndex = 1, totalToRecharge = 1, reportandoEnTiempo = 0, totalRecords = 1 } = recharge.noteData || {};
            const recoveryNote = `< RECUPERACIÓN GPS > [ ${String(currentIndex).padStart(3, '0')} / ${String(totalToRecharge).padStart(3, '0')} ] ${record.descripcion} [${record.empresa}] - Recarga Automática **** ${reportandoEnTiempo} Reportando en Tiempo y Forma **** [ ${totalRecords - totalToRecharge - reportandoEnTiempo} Pendientes al Finalizar el Día ] (${totalToRecharge} procesados de ${totalRecords} total)`;

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
}

module.exports = { GPSRechargeProcessor };