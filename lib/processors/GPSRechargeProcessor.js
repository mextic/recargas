const moment = require('moment-timezone');
const { BaseRechargeProcessor } = require('./BaseRechargeProcessor');
const { WebserviceClient } = require('../webservices/WebserviceClient');
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
            operation: 'gps_process_records_start',
            serviceType: 'GPS',
            recordsReceived: records.length
        });

        try {
            // Procesar registros GPS con validación previa
            const processResult = await this.insertBatchRechargesWithDuplicateHandling(records);

            return {
                processed: processResult.processed || 0,
                duplicatesSkipped: processResult.skipped || 0,
                failed: processResult.failed || 0,
                total: records.length
            };
        } catch (error) {
            this.logger.error('Error en processRecords GPS', { error: error.message });
            return {
                processed: 0,
                duplicatesSkipped: 0,
                failed: records.length,
                total: records.length
            };
        }
    }

    /**
     * Inserta registros GPS con manejo de duplicados
     */
    async insertBatchRechargesWithDuplicateHandling(recharges, isRecovery = false) {
        if (!recharges || recharges.length === 0) {
            return { processed: 0, skipped: 0, failed: 0 };
        }

        this.logger.info('Iniciando inserción GPS con validación previa', {
            operation: 'gps_batch_insert_start',
            count: recharges.length,
            isRecovery
        });

        let processed = 0;
        let skipped = 0;
        let failed = 0;

        // Procesar en lotes pequeños para validación individual
        const batchSize = 50;
        for (let i = 0; i < recharges.length; i += batchSize) {
            const batch = recharges.slice(i, i + batchSize);

            for (const recharge of batch) {
                try {
                    // Validar antes de insertar
                    const isDuplicate = await this.checkDuplicateExists(recharge);

                    if (isDuplicate) {
                        skipped++;
                        continue;
                    }

                    await this.insertSingleRecharge(recharge);
                    processed++;
                } catch (error) {
                    if (this.isDuplicateError(error)) {
                        skipped++;
                    } else {
                        failed++;
                        this.logger.error('Error insertando recarga GPS', {
                            error: error.message,
                            sim: recharge.sim
                        });
                    }
                }
            }
        }

        this.logger.info('Inserción GPS completada', {
            processed,
            skipped,
            failed,
            total: recharges.length
        });

        // IMPORTANTE: Incluir duplicados como "processed" para limpieza de cola
        // Los duplicados son elementos que ya están correctamente en BD
        return { 
            processed: processed, 
            skipped: skipped, 
            failed: failed,
            // Para compatibilidad con BaseRechargeProcessor:
            inserted: recharges.slice(0, processed),  // Los que se insertaron
            duplicates: recharges.filter((_, index) => index >= processed && index < processed + skipped), // Los duplicados
            errors: recharges.slice(processed + skipped) // Los que fallaron
        };
    }

    /**
     * Verifica si una recarga duplicada ya existe en BD
     */
    async checkDuplicateExists(recharge) {
        try {
            // SIMPLE: Verificar si este folio específico ya existe en BD
            const folioToCheck = recharge.webserviceResponse?.folio || recharge.transId;
            
            if (!folioToCheck) {
                return false; // Sin folio, no puede ser duplicado
            }

            const result = await this.db.querySequelize(
                `SELECT COUNT(*) as count FROM detalle_recargas WHERE folio = ?`,
                {
                    replacements: [folioToCheck],
                    type: this.db.getSequelizeClient().QueryTypes.SELECT
                }
            );

            const isDuplicate = result && result[0] && result[0].count > 0;
            
            if (isDuplicate) {
                this.logger.info('Duplicado detectado', {
                    operation: 'duplicate_detected',
                    folio: folioToCheck,
                    sim: recharge.sim
                });
            }

            return isDuplicate;
        } catch (error) {
            this.logger.error('Error verificando duplicado GPS', {
                error: error.message,
                sim: recharge.sim,
                folio: recharge.webserviceResponse?.folio || recharge.transId
            });
            return false; // En caso de error, asumir que no es duplicado
        }
    }

    /**
     * Inserta una recarga individual GPS
     */
    async insertSingleRecharge(recharge) {
        const transaction = await this.db.getSequelizeClient().transaction();

        try {
            // Usar datos reales de la cola auxiliar
            const folio = recharge.webserviceResponse?.folio || recharge.transId || `GPS_${Date.now()}_${recharge.sim}`;
            const importe = recharge.monto || recharge.webserviceResponse?.monto || this.config.IMPORTE || 30;
            const fecha = recharge.timestamp ? Math.floor(recharge.timestamp / 1000) : Math.floor(Date.now() / 1000);
            const provider = recharge.provider || 'GPS';
            const sim = recharge.sim || recharge.record?.sim;
            const dispositivo = recharge.record?.dispositivo || sim;
            const vehiculo = recharge.record?.descripcion || sim;
            const empresa = recharge.record?.empresa || 'Empresa';

            // 1. Insertar registro maestro en recargas
            const masterResult = await this.db.querySequelize(
                `INSERT INTO recargas (total, fecha, notas, quien, proveedor, tipo, resumen)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                {
                    replacements: [
                        importe,
                        fecha,
                        `Recarga GPS ${vehiculo}`,
                        'SISTEMA_AUTO',
                        provider, // Usar proveedor real (TAECEL, MST, etc.)
                        'rastreo',
                        `GPS - ${empresa} - ${vehiculo}`
                    ],
                    type: this.db.getSequelizeClient().QueryTypes.INSERT,
                    transaction
                }
            );

            const idRecarga = masterResult[0];

            // 2. Insertar detalle de recarga usando datos reales
            await this.db.querySequelize(
                `INSERT INTO detalle_recargas (id_recarga, sim, importe, dispositivo, vehiculo, detalle, folio, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                {
                    replacements: [
                        idRecarga,
                        sim,
                        importe,
                        dispositivo,
                        vehiculo,
                        `GPS - ${empresa} - ${vehiculo}`,
                        folio, // Usar folio real del webservice
                        1 // Status 1 = Exitoso (ya fue procesado por webservice)
                    ],
                    type: this.db.getSequelizeClient().QueryTypes.INSERT,
                    transaction
                }
            );

            await transaction.commit();

            this.logger.info('Recarga GPS insertada exitosamente', {
                operation: 'gps_single_recharge_inserted',
                folio,
                sim: recharge.sim,
                idRecarga
            });

            return { success: true, folio, idRecarga };

        } catch (error) {
            await transaction.rollback();
            throw error;
        }
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

    // MÉTODO DE PRUEBA PARA DEBUGGING
    testMethodDetection() {
        console.log('🧪 GPS Test method is working!');
        return true;
    }
}

module.exports = { GPSRechargeProcessor };
