/**
 * Job unificado de seguimiento para actualizar ahorro real confirmado
 * Verifica dispositivos que NO se recargaron pero siguen reportando después de vencidos
 * Soporta GPS (MySQL) y ELIoT (MongoDB) en tabla unificada recharge_analytics
 * Se ejecuta diariamente para confirmar si el ahorro potencial se convirtió en ahorro real
 */
const moment = require('moment-timezone');
const { initDatabases, dbGps, dbEliot } = require('../lib/database');
const { createServiceLogger } = require('../lib/utils/logger');
const { connectMongoDB } = require('../lib/database/mongoClient');
const { consultarMetricaPorUuid } = require('../lib/models/Metrica');

class RechargeAhorroRealJob {
    constructor() {
        this.logger = createServiceLogger('RECHARGE_AHORRO_REAL_JOB');
    }

    /**
     * Ejecuta el job de seguimiento de ahorro real unificado
     * Actualiza métricas de ahorro confirmado en recharge_analytics para GPS y ELIoT
     */
    async ejecutar() {
        try {
            await initDatabases();
            await connectMongoDB();
            this.logger.info('Iniciando job unificado de seguimiento de ahorro real');

            // Procesar ahorro confirmado a diferentes intervalos para ambos servicios
            const resultados = {
                gps: {
                    ahorro24h: await this.procesarAhorro24h('GPS'),
                    ahorro48h: await this.procesarAhorro48h('GPS'),
                    ahorro7d: await this.procesarAhorro7d('GPS')
                },
                eliot: {
                    ahorro24h: await this.procesarAhorro24h('ELIOT'),
                    ahorro48h: await this.procesarAhorro48h('ELIOT'),
                    ahorro7d: await this.procesarAhorro7d('ELIOT')
                }
            };

            this.logger.info('Job unificado de ahorro real completado', {
                operation: 'unified_ahorro_real_job_completed',
                resultados
            });

            return resultados;

        } catch (error) {
            this.logger.error('Error en job unificado de ahorro real', error);
            throw error;
        }
    }

    /**
     * Procesa ahorro confirmado a 24 horas para servicio específico
     */
    async procesarAhorro24h(tipoServicio) {
        const ahora = moment().tz('America/Mazatlan');
        const hace24h = ahora.clone().subtract(24, 'hours');

        this.logger.info(`Procesando ahorro confirmado a 24h para ${tipoServicio}`, {
            operation: 'process_24h_savings',
            tipoServicio,
            fechaCorte: hace24h.format('YYYY-MM-DD HH:mm:ss')
        });

        // Obtener analytics pendientes de la tabla unificada
        const analyticsPendientes = await dbGps.querySequelize(`
            SELECT 
                ra.id,
                ra.id_recarga,
                ra.fecha_proceso,
                ra.no_recargados_reportando,
                ra.inversion_evitada,
                ra.tipo_servicio,
                ra.minutos_umbral,
                ra.dias_limite
            FROM recharge_analytics ra
            WHERE ra.fecha_proceso <= ?
                AND ra.ahorro_confirmado_24h IS NULL
                AND ra.tipo_servicio = ?
            ORDER BY ra.fecha_proceso ASC
        `, {
            replacements: [hace24h.format('YYYY-MM-DD HH:mm:ss'), tipoServicio],
            type: dbGps.getSequelizeClient().QueryTypes.SELECT
        });

        let totalActualizados = 0;
        let totalAhorroConfirmado = 0;

        for (const analytics of analyticsPendientes) {
            try {
                // Obtener dispositivos que NO se recargaron en ese proceso
                const dispositivosNoRecargados = await this.obtenerDispositivosNoRecargados(
                    analytics.id_recarga, 
                    analytics.fecha_proceso,
                    tipoServicio
                );

                // Contar cuántos siguen reportando después de 24h de vencidos
                let ahorroConfirmado = 0;
                
                for (const dispositivo of dispositivosNoRecargados) {
                    const sigueReportando = await this.verificarSiSigueReportando(
                        dispositivo,
                        moment(analytics.fecha_proceso).add(24, 'hours').toDate(),
                        tipoServicio
                    );
                    
                    if (sigueReportando) {
                        ahorroConfirmado++;
                    }
                }

                // Calcular ahorro real en pesos según tipo de servicio
                const importeServicio = tipoServicio === 'GPS' ? 10 : 50; // GPS=$10, ELIoT=variable pero promedio $50
                const ahorroRealPesos = ahorroConfirmado * importeServicio;

                await dbGps.querySequelize(`
                    UPDATE recharge_analytics 
                    SET 
                        ahorro_confirmado_24h = ?,
                        ahorro_real_24h_pesos = ?
                    WHERE id = ?
                `, {
                    replacements: [ahorroConfirmado, ahorroRealPesos, analytics.id],
                    type: dbGps.getSequelizeClient().QueryTypes.UPDATE
                });

                totalActualizados++;
                totalAhorroConfirmado += ahorroConfirmado;

                this.logger.info(`Analytics 24h actualizado para ${tipoServicio}`, {
                    operation: 'analytics_24h_updated',
                    tipoServicio,
                    analyticsId: analytics.id,
                    idRecarga: analytics.id_recarga,
                    ahorroConfirmado,
                    ahorroRealPesos
                });

            } catch (error) {
                this.logger.error(`Error procesando analytics 24h para ${tipoServicio}`, error, {
                    operation: 'process_24h_error',
                    tipoServicio,
                    analyticsId: analytics.id
                });
            }
        }

        return {
            registrosActualizados: totalActualizados,
            totalAhorroConfirmado,
            totalAhorroRealPesos: totalAhorroConfirmado * (tipoServicio === 'GPS' ? 10 : 50)
        };
    }

    /**
     * Procesa ahorro confirmado a 48 horas para servicio específico
     */
    async procesarAhorro48h(tipoServicio) {
        const ahora = moment().tz('America/Mazatlan');
        const hace48h = ahora.clone().subtract(48, 'hours');

        const analyticsPendientes = await dbGps.querySequelize(`
            SELECT 
                ra.id,
                ra.id_recarga,
                ra.fecha_proceso,
                ra.ahorro_confirmado_24h,
                ra.tipo_servicio
            FROM recharge_analytics ra
            WHERE ra.fecha_proceso <= ?
                AND ra.ahorro_confirmado_48h IS NULL
                AND ra.ahorro_confirmado_24h IS NOT NULL
                AND ra.tipo_servicio = ?
            ORDER BY ra.fecha_proceso ASC
        `, {
            replacements: [hace48h.format('YYYY-MM-DD HH:mm:ss'), tipoServicio],
            type: dbGps.getSequelizeClient().QueryTypes.SELECT
        });

        let totalActualizados = 0;
        let totalAhorroConfirmado = 0;

        for (const analytics of analyticsPendientes) {
            try {
                const dispositivosNoRecargados = await this.obtenerDispositivosNoRecargados(
                    analytics.id_recarga, 
                    analytics.fecha_proceso,
                    tipoServicio
                );

                let ahorroConfirmado = 0;
                
                for (const dispositivo of dispositivosNoRecargados) {
                    const sigueReportando = await this.verificarSiSigueReportando(
                        dispositivo,
                        moment(analytics.fecha_proceso).add(48, 'hours').toDate(),
                        tipoServicio
                    );
                    
                    if (sigueReportando) {
                        ahorroConfirmado++;
                    }
                }

                const importeServicio = tipoServicio === 'GPS' ? 10 : 50;
                const ahorroRealPesos = ahorroConfirmado * importeServicio;

                await dbGps.querySequelize(`
                    UPDATE recharge_analytics 
                    SET 
                        ahorro_confirmado_48h = ?,
                        ahorro_real_48h_pesos = ?
                    WHERE id = ?
                `, {
                    replacements: [ahorroConfirmado, ahorroRealPesos, analytics.id],
                    type: dbGps.getSequelizeClient().QueryTypes.UPDATE
                });

                totalActualizados++;
                totalAhorroConfirmado += ahorroConfirmado;

            } catch (error) {
                this.logger.error(`Error procesando analytics 48h para ${tipoServicio}`, error, {
                    operation: 'process_48h_error',
                    tipoServicio,
                    analyticsId: analytics.id
                });
            }
        }

        return {
            registrosActualizados: totalActualizados,
            totalAhorroConfirmado,
            totalAhorroRealPesos: totalAhorroConfirmado * (tipoServicio === 'GPS' ? 10 : 50)
        };
    }

    /**
     * Procesa ahorro confirmado a 7 días para servicio específico
     */
    async procesarAhorro7d(tipoServicio) {
        const ahora = moment().tz('America/Mazatlan');
        const hace7d = ahora.clone().subtract(7, 'days');

        const analyticsPendientes = await dbGps.querySequelize(`
            SELECT 
                ra.id,
                ra.id_recarga,
                ra.fecha_proceso,
                ra.ahorro_confirmado_48h,
                ra.tipo_servicio
            FROM recharge_analytics ra
            WHERE ra.fecha_proceso <= ?
                AND ra.ahorro_confirmado_7d IS NULL
                AND ra.ahorro_confirmado_48h IS NOT NULL
                AND ra.tipo_servicio = ?
            ORDER BY ra.fecha_proceso ASC
        `, {
            replacements: [hace7d.format('YYYY-MM-DD HH:mm:ss'), tipoServicio],
            type: dbGps.getSequelizeClient().QueryTypes.SELECT
        });

        let totalActualizados = 0;
        let totalAhorroConfirmado = 0;

        for (const analytics of analyticsPendientes) {
            try {
                const dispositivosNoRecargados = await this.obtenerDispositivosNoRecargados(
                    analytics.id_recarga, 
                    analytics.fecha_proceso,
                    tipoServicio
                );

                let ahorroConfirmado = 0;
                
                for (const dispositivo of dispositivosNoRecargados) {
                    const sigueReportando = await this.verificarSiSigueReportando(
                        dispositivo,
                        moment(analytics.fecha_proceso).add(7, 'days').toDate(),
                        tipoServicio
                    );
                    
                    if (sigueReportando) {
                        ahorroConfirmado++;
                    }
                }

                const importeServicio = tipoServicio === 'GPS' ? 10 : 50;
                const ahorroRealPesos = ahorroConfirmado * importeServicio;

                await dbGps.querySequelize(`
                    UPDATE recharge_analytics 
                    SET 
                        ahorro_confirmado_7d = ?,
                        ahorro_real_7d_pesos = ?
                    WHERE id = ?
                `, {
                    replacements: [ahorroConfirmado, ahorroRealPesos, analytics.id],
                    type: dbGps.getSequelizeClient().QueryTypes.UPDATE
                });

                totalActualizados++;
                totalAhorroConfirmado += ahorroConfirmado;

            } catch (error) {
                this.logger.error(`Error procesando analytics 7d para ${tipoServicio}`, error, {
                    operation: 'process_7d_error',
                    tipoServicio,
                    analyticsId: analytics.id
                });
            }
        }

        return {
            registrosActualizados: totalActualizados,
            totalAhorroConfirmado,
            totalAhorroRealPesos: totalAhorroConfirmado * (tipoServicio === 'GPS' ? 10 : 50)
        };
    }

    /**
     * Obtiene dispositivos que NO se recargaron en un proceso específico por tipo de servicio
     */
    async obtenerDispositivosNoRecargados(idRecarga, fechaProceso, tipoServicio) {
        const fechaProcesoMoment = moment(fechaProceso).tz('America/Mazatlan');
        const finDia = fechaProcesoMoment.endOf('day').unix();
        const fechaStr = fechaProcesoMoment.format('YYYY-MM-DD');

        if (tipoServicio === 'GPS') {
            return await this.obtenerDispositivosGPSNoRecargados(finDia, fechaStr);
        } else if (tipoServicio === 'ELIOT') {
            return await this.obtenerDispositivosELIoTNoRecargados(finDia, fechaStr);
        }
        
        return [];
    }

    /**
     * Obtiene dispositivos GPS que NO se recargaron
     */
    async obtenerDispositivosGPSNoRecargados(finDia, fechaStr) {
        return await dbGps.querySequelize(`
            SELECT DISTINCT
                d.nombre AS dispositivo,
                d.sim,
                d.unix_saldo,
                v.descripcion,
                e.nombre AS empresa
            FROM vehiculos v
            JOIN empresas e ON v.empresa = e.id
            JOIN dispositivos d ON v.dispositivo = d.id
            WHERE d.prepago = 1
                AND v.status = 1
                AND e.status = 1
                AND d.unix_saldo IS NOT NULL
                AND d.unix_saldo <= ?
                AND EXISTS (SELECT 1 FROM track t WHERE t.dispositivo = d.nombre)
                AND NOT EXISTS (
                    SELECT 1 
                    FROM detalle_recargas dr
                    JOIN recargas r ON dr.id_recarga = r.id
                    WHERE dr.sim = d.sim
                        AND dr.status = 1
                        AND DATE(FROM_UNIXTIME(r.fecha)) = ?
                        AND r.tipo = 'rastreo'
                )
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
        `, {
            replacements: [finDia, fechaStr],
            type: dbGps.getSequelizeClient().QueryTypes.SELECT
        });
    }

    /**
     * Obtiene dispositivos ELIoT que NO se recargaron
     */
    async obtenerDispositivosELIoTNoRecargados(finDia, fechaStr) {
        return await dbEliot.querySequelize(`
            SELECT DISTINCT
                a.uuid AS dispositivo,
                a.sim,
                a.fecha_saldo,
                a.descripcion,
                a.nombreEmpresa AS empresa
            FROM agentesEmpresa_view a
            WHERE a.prepago = 1
                AND a.status = 1
                AND a.estadoEmpresa = 1
                AND a.fecha_saldo IS NOT NULL
                AND a.fecha_saldo <= ?
                AND a.comunicacion = 'gsm'
                AND NOT EXISTS (
                    SELECT 1 
                    FROM gps_db.detalle_recargas dr
                    JOIN gps_db.recargas r ON dr.id_recarga = r.id
                    WHERE dr.sim = a.sim
                        AND dr.status = 1
                        AND DATE(FROM_UNIXTIME(r.fecha)) = ?
                        AND r.tipo = 'eliot'
                )
                AND (
                    a.nombreEmpresa NOT LIKE '%stock%'
                    AND a.nombreEmpresa NOT LIKE '%MEXTICOM%'
                    AND a.nombreEmpresa NOT LIKE '%mextic los cabos%'
                    AND a.nombreEmpresa NOT LIKE '%jesar%'
                    AND a.nombreEmpresa NOT LIKE '%distribuidores%'
                    AND a.nombreEmpresa NOT LIKE '%demo%'
                    AND a.nombreEmpresa NOT LIKE '%_old%'
                    AND a.descripcion NOT LIKE '%_old%'
                    AND a.descripcion NOT LIKE '%demo%'
                )
        `, {
            replacements: [finDia, fechaStr],
            type: dbEliot.getSequelizeClient().QueryTypes.SELECT
        });
    }

    /**
     * Verifica si un dispositivo sigue reportando después de una fecha específica
     */
    async verificarSiSigueReportando(dispositivo, fechaCorte, tipoServicio) {
        if (tipoServicio === 'GPS') {
            return await this.verificarReporteGPS(dispositivo.dispositivo, fechaCorte);
        } else if (tipoServicio === 'ELIOT') {
            return await this.verificarReporteELIoT(dispositivo.dispositivo, fechaCorte);
        }
        
        return false;
    }

    /**
     * Verifica reportes GPS en tabla track
     */
    async verificarReporteGPS(dispositivo, fechaCorte) {
        const fechaCorteUnix = Math.floor(fechaCorte.getTime() / 1000);

        const ultimoReporte = await dbGps.querySequelize(`
            SELECT MAX(fecha) as ultima_fecha
            FROM track
            WHERE dispositivo = ?
                AND fecha > ?
        `, {
            replacements: [dispositivo, fechaCorteUnix],
            type: dbGps.getSequelizeClient().QueryTypes.SELECT
        });

        return ultimoReporte[0]?.ultima_fecha != null;
    }

    /**
     * Verifica reportes ELIoT en MongoDB
     */
    async verificarReporteELIoT(uuid, fechaCorte) {
        try {
            const fechaCorteUnix = Math.floor(fechaCorte.getTime() / 1000);
            
            // Consultar última métrica después de fecha corte
            const ultimaMetrica = await consultarMetricaPorUuid(uuid);
            
            if (ultimaMetrica && ultimaMetrica.fecha > fechaCorteUnix) {
                return true;
            }
            
            return false;
            
        } catch (error) {
            this.logger.error('Error verificando reporte ELIoT', error, {
                operation: 'verify_eliot_report_error',
                uuid
            });
            return false;
        }
    }
}

module.exports = RechargeAhorroRealJob;