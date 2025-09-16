/**
 * RechargeAnalyticsReporter - Generador de reportes analíticos unificados
 * Facilita la ejecución de queries de analytics comparativos entre GPS y ELIoT
 * Usa la tabla unificada recharge_analytics
 */
const fs = require('fs');
const path = require('path');
const moment = require('moment-timezone');

class RechargeAnalyticsReporter {
    constructor(dbConnection) {
        this.db = dbConnection;
        this.timezone = 'America/Mazatlan';
    }

    /**
     * Obtiene resumen comparativo entre servicios
     */
    async getComparativoServicios(dias = 30) {
        return await this.db.querySequelize(`
            SELECT 
                tipo_servicio,
                COUNT(*) as procesos_realizados,
                SUM(total_candidatos) as dispositivos_evaluados,
                SUM(recargas_exitosas) as dispositivos_recargados,
                SUM(no_recargados_reportando) as ahorro_inmediato,
                SUM(inversion_realizada) as inversion_total,
                SUM(inversion_evitada) as ahorro_potencial,
                SUM(COALESCE(ahorro_real_7d_pesos, 0)) as ahorro_real_confirmado,
                
                -- Métricas de eficiencia
                AVG(tasa_exito_porcentaje) as tasa_exito_promedio,
                AVG(ahorro_potencial_porcentaje) as eficiencia_algoritmo,
                
                -- ROI por servicio
                CASE 
                    WHEN SUM(inversion_realizada) > 0 
                    THEN ROUND((SUM(COALESCE(ahorro_real_7d_pesos, 0)) / SUM(inversion_realizada)) * 100, 2)
                    ELSE 0 
                END as roi_porcentaje,
                
                -- Precisión del algoritmo
                CASE 
                    WHEN SUM(no_recargados_reportando) > 0 
                    THEN ROUND((SUM(COALESCE(ahorro_confirmado_7d, 0)) / SUM(no_recargados_reportando)) * 100, 2)
                    ELSE 0 
                END as precision_algoritmo_porcentaje
                
            FROM recharge_analytics
            WHERE fecha_proceso >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
            GROUP BY tipo_servicio
            ORDER BY tipo_servicio
        `, {
            replacements: [dias],
            type: this.db.getSequelizeClient().QueryTypes.SELECT
        });
    }

    /**
     * Obtiene tendencia diaria comparativa
     */
    async getTendenciaDiariaComparativa(dias = 14) {
        return await this.db.querySequelize(`
            SELECT 
                DATE(fecha_proceso) as fecha,
                tipo_servicio,
                COUNT(*) as procesos_dia,
                SUM(total_candidatos) as dispositivos_evaluados,
                SUM(recargas_exitosas) as recargas_exitosas,
                SUM(no_recargados_reportando) as ahorro_inmediato,
                SUM(inversion_realizada) as inversion_realizada,
                SUM(inversion_evitada) as ahorro_potencial,
                SUM(COALESCE(ahorro_real_7d_pesos, 0)) as ahorro_real_confirmado,
                AVG(ahorro_potencial_porcentaje) as eficiencia_promedio
                
            FROM recharge_analytics
            WHERE fecha_proceso >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
            GROUP BY DATE(fecha_proceso), tipo_servicio
            ORDER BY fecha DESC, tipo_servicio
        `, {
            replacements: [dias],
            type: this.db.getSequelizeClient().QueryTypes.SELECT
        });
    }

    /**
     * Obtiene resumen ejecutivo unificado
     */
    async getResumenEjecutivoUnificado() {
        return await this.db.querySequelize(`
            SELECT 
                'AMBOS SERVICIOS' as servicio,
                MIN(DATE(fecha_proceso)) as fecha_inicio,
                MAX(DATE(fecha_proceso)) as fecha_fin,
                
                -- Totales combinados
                SUM(total_candidatos) as dispositivos_evaluados_total,
                SUM(recargas_exitosas) as dispositivos_recargados_total,
                SUM(no_recargados_reportando) as dispositivos_ahorro_potencial_total,
                
                -- Financiero combinado
                SUM(inversion_realizada) as inversion_total_combinada,
                SUM(inversion_evitada) as ahorro_potencial_total_combinado,
                SUM(COALESCE(ahorro_real_7d_pesos, 0)) as ahorro_real_confirmado_combinado,
                
                -- Eficiencia general
                ROUND(AVG(ahorro_potencial_porcentaje), 2) as eficiencia_algoritmo_promedio,
                ROUND(AVG(tasa_exito_porcentaje), 2) as tasa_exito_recargas_promedio,
                
                -- ROI combinado
                CASE 
                    WHEN SUM(inversion_realizada) > 0 
                    THEN ROUND((SUM(COALESCE(ahorro_real_7d_pesos, 0)) / SUM(inversion_realizada)) * 100, 2)
                    ELSE 0 
                END as roi_combinado_porcentaje,
                
                -- Precisión del algoritmo combinado
                CASE 
                    WHEN SUM(no_recargados_reportando) > 0 
                    THEN ROUND((SUM(COALESCE(ahorro_confirmado_7d, 0)) / SUM(no_recargados_reportando)) * 100, 2)
                    ELSE 0 
                END as precision_algoritmo_combinado_porcentaje
                
            FROM recharge_analytics
            WHERE fecha_proceso >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
        `, {
            type: this.db.getSequelizeClient().QueryTypes.SELECT
        });
    }

    /**
     * Obtiene análisis de efectividad por servicio
     */
    async getEfectividadPorServicio() {
        return await this.db.querySequelize(`
            SELECT 
                tipo_servicio,
                version_algoritmo,
                minutos_umbral,
                dias_limite,
                
                -- Totales
                COUNT(*) as total_procesos,
                SUM(total_candidatos) as total_dispositivos,
                SUM(no_recargados_reportando) as total_ahorro_potencial,
                
                -- Ahorro real por período
                SUM(COALESCE(ahorro_confirmado_24h, 0)) as ahorro_real_24h,
                SUM(COALESCE(ahorro_confirmado_48h, 0)) as ahorro_real_48h,
                SUM(COALESCE(ahorro_confirmado_7d, 0)) as ahorro_real_7d,
                
                -- Tasas de confirmación de ahorro
                CASE 
                    WHEN SUM(no_recargados_reportando) > 0 
                    THEN ROUND((SUM(COALESCE(ahorro_confirmado_24h, 0)) / SUM(no_recargados_reportando)) * 100, 2)
                    ELSE 0 
                END as tasa_confirmacion_24h,
                
                CASE 
                    WHEN SUM(no_recargados_reportando) > 0 
                    THEN ROUND((SUM(COALESCE(ahorro_confirmado_7d, 0)) / SUM(no_recargados_reportando)) * 100, 2)
                    ELSE 0 
                END as tasa_confirmacion_7d,
                
                -- Ahorro real en pesos
                SUM(COALESCE(ahorro_real_7d_pesos, 0)) as ahorro_real_total_pesos,
                
                -- Eficiencia promedio
                ROUND(AVG(ahorro_potencial_porcentaje), 2) as eficiencia_promedio,
                
                -- Campos específicos
                AVG(CASE WHEN tipo_servicio = 'ELIOT' THEN mongo_query_time_ms ELSE NULL END) as tiempo_mongo_promedio_ms
                
            FROM recharge_analytics
            WHERE fecha_proceso >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
            GROUP BY tipo_servicio, version_algoritmo, minutos_umbral, dias_limite
            ORDER BY tipo_servicio, version_algoritmo DESC
        `, {
            type: this.db.getSequelizeClient().QueryTypes.SELECT
        });
    }

    /**
     * Obtiene comparativa mensual por servicio
     */
    async getComparativaMensualServicios(meses = 6) {
        return await this.db.querySequelize(`
            SELECT 
                YEAR(fecha_proceso) as año,
                MONTH(fecha_proceso) as mes,
                MONTHNAME(fecha_proceso) as nombre_mes,
                tipo_servicio,
                
                -- Métricas por servicio
                SUM(inversion_realizada) as inversion_total,
                SUM(recargas_exitosas) as dispositivos_recargados,
                SUM(inversion_evitada) as ahorro_potencial_total,
                SUM(no_recargados_reportando) as dispositivos_no_recargados,
                SUM(COALESCE(ahorro_real_7d_pesos, 0)) as ahorro_real_confirmado,
                SUM(COALESCE(ahorro_confirmado_7d, 0)) as dispositivos_ahorro_real,
                
                -- ROI y eficiencia por servicio
                CASE 
                    WHEN SUM(inversion_realizada) > 0 
                    THEN ROUND((SUM(COALESCE(ahorro_real_7d_pesos, 0)) / SUM(inversion_realizada)) * 100, 2)
                    ELSE 0 
                END as roi_porcentaje,
                
                CASE 
                    WHEN SUM(total_candidatos) > 0 
                    THEN ROUND((SUM(no_recargados_reportando) / SUM(total_candidatos)) * 100, 2)
                    ELSE 0 
                END as eficiencia_algoritmo
                
            FROM recharge_analytics
            WHERE fecha_proceso >= DATE_SUB(CURDATE(), INTERVAL ? MONTH)
            GROUP BY YEAR(fecha_proceso), MONTH(fecha_proceso), tipo_servicio
            ORDER BY año DESC, mes DESC, tipo_servicio
        `, {
            replacements: [meses],
            type: this.db.getSequelizeClient().QueryTypes.SELECT
        });
    }

    /**
     * Obtiene dashboard unificado con métricas en tiempo real
     */
    async getDashboardUnificado() {
        const resultado = await this.db.querySequelize(`
            SELECT 
                -- Métricas de hoy por servicio
                (SELECT COUNT(*) FROM recharge_analytics WHERE DATE(fecha_proceso) = CURDATE() AND tipo_servicio = 'GPS') as procesos_gps_hoy,
                (SELECT COUNT(*) FROM recharge_analytics WHERE DATE(fecha_proceso) = CURDATE() AND tipo_servicio = 'ELIOT') as procesos_eliot_hoy,
                (SELECT SUM(recargas_exitosas) FROM recharge_analytics WHERE DATE(fecha_proceso) = CURDATE() AND tipo_servicio = 'GPS') as recargas_gps_hoy,
                (SELECT SUM(recargas_exitosas) FROM recharge_analytics WHERE DATE(fecha_proceso) = CURDATE() AND tipo_servicio = 'ELIOT') as recargas_eliot_hoy,
                (SELECT SUM(no_recargados_reportando) FROM recharge_analytics WHERE DATE(fecha_proceso) = CURDATE() AND tipo_servicio = 'GPS') as ahorro_gps_hoy,
                (SELECT SUM(no_recargados_reportando) FROM recharge_analytics WHERE DATE(fecha_proceso) = CURDATE() AND tipo_servicio = 'ELIOT') as ahorro_eliot_hoy,
                (SELECT SUM(inversion_realizada) FROM recharge_analytics WHERE DATE(fecha_proceso) = CURDATE() AND tipo_servicio = 'GPS') as inversion_gps_hoy,
                (SELECT SUM(inversion_realizada) FROM recharge_analytics WHERE DATE(fecha_proceso) = CURDATE() AND tipo_servicio = 'ELIOT') as inversion_eliot_hoy,
                
                -- Métricas del mes por servicio
                (SELECT SUM(recargas_exitosas) FROM recharge_analytics WHERE MONTH(fecha_proceso) = MONTH(CURDATE()) AND YEAR(fecha_proceso) = YEAR(CURDATE()) AND tipo_servicio = 'GPS') as recargas_gps_mes,
                (SELECT SUM(recargas_exitosas) FROM recharge_analytics WHERE MONTH(fecha_proceso) = MONTH(CURDATE()) AND YEAR(fecha_proceso) = YEAR(CURDATE()) AND tipo_servicio = 'ELIOT') as recargas_eliot_mes,
                (SELECT SUM(inversion_realizada) FROM recharge_analytics WHERE MONTH(fecha_proceso) = MONTH(CURDATE()) AND YEAR(fecha_proceso) = YEAR(CURDATE()) AND tipo_servicio = 'GPS') as inversion_gps_mes,
                (SELECT SUM(inversion_realizada) FROM recharge_analytics WHERE MONTH(fecha_proceso) = MONTH(CURDATE()) AND YEAR(fecha_proceso) = YEAR(CURDATE()) AND tipo_servicio = 'ELIOT') as inversion_eliot_mes,
                (SELECT SUM(COALESCE(ahorro_real_7d_pesos, 0)) FROM recharge_analytics WHERE MONTH(fecha_proceso) = MONTH(CURDATE()) AND YEAR(fecha_proceso) = YEAR(CURDATE()) AND tipo_servicio = 'GPS') as ahorro_real_gps_mes,
                (SELECT SUM(COALESCE(ahorro_real_7d_pesos, 0)) FROM recharge_analytics WHERE MONTH(fecha_proceso) = MONTH(CURDATE()) AND YEAR(fecha_proceso) = YEAR(CURDATE()) AND tipo_servicio = 'ELIOT') as ahorro_real_eliot_mes,
                
                -- Eficiencia general combinada
                (SELECT AVG(ahorro_potencial_porcentaje) FROM recharge_analytics WHERE fecha_proceso >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)) as eficiencia_ultima_semana_combinada,
                (SELECT AVG(ahorro_potencial_porcentaje) FROM recharge_analytics WHERE fecha_proceso >= DATE_SUB(CURDATE(), INTERVAL 7 DAY) AND tipo_servicio = 'GPS') as eficiencia_gps_ultima_semana,
                (SELECT AVG(ahorro_potencial_porcentaje) FROM recharge_analytics WHERE fecha_proceso >= DATE_SUB(CURDATE(), INTERVAL 7 DAY) AND tipo_servicio = 'ELIOT') as eficiencia_eliot_ultima_semana
        `, {
            type: this.db.getSequelizeClient().QueryTypes.SELECT
        });

        return resultado[0] || {};
    }

    /**
     * Obtiene ranking de eficiencia por configuración
     */
    async getRankingEficiencia() {
        return await this.db.querySequelize(`
            SELECT 
                tipo_servicio,
                minutos_umbral,
                dias_limite,
                
                -- Métricas de eficiencia
                COUNT(*) as total_procesos,
                SUM(total_candidatos) as dispositivos_evaluados,
                SUM(no_recargados_reportando) as ahorro_potencial,
                AVG(ahorro_potencial_porcentaje) as eficiencia_promedio,
                
                -- Ahorro real
                SUM(COALESCE(ahorro_confirmado_7d, 0)) as ahorro_real_dispositivos,
                SUM(COALESCE(ahorro_real_7d_pesos, 0)) as ahorro_real_pesos,
                
                -- Precisión del algoritmo
                CASE 
                    WHEN SUM(no_recargados_reportando) > 0 
                    THEN ROUND((SUM(COALESCE(ahorro_confirmado_7d, 0)) / SUM(no_recargados_reportando)) * 100, 2)
                    ELSE 0 
                END as precision_porcentaje,
                
                -- Score combinado (eficiencia * precisión)
                CASE 
                    WHEN SUM(no_recargados_reportando) > 0 
                    THEN ROUND(AVG(ahorro_potencial_porcentaje) * ((SUM(COALESCE(ahorro_confirmado_7d, 0)) / SUM(no_recargados_reportando)) * 100) / 100, 2)
                    ELSE 0 
                END as score_combinado
                
            FROM recharge_analytics
            WHERE fecha_proceso >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
            GROUP BY tipo_servicio, minutos_umbral, dias_limite
            HAVING total_procesos >= 5  -- Mínimo 5 procesos para ser considerado
            ORDER BY score_combinado DESC, eficiencia_promedio DESC
        `, {
            type: this.db.getSequelizeClient().QueryTypes.SELECT
        });
    }

    /**
     * Genera reporte comparativo completo
     */
    async generateComparativeReport() {
        const ahora = moment().tz(this.timezone);
        
        return {
            metadata: {
                generated_at: ahora.format('YYYY-MM-DD HH:mm:ss'),
                timezone: this.timezone,
                report_type: 'unified_recharge_analytics_comparative'
            },
            dashboard_unificado: await this.getDashboardUnificado(),
            resumen_ejecutivo_unificado: await this.getResumenEjecutivoUnificado(),
            comparativo_servicios: await this.getComparativoServicios(30),
            tendencia_diaria_comparativa: await this.getTendenciaDiariaComparativa(14),
            efectividad_por_servicio: await this.getEfectividadPorServicio(),
            comparativa_mensual_servicios: await this.getComparativaMensualServicios(6),
            ranking_eficiencia: await this.getRankingEficiencia()
        };
    }

    /**
     * Genera reporte en formato de texto legible
     */
    async generateComparativeTextReport() {
        const data = await this.generateComparativeReport();
        const ahora = moment().tz(this.timezone);
        
        let report = '';
        report += '=========================================================\n';
        report += '     REPORTE COMPARATIVO GPS vs ELIoT OPTIMIZATION\n';
        report += '=========================================================\n';
        report += `Generado: ${ahora.format('YYYY-MM-DD HH:mm:ss')} (${this.timezone})\n\n`;
        
        // Dashboard unificado
        const dashboard = data.dashboard_unificado;
        report += '📊 DASHBOARD UNIFICADO - MÉTRICAS EN TIEMPO REAL\n';
        report += '-----------------------------------------------\n';
        report += '📍 HOY:\n';
        report += `  GPS - Procesos: ${dashboard.procesos_gps_hoy || 0} | Recargas: ${dashboard.recargas_gps_hoy || 0} | Ahorro: ${dashboard.ahorro_gps_hoy || 0} | Inversión: $${dashboard.inversion_gps_hoy || 0}\n`;
        report += `  ELIoT - Procesos: ${dashboard.procesos_eliot_hoy || 0} | Recargas: ${dashboard.recargas_eliot_hoy || 0} | Ahorro: ${dashboard.ahorro_eliot_hoy || 0} | Inversión: $${dashboard.inversion_eliot_hoy || 0}\n\n`;
        report += '📅 ESTE MES:\n';
        report += `  GPS - Recargas: ${dashboard.recargas_gps_mes || 0} | Inversión: $${dashboard.inversion_gps_mes || 0} | Ahorro Real: $${dashboard.ahorro_real_gps_mes || 0}\n`;
        report += `  ELIoT - Recargas: ${dashboard.recargas_eliot_mes || 0} | Inversión: $${dashboard.inversion_eliot_mes || 0} | Ahorro Real: $${dashboard.ahorro_real_eliot_mes || 0}\n\n`;
        report += '📈 EFICIENCIA ÚLTIMA SEMANA:\n';
        report += `  Combinada: ${(dashboard.eficiencia_ultima_semana_combinada || 0).toFixed(1)}%\n`;
        report += `  GPS: ${(dashboard.eficiencia_gps_ultima_semana || 0).toFixed(1)}%\n`;
        report += `  ELIoT: ${(dashboard.eficiencia_eliot_ultima_semana || 0).toFixed(1)}%\n\n`;
        
        // Resumen ejecutivo unificado
        const resumen = data.resumen_ejecutivo_unificado[0] || {};
        report += '📈 RESUMEN EJECUTIVO UNIFICADO - ÚLTIMO MES\n';
        report += '-------------------------------------------\n';
        report += `Período: ${resumen.fecha_inicio} a ${resumen.fecha_fin}\n`;
        report += `Dispositivos evaluados (total): ${resumen.dispositivos_evaluados_total || 0}\n`;
        report += `Dispositivos recargados (total): ${resumen.dispositivos_recargados_total || 0}\n`;
        report += `Dispositivos ahorro potencial (total): ${resumen.dispositivos_ahorro_potencial_total || 0}\n`;
        report += `Inversión total combinada: $${resumen.inversion_total_combinada || 0}\n`;
        report += `Ahorro potencial combinado: $${resumen.ahorro_potencial_total_combinado || 0}\n`;
        report += `Ahorro real confirmado combinado: $${resumen.ahorro_real_confirmado_combinado || 0}\n`;
        report += `Eficiencia algoritmo promedio: ${resumen.eficiencia_algoritmo_promedio || 0}%\n`;
        report += `Tasa éxito recargas promedio: ${resumen.tasa_exito_recargas_promedio || 0}%\n`;
        report += `ROI combinado: ${resumen.roi_combinado_porcentaje || 0}%\n`;
        report += `Precisión algoritmo combinada: ${resumen.precision_algoritmo_combinado_porcentaje || 0}%\n\n`;
        
        // Comparativo por servicios
        report += '⚖️ COMPARATIVO ENTRE SERVICIOS (Últimos 30 días)\n';
        report += '------------------------------------------------\n';
        const comparativo = data.comparativo_servicios;
        comparativo.forEach(servicio => {
            report += `${servicio.tipo_servicio}:\n`;
            report += `  • Procesos realizados: ${servicio.procesos_realizados}\n`;
            report += `  • Dispositivos evaluados: ${servicio.dispositivos_evaluados}\n`;
            report += `  • Dispositivos recargados: ${servicio.dispositivos_recargados}\n`;
            report += `  • Ahorro inmediato: ${servicio.ahorro_inmediato} dispositivos\n`;
            report += `  • Inversión total: $${servicio.inversion_total}\n`;
            report += `  • Ahorro potencial: $${servicio.ahorro_potencial}\n`;
            report += `  • Ahorro real confirmado: $${servicio.ahorro_real_confirmado}\n`;
            report += `  • Tasa éxito: ${servicio.tasa_exito_promedio.toFixed(1)}%\n`;
            report += `  • Eficiencia algoritmo: ${servicio.eficiencia_algoritmo.toFixed(1)}%\n`;
            report += `  • ROI: ${servicio.roi_porcentaje}%\n`;
            report += `  • Precisión algoritmo: ${servicio.precision_algoritmo_porcentaje}%\n\n`;
        });
        
        // Ranking de eficiencia
        report += '🏆 RANKING DE CONFIGURACIONES MÁS EFICIENTES\n';
        report += '---------------------------------------------\n';
        const ranking = data.ranking_eficiencia;
        ranking.slice(0, 5).forEach((config, index) => {
            report += `${index + 1}. ${config.tipo_servicio} (${config.minutos_umbral}min, ${config.dias_limite}d):\n`;
            report += `   Score: ${config.score_combinado} | Eficiencia: ${config.eficiencia_promedio.toFixed(1)}% | Precisión: ${config.precision_porcentaje}%\n`;
            report += `   Ahorro real: ${config.ahorro_real_dispositivos} dispositivos ($${config.ahorro_real_pesos})\n\n`;
        });
        
        return report;
    }

    /**
     * Guarda reporte comparativo en archivo
     */
    async saveComparativeReport(formato = 'json', archivo = null) {
        const ahora = moment().tz(this.timezone);
        const timestamp = ahora.format('YYYY-MM-DD_HH-mm-ss');
        
        let contenido, extension, nombreArchivo;
        
        if (formato === 'json') {
            contenido = JSON.stringify(await this.generateComparativeReport(), null, 2);
            extension = 'json';
        } else {
            contenido = await this.generateComparativeTextReport();
            extension = 'txt';
        }
        
        nombreArchivo = archivo || `comparative_analytics_report_${timestamp}.${extension}`;
        const rutaCompleta = path.join(__dirname, '../../reports', nombreArchivo);
        
        // Crear directorio si no existe
        const dirReports = path.dirname(rutaCompleta);
        if (!fs.existsSync(dirReports)) {
            fs.mkdirSync(dirReports, { recursive: true });
        }
        
        fs.writeFileSync(rutaCompleta, contenido, 'utf8');
        
        return {
            archivo: nombreArchivo,
            ruta: rutaCompleta,
            tamaño: contenido.length,
            formato
        };
    }

    /**
     * Obtiene solo métricas de GPS (compatibilidad con reportes existentes)
     */
    async getGPSMetrics(dias = 30) {
        return await this.db.querySequelize(`
            SELECT 
                DATE(fecha_proceso) as fecha,
                COUNT(*) as procesos_dia,
                SUM(total_candidatos) as total_dispositivos_evaluados,
                SUM(recargas_exitosas) as total_recargas_exitosas,
                SUM(no_recargados_reportando) as total_ahorro_inmediato,
                SUM(inversion_realizada) as total_inversion_pesos,
                SUM(inversion_evitada) as total_ahorro_potencial_pesos,
                SUM(COALESCE(ahorro_confirmado_24h, 0)) as ahorro_real_24h_dispositivos,
                SUM(COALESCE(ahorro_real_24h_pesos, 0)) as ahorro_real_24h_pesos,
                SUM(COALESCE(ahorro_confirmado_7d, 0)) as ahorro_real_7d_dispositivos,
                SUM(COALESCE(ahorro_real_7d_pesos, 0)) as ahorro_real_7d_pesos,
                AVG(tasa_exito_porcentaje) as tasa_exito_promedio,
                AVG(ahorro_potencial_porcentaje) as eficiencia_algoritmo_promedio,
                CASE 
                    WHEN SUM(no_recargados_reportando) > 0 
                    THEN (SUM(COALESCE(ahorro_confirmado_7d, 0)) / SUM(no_recargados_reportando)) * 100
                    ELSE 0 
                END as porcentaje_ahorro_confirmado
                
            FROM recharge_analytics
            WHERE fecha_proceso >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
                AND tipo_servicio = 'GPS'
            GROUP BY DATE(fecha_proceso)
            ORDER BY fecha DESC
        `, {
            replacements: [dias],
            type: this.db.getSequelizeClient().QueryTypes.SELECT
        });
    }

    /**
     * Obtiene solo métricas de ELIoT
     */
    async getELIoTMetrics(dias = 30) {
        return await this.db.querySequelize(`
            SELECT 
                DATE(fecha_proceso) as fecha,
                COUNT(*) as procesos_dia,
                SUM(total_candidatos) as total_dispositivos_evaluados,
                SUM(recargas_exitosas) as total_recargas_exitosas,
                SUM(no_recargados_reportando) as total_ahorro_inmediato,
                SUM(inversion_realizada) as total_inversion_pesos,
                SUM(inversion_evitada) as total_ahorro_potencial_pesos,
                SUM(COALESCE(ahorro_confirmado_24h, 0)) as ahorro_real_24h_dispositivos,
                SUM(COALESCE(ahorro_real_24h_pesos, 0)) as ahorro_real_24h_pesos,
                SUM(COALESCE(ahorro_confirmado_7d, 0)) as ahorro_real_7d_dispositivos,
                SUM(COALESCE(ahorro_real_7d_pesos, 0)) as ahorro_real_7d_pesos,
                AVG(tasa_exito_porcentaje) as tasa_exito_promedio,
                AVG(ahorro_potencial_porcentaje) as eficiencia_algoritmo_promedio,
                AVG(COALESCE(mongo_query_time_ms, 0)) as tiempo_mongo_promedio_ms,
                CASE 
                    WHEN SUM(no_recargados_reportando) > 0 
                    THEN (SUM(COALESCE(ahorro_confirmado_7d, 0)) / SUM(no_recargados_reportando)) * 100
                    ELSE 0 
                END as porcentaje_ahorro_confirmado
                
            FROM recharge_analytics
            WHERE fecha_proceso >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
                AND tipo_servicio = 'ELIOT'
            GROUP BY DATE(fecha_proceso)
            ORDER BY fecha DESC
        `, {
            replacements: [dias],
            type: this.db.getSequelizeClient().QueryTypes.SELECT
        });
    }
}

module.exports = RechargeAnalyticsReporter;