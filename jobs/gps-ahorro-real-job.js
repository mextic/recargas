/**
 * Job de seguimiento para actualizar ahorro real confirmado
 * Verifica dispositivos que NO se recargaron pero siguen reportando después de vencidos
 * Se ejecuta diariamente para confirmar si el ahorro potencial se convirtió en ahorro real
 */
const moment = require('moment-timezone');
const { initDatabases, dbGps } = require('../lib/database');
const { createServiceLogger } = require('../lib/utils/logger');

class GPSAhorroRealJob {
    constructor() {
        this.logger = createServiceLogger('GPS_AHORRO_REAL_JOB');
    }

    /**
     * Ejecuta el job de seguimiento de ahorro real
     * Actualiza métricas de ahorro confirmado en gps_analytics
     */
    async ejecutar() {
        try {
            await initDatabases();
            this.logger.info('Iniciando job de seguimiento de ahorro real GPS');

            // Procesar ahorro confirmado a diferentes intervalos
            const resultados = {
                ahorro24h: await this.procesarAhorro24h(),
                ahorro48h: await this.procesarAhorro48h(),
                ahorro7d: await this.procesarAhorro7d()
            };

            this.logger.info('Job de ahorro real completado', {
                operation: 'ahorro_real_job_completed',
                resultados
            });

            return resultados;

        } catch (error) {
            this.logger.error('Error en job de ahorro real', error);
            throw error;
        }
    }

    /**
     * Procesa ahorro confirmado a 24 horas
     * Actualiza registros donde ahorro_confirmado_24h es NULL
     */
    async procesarAhorro24h() {
        const ahora = moment().tz('America/Mazatlan');
        const hace24h = ahora.clone().subtract(24, 'hours');

        this.logger.info('Procesando ahorro confirmado a 24h', {
            operation: 'process_24h_savings',
            fechaCorte: hace24h.format('YYYY-MM-DD HH:mm:ss')
        });

        // Obtener analytics pendientes de actualización (>24h sin actualizar)
        const analyticsPendientes = await dbGps.querySequelize(`
            SELECT 
                ga.id,
                ga.id_recarga,
                ga.fecha_proceso,
                ga.no_recargados_reportando,
                ga.inversion_evitada
            FROM gps_analytics ga
            WHERE ga.fecha_proceso <= ?
                AND ga.ahorro_confirmado_24h IS NULL
            ORDER BY ga.fecha_proceso ASC
        `, {
            replacements: [hace24h.format('YYYY-MM-DD HH:mm:ss')],
            type: dbGps.getSequelizeClient().QueryTypes.SELECT
        });

        let totalActualizados = 0;
        let totalAhorroConfirmado = 0;

        for (const analytics of analyticsPendientes) {
            try {
                // Obtener dispositivos que NO se recargaron en ese proceso
                const dispositivosNoRecargados = await this.obtenerDispositivosNoRecargados(
                    analytics.id_recarga, 
                    analytics.fecha_proceso
                );

                // Contar cuántos siguen reportando después de 24h de vencidos
                let ahorroConfirmado = 0;
                
                for (const dispositivo of dispositivosNoRecargados) {
                    const sigueReportando = await this.verificarSiSigueReportando(
                        dispositivo.dispositivo,
                        moment(analytics.fecha_proceso).add(24, 'hours').toDate()
                    );
                    
                    if (sigueReportando) {
                        ahorroConfirmado++;
                    }
                }

                // Actualizar analytics con ahorro confirmado
                const ahorroRealPesos = ahorroConfirmado * 10; // $10 por dispositivo

                await dbGps.querySequelize(`
                    UPDATE gps_analytics 
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

                this.logger.info('Analytics 24h actualizado', {
                    operation: 'analytics_24h_updated',
                    analyticsId: analytics.id,
                    idRecarga: analytics.id_recarga,
                    ahorroConfirmado,
                    ahorroRealPesos
                });

            } catch (error) {
                this.logger.error('Error procesando analytics 24h', error, {
                    operation: 'process_24h_error',
                    analyticsId: analytics.id
                });
            }
        }

        return {
            registrosActualizados: totalActualizados,
            totalAhorroConfirmado,
            totalAhorroRealPesos: totalAhorroConfirmado * 10
        };
    }

    /**
     * Procesa ahorro confirmado a 48 horas
     */
    async procesarAhorro48h() {
        const ahora = moment().tz('America/Mazatlan');
        const hace48h = ahora.clone().subtract(48, 'hours');

        // Similar al de 24h pero para 48h
        const analyticsPendientes = await dbGps.querySequelize(`
            SELECT 
                ga.id,
                ga.id_recarga,
                ga.fecha_proceso,
                ga.ahorro_confirmado_24h
            FROM gps_analytics ga
            WHERE ga.fecha_proceso <= ?
                AND ga.ahorro_confirmado_48h IS NULL
                AND ga.ahorro_confirmado_24h IS NOT NULL
            ORDER BY ga.fecha_proceso ASC
        `, {
            replacements: [hace48h.format('YYYY-MM-DD HH:mm:ss')],
            type: dbGps.getSequelizeClient().QueryTypes.SELECT
        });

        let totalActualizados = 0;
        let totalAhorroConfirmado = 0;

        for (const analytics of analyticsPendientes) {
            try {
                const dispositivosNoRecargados = await this.obtenerDispositivosNoRecargados(
                    analytics.id_recarga, 
                    analytics.fecha_proceso
                );

                let ahorroConfirmado = 0;
                
                for (const dispositivo of dispositivosNoRecargados) {
                    const sigueReportando = await this.verificarSiSigueReportando(
                        dispositivo.dispositivo,
                        moment(analytics.fecha_proceso).add(48, 'hours').toDate()
                    );
                    
                    if (sigueReportando) {
                        ahorroConfirmado++;
                    }
                }

                const ahorroRealPesos = ahorroConfirmado * 10;

                await dbGps.querySequelize(`
                    UPDATE gps_analytics 
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
                this.logger.error('Error procesando analytics 48h', error, {
                    operation: 'process_48h_error',
                    analyticsId: analytics.id
                });
            }
        }

        return {
            registrosActualizados: totalActualizados,
            totalAhorroConfirmado,
            totalAhorroRealPesos: totalAhorroConfirmado * 10
        };
    }

    /**
     * Procesa ahorro confirmado a 7 días
     */
    async procesarAhorro7d() {
        const ahora = moment().tz('America/Mazatlan');
        const hace7d = ahora.clone().subtract(7, 'days');

        const analyticsPendientes = await dbGps.querySequelize(`
            SELECT 
                ga.id,
                ga.id_recarga,
                ga.fecha_proceso,
                ga.ahorro_confirmado_48h
            FROM gps_analytics ga
            WHERE ga.fecha_proceso <= ?
                AND ga.ahorro_confirmado_7d IS NULL
                AND ga.ahorro_confirmado_48h IS NOT NULL
            ORDER BY ga.fecha_proceso ASC
        `, {
            replacements: [hace7d.format('YYYY-MM-DD HH:mm:ss')],
            type: dbGps.getSequelizeClient().QueryTypes.SELECT
        });

        let totalActualizados = 0;
        let totalAhorroConfirmado = 0;

        for (const analytics of analyticsPendientes) {
            try {
                const dispositivosNoRecargados = await this.obtenerDispositivosNoRecargados(
                    analytics.id_recarga, 
                    analytics.fecha_proceso
                );

                let ahorroConfirmado = 0;
                
                for (const dispositivo of dispositivosNoRecargados) {
                    const sigueReportando = await this.verificarSiSigueReportando(
                        dispositivo.dispositivo,
                        moment(analytics.fecha_proceso).add(7, 'days').toDate()
                    );
                    
                    if (sigueReportando) {
                        ahorroConfirmado++;
                    }
                }

                const ahorroRealPesos = ahorroConfirmado * 10;

                await dbGps.querySequelize(`
                    UPDATE gps_analytics 
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
                this.logger.error('Error procesando analytics 7d', error, {
                    operation: 'process_7d_error',
                    analyticsId: analytics.id
                });
            }
        }

        return {
            registrosActualizados: totalActualizados,
            totalAhorroConfirmado,
            totalAhorroRealPesos: totalAhorroConfirmado * 10
        };
    }

    /**
     * Obtiene dispositivos que NO se recargaron en un proceso específico
     */
    async obtenerDispositivosNoRecargados(idRecarga, fechaProceso) {
        // Obtener dispositivos que estaban vencidos/por vencer pero NO se recargaron
        // Esto requiere reconstruir la lógica del algoritmo para esa fecha
        
        const fechaProcesoMoment = moment(fechaProceso).tz('America/Mazatlan');
        const finDia = fechaProcesoMoment.endOf('day').unix();
        const fechaStr = fechaProcesoMoment.format('YYYY-MM-DD');

        // Obtener dispositivos que cumplían criterios pero NO tienen recarga en esa fecha
        const dispositivosNoRecargados = await dbGps.querySequelize(`
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

        return dispositivosNoRecargados;
    }

    /**
     * Verifica si un dispositivo sigue reportando después de una fecha específica
     */
    async verificarSiSigueReportando(dispositivo, fechaCorte) {
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
}

module.exports = GPSAhorroRealJob;