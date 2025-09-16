/**
 * GPSAnalyticsReporter - Generador de reportes analíticos GPS
 * Facilita la ejecución de queries de analytics y generación de reportes
 */
const fs = require('fs');
const path = require('path');
const moment = require('moment-timezone');

class GPSAnalyticsReporter {
    constructor(dbConnection) {
        this.db = dbConnection;
        this.timezone = 'America/Mazatlan';
    }

    /**
     * Obtiene resumen diario de ahorro
     */
    async getResumenDiario(dias = 30) {
        return await this.db.querySequelize(`
            SELECT 
                DATE(fecha_proceso) as fecha,
                COUNT(*) as procesos_dia,
                SUM(total_candidatos) as total_dispositivos_evaluados,
                SUM(recargas_exitosas) as total_recargas_exitosas,
                SUM(no_recargados_reportando) as total_ahorro_inmediato,
                SUM(inversion_realizada) as total_inversion_pesos,
                SUM(inversion_evitada) as total_ahorro_potencial_pesos,
                
                -- Ahorro real confirmado
                SUM(COALESCE(ahorro_confirmado_24h, 0)) as ahorro_real_24h_dispositivos,
                SUM(COALESCE(ahorro_real_24h_pesos, 0)) as ahorro_real_24h_pesos,
                SUM(COALESCE(ahorro_confirmado_7d, 0)) as ahorro_real_7d_dispositivos,
                SUM(COALESCE(ahorro_real_7d_pesos, 0)) as ahorro_real_7d_pesos,
                
                -- Métricas de eficiencia
                AVG(tasa_exito_porcentaje) as tasa_exito_promedio,
                AVG(ahorro_potencial_porcentaje) as eficiencia_algoritmo_promedio,
                
                -- Confirmación de ahorro
                CASE 
                    WHEN SUM(no_recargados_reportando) > 0 
                    THEN (SUM(COALESCE(ahorro_confirmado_7d, 0)) / SUM(no_recargados_reportando)) * 100
                    ELSE 0 
                END as porcentaje_ahorro_confirmado
                
            FROM gps_analytics
            WHERE fecha_proceso >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
            GROUP BY DATE(fecha_proceso)
            ORDER BY fecha DESC
        `, {
            replacements: [dias],
            type: this.db.getSequelizeClient().QueryTypes.SELECT
        });
    }

    /**
     * Obtiene resumen ejecutivo del último mes
     */
    async getResumenEjecutivo() {
        const resultado = await this.db.querySequelize(`
            SELECT 
                'ÚLTIMO MES' as periodo,
                MIN(DATE(fecha_proceso)) as fecha_inicio,
                MAX(DATE(fecha_proceso)) as fecha_fin,
                
                -- Totales
                SUM(total_candidatos) as dispositivos_evaluados,
                SUM(recargas_exitosas) as dispositivos_recargados,
                SUM(no_recargados_reportando) as dispositivos_ahorro_potencial,
                
                -- Financiero
                SUM(inversion_realizada) as inversion_total,
                SUM(inversion_evitada) as ahorro_potencial_total,
                SUM(COALESCE(ahorro_real_7d_pesos, 0)) as ahorro_real_confirmado,
                
                -- Eficiencia
                ROUND(AVG(ahorro_potencial_porcentaje), 2) as eficiencia_algoritmo,
                ROUND(AVG(tasa_exito_porcentaje), 2) as tasa_exito_recargas,
                
                -- ROI
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
                
            FROM gps_analytics
            WHERE fecha_proceso >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
        `, {
            type: this.db.getSequelizeClient().QueryTypes.SELECT
        });

        return resultado[0] || {};
    }

    /**
     * Obtiene tendencia semanal de ahorro
     */
    async getTendenciaSemanal(semanas = 12) {
        return await this.db.querySequelize(`
            SELECT 
                YEAR(fecha_proceso) as año,
                WEEK(fecha_proceso) as semana,
                MIN(DATE(fecha_proceso)) as fecha_inicio_semana,
                MAX(DATE(fecha_proceso)) as fecha_fin_semana,
                
                -- Totales de la semana
                SUM(total_candidatos) as dispositivos_evaluados,
                SUM(recargas_exitosas) as recargas_realizadas,
                SUM(no_recargados_reportando) as ahorro_potencial,
                SUM(inversion_realizada) as inversion_total,
                SUM(inversion_evitada) as ahorro_potencial_pesos,
                
                -- Ahorro real confirmado
                SUM(COALESCE(ahorro_real_7d_pesos, 0)) as ahorro_real_confirmado,
                
                -- Métricas de eficiencia
                AVG(ahorro_potencial_porcentaje) as eficiencia_promedio,
                
                -- ROI del algoritmo
                CASE 
                    WHEN SUM(inversion_realizada) > 0 
                    THEN (SUM(COALESCE(ahorro_real_7d_pesos, 0)) / SUM(inversion_realizada)) * 100
                    ELSE 0 
                END as roi_algoritmo_porcentaje
                
            FROM gps_analytics
            WHERE fecha_proceso >= DATE_SUB(CURDATE(), INTERVAL ? WEEK)
            GROUP BY YEAR(fecha_proceso), WEEK(fecha_proceso)
            ORDER BY año DESC, semana DESC
        `, {
            replacements: [semanas],
            type: this.db.getSequelizeClient().QueryTypes.SELECT
        });
    }

    /**
     * Obtiene análisis de efectividad del algoritmo
     */
    async getEfectividadAlgoritmo() {
        return await this.db.querySequelize(`
            SELECT 
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
                    THEN (SUM(COALESCE(ahorro_confirmado_24h, 0)) / SUM(no_recargados_reportando)) * 100
                    ELSE 0 
                END as tasa_confirmacion_24h,
                
                CASE 
                    WHEN SUM(no_recargados_reportando) > 0 
                    THEN (SUM(COALESCE(ahorro_confirmado_7d, 0)) / SUM(no_recargados_reportando)) * 100
                    ELSE 0 
                END as tasa_confirmacion_7d,
                
                -- Ahorro real en pesos
                SUM(COALESCE(ahorro_real_7d_pesos, 0)) as ahorro_real_total_pesos,
                
                -- Eficiencia general
                AVG(ahorro_potencial_porcentaje) as eficiencia_promedio
                
            FROM gps_analytics
            WHERE fecha_proceso >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
            GROUP BY version_algoritmo, minutos_umbral, dias_limite
            ORDER BY version_algoritmo DESC, minutos_umbral, dias_limite
        `, {
            type: this.db.getSequelizeClient().QueryTypes.SELECT
        });
    }

    /**
     * Obtiene comparativa mensual de ROI
     */
    async getComparativaMensual(meses = 12) {
        return await this.db.querySequelize(`
            SELECT 
                YEAR(fecha_proceso) as año,
                MONTH(fecha_proceso) as mes,
                MONTHNAME(fecha_proceso) as nombre_mes,
                
                -- Inversión realizada
                SUM(inversion_realizada) as inversion_total,
                SUM(recargas_exitosas) as dispositivos_recargados,
                
                -- Ahorro potencial
                SUM(inversion_evitada) as ahorro_potencial_total,
                SUM(no_recargados_reportando) as dispositivos_no_recargados,
                
                -- Ahorro real confirmado
                SUM(COALESCE(ahorro_real_7d_pesos, 0)) as ahorro_real_confirmado,
                SUM(COALESCE(ahorro_confirmado_7d, 0)) as dispositivos_ahorro_real,
                
                -- ROI y eficiencia
                CASE 
                    WHEN SUM(inversion_realizada) > 0 
                    THEN (SUM(COALESCE(ahorro_real_7d_pesos, 0)) / SUM(inversion_realizada)) * 100
                    ELSE 0 
                END as roi_porcentaje,
                
                CASE 
                    WHEN SUM(total_candidatos) > 0 
                    THEN (SUM(no_recargados_reportando) / SUM(total_candidatos)) * 100
                    ELSE 0 
                END as eficiencia_algoritmo
                
            FROM gps_analytics
            WHERE fecha_proceso >= DATE_SUB(CURDATE(), INTERVAL ? MONTH)
            GROUP BY YEAR(fecha_proceso), MONTH(fecha_proceso)
            ORDER BY año DESC, mes DESC
        `, {
            replacements: [meses],
            type: this.db.getSequelizeClient().QueryTypes.SELECT
        });
    }

    /**
     * Obtiene datos del dashboard en tiempo real
     */
    async getDashboardData() {
        const dashboard = await this.db.querySequelize(`
            SELECT 
                -- Métricas de hoy
                (SELECT COUNT(*) FROM gps_analytics WHERE DATE(fecha_proceso) = CURDATE()) as procesos_hoy,
                (SELECT SUM(recargas_exitosas) FROM gps_analytics WHERE DATE(fecha_proceso) = CURDATE()) as recargas_hoy,
                (SELECT SUM(no_recargados_reportando) FROM gps_analytics WHERE DATE(fecha_proceso) = CURDATE()) as ahorro_hoy,
                (SELECT SUM(inversion_realizada) FROM gps_analytics WHERE DATE(fecha_proceso) = CURDATE()) as inversion_hoy,
                
                -- Métricas del mes
                (SELECT SUM(recargas_exitosas) FROM gps_analytics WHERE MONTH(fecha_proceso) = MONTH(CURDATE()) AND YEAR(fecha_proceso) = YEAR(CURDATE())) as recargas_mes,
                (SELECT SUM(inversion_realizada) FROM gps_analytics WHERE MONTH(fecha_proceso) = MONTH(CURDATE()) AND YEAR(fecha_proceso) = YEAR(CURDATE())) as inversion_mes,
                (SELECT SUM(COALESCE(ahorro_real_7d_pesos, 0)) FROM gps_analytics WHERE MONTH(fecha_proceso) = MONTH(CURDATE()) AND YEAR(fecha_proceso) = YEAR(CURDATE())) as ahorro_real_mes,
                
                -- Eficiencia general
                (SELECT AVG(ahorro_potencial_porcentaje) FROM gps_analytics WHERE fecha_proceso >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)) as eficiencia_ultima_semana
        `, {
            type: this.db.getSequelizeClient().QueryTypes.SELECT
        });

        return dashboard[0] || {};
    }

    /**
     * Genera reporte completo en formato JSON
     */
    async generateCompleteReport() {
        const ahora = moment().tz(this.timezone);
        
        return {
            metadata: {
                generated_at: ahora.format('YYYY-MM-DD HH:mm:ss'),
                timezone: this.timezone,
                report_type: 'gps_analytics_complete'
            },
            dashboard: await this.getDashboardData(),
            resumen_ejecutivo: await this.getResumenEjecutivo(),
            tendencia_semanal: await this.getTendenciaSemanal(8),
            efectividad_algoritmo: await this.getEfectividadAlgoritmo(),
            comparativa_mensual: await this.getComparativaMensual(6),
            resumen_diario: await this.getResumenDiario(14)
        };
    }

    /**
     * Genera reporte en formato de texto legible
     */
    async generateTextReport() {
        const data = await this.generateCompleteReport();
        const ahora = moment().tz(this.timezone);
        
        let report = '';
        report += '===============================================\n';
        report += '     REPORTE ANALÍTICO GPS OPTIMIZATION\n';
        report += '===============================================\n';
        report += `Generado: ${ahora.format('YYYY-MM-DD HH:mm:ss')} (${this.timezone})\n\n`;
        
        // Dashboard
        const dashboard = data.dashboard;
        report += '📊 DASHBOARD - MÉTRICAS EN TIEMPO REAL\n';
        report += '---------------------------------------\n';
        report += `Procesos hoy: ${dashboard.procesos_hoy || 0}\n`;
        report += `Recargas hoy: ${dashboard.recargas_hoy || 0}\n`;
        report += `Ahorro hoy: ${dashboard.ahorro_hoy || 0} dispositivos\n`;
        report += `Inversión hoy: $${dashboard.inversion_hoy || 0}\n`;
        report += `Recargas mes: ${dashboard.recargas_mes || 0}\n`;
        report += `Inversión mes: $${dashboard.inversion_mes || 0}\n`;
        report += `Ahorro real mes: $${dashboard.ahorro_real_mes || 0}\n`;
        report += `Eficiencia última semana: ${(dashboard.eficiencia_ultima_semana || 0).toFixed(1)}%\n\n`;
        
        // Resumen ejecutivo
        const resumen = data.resumen_ejecutivo;
        report += '📈 RESUMEN EJECUTIVO - ÚLTIMO MES\n';
        report += '----------------------------------\n';
        report += `Período: ${resumen.fecha_inicio} a ${resumen.fecha_fin}\n`;
        report += `Dispositivos evaluados: ${resumen.dispositivos_evaluados || 0}\n`;
        report += `Dispositivos recargados: ${resumen.dispositivos_recargados || 0}\n`;
        report += `Dispositivos ahorro potencial: ${resumen.dispositivos_ahorro_potencial || 0}\n`;
        report += `Inversión total: $${resumen.inversion_total || 0}\n`;
        report += `Ahorro potencial: $${resumen.ahorro_potencial_total || 0}\n`;
        report += `Ahorro real confirmado: $${resumen.ahorro_real_confirmado || 0}\n`;
        report += `Eficiencia algoritmo: ${resumen.eficiencia_algoritmo || 0}%\n`;
        report += `Tasa éxito recargas: ${resumen.tasa_exito_recargas || 0}%\n`;
        report += `ROI: ${resumen.roi_porcentaje || 0}%\n`;
        report += `Precisión algoritmo: ${resumen.precision_algoritmo_porcentaje || 0}%\n\n`;
        
        return report;
    }

    /**
     * Guarda reporte en archivo
     */
    async saveReport(formato = 'json', archivo = null) {
        const ahora = moment().tz(this.timezone);
        const timestamp = ahora.format('YYYY-MM-DD_HH-mm-ss');
        
        let contenido, extension, nombreArchivo;
        
        if (formato === 'json') {
            contenido = JSON.stringify(await this.generateCompleteReport(), null, 2);
            extension = 'json';
        } else {
            contenido = await this.generateTextReport();
            extension = 'txt';
        }
        
        nombreArchivo = archivo || `gps_analytics_report_${timestamp}.${extension}`;
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
}

module.exports = GPSAnalyticsReporter;