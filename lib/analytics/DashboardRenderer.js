const moment = require('moment-timezone');

/**
 * Renderizador de Dashboard Profesional
 * Presenta las analíticas de consumo de forma visual y estructurada
 */
class DashboardRenderer {
    constructor() {
        this.colors = {
            GPS: '🟢',
            VOZ: '🔵', 
            ELIOT: '🟡',
            success: '✅',
            warning: '⚠️',
            error: '❌',
            info: 'ℹ️',
            money: '💰',
            chart: '📊',
            trend: '📈',
            alert: '🚨'
        };
    }

    /**
     * Renderiza el dashboard completo
     */
    renderComprehensiveDashboard(report) {
        let output = '';

        // Header principal
        output += this.renderHeader(report);
        
        // Resumen ejecutivo
        output += this.renderExecutiveSummary(report);
        
        // Analíticas por períodos
        output += this.renderPeriodAnalytics(report.periods);
        
        // KPIs de negocio
        output += this.renderBusinessKPIs(report.businessKPIs);
        
        // Tendencias
        output += this.renderTrends(report.trends);
        
        // Alertas
        if (report.alerts && report.alerts.length > 0) {
            output += this.renderAlerts(report.alerts);
        }

        // Footer
        output += this.renderFooter(report);

        return output;
    }

    /**
     * Renderiza header del dashboard
     */
    renderHeader(report) {
        return `
╔════════════════════════════════════════════════════════════════════════════════╗
║                    📊 DASHBOARD EMPRESARIAL - ANALÍTICAS DE CONSUMO            ║
║                              Sistema de Recargas v2.0                          ║
╚════════════════════════════════════════════════════════════════════════════════╝

⏰ Generado: ${report.timestamp} (${report.timezone})
🌐 Servicios analizados: GPS, VOZ, ELIoT
📈 Períodos: Semanal, Mensual, Semestral

`;
    }

    /**
     * Renderiza resumen ejecutivo
     */
    renderExecutiveSummary(report) {
        const currentWeek = report.periods.weekly.summary.currentWeek;
        const currentMonth = report.periods.monthly.summary.currentMonth;
        
        return `
╔═══════════════════════════════════════════════════════════════════════════════╗
║                               💼 RESUMEN EJECUTIVO                            ║
╚═══════════════════════════════════════════════════════════════════════════════╝

📅 SEMANA ACTUAL:
   ${this.colors.money} Ingresos: $${this.formatCurrency(currentWeek.totalRevenue)}
   📊 Transacciones: ${currentWeek.totalTransactions.toLocaleString()}
   📱 Dispositivos activos: ${currentWeek.totalDevices.toLocaleString()}
   ✅ Tasa de éxito promedio: ${currentWeek.averageSuccessRate.toFixed(1)}%

📅 MES ACTUAL:
   ${this.colors.money} Ingresos: $${this.formatCurrency(currentMonth.totalRevenue)}
   📊 Transacciones: ${currentMonth.totalTransactions.toLocaleString()}
   📱 Dispositivos activos: ${currentMonth.totalDevices.toLocaleString()}
   ✅ Tasa de éxito promedio: ${currentMonth.averageSuccessRate.toFixed(1)}%

🏆 MEJOR SERVICIO SEMANAL: ${report.periods.weekly.summary.bestPerformingService?.name || 'N/A'}
🏆 MEJOR SERVICIO MENSUAL: ${report.periods.monthly.summary.bestPerformingService?.name || 'N/A'}

`;
    }

    /**
     * Renderiza analíticas por períodos
     */
    renderPeriodAnalytics(periods) {
        let output = `
╔═══════════════════════════════════════════════════════════════════════════════╗
║                          📈 ANALÍTICAS POR PERÍODOS                           ║
╚═══════════════════════════════════════════════════════════════════════════════╝

`;
        
        // Analíticas semanales
        output += this.renderWeeklyAnalytics(periods.weekly);
        
        // Analíticas mensuales
        output += this.renderMonthlyAnalytics(periods.monthly);
        
        // Analíticas semestrales
        output += this.renderSemiannualAnalytics(periods.semiannual);

        return output;
    }

    /**
     * Renderiza analíticas semanales
     */
    renderWeeklyAnalytics(weeklyData) {
        let output = `
📅 ANÁLISIS SEMANAL (${weeklyData.description}):
${this.renderSeparator()}

`;

        weeklyData.data.forEach((week, index) => {
            const indicator = week.isCurrentWeek ? '👈 ACTUAL' : '';
            output += `📆 Semana ${week.weekNumber}/${week.year} (${week.dateRange}) ${indicator}\n`;
            
            // Mostrar métricas por servicio
            Object.entries(week.services).forEach(([serviceName, data]) => {
                const icon = this.colors[serviceName] || '⚪';
                output += `   ${icon} ${serviceName}:\n`;
                output += `     💰 Ingresos: $${this.formatCurrency(data.financial.totalRevenue)}\n`;
                output += `     📊 Transacciones: ${data.volume.totalTransactions}\n`;
                output += `     📱 Dispositivos: ${data.volume.uniqueDevices}\n`;
                output += `     ✅ Éxito: ${data.performance.successRate.toFixed(1)}%\n`;
                
                if (data.trends.growthIndicators) {
                    const trend = data.trends.growthIndicators.revenueGrowth > 0 ? '📈' : '📉';
                    output += `     ${trend} Crecimiento: ${data.trends.growthIndicators.revenueGrowth.toFixed(1)}%\n`;
                }
                output += '\n';
            });
            
            output += `   📊 TOTALES SEMANA: $${this.formatCurrency(week.totals.totalRevenue)} | ${week.totals.totalTransactions} transacciones\n\n`;
        });

        return output;
    }

    /**
     * Renderiza analíticas mensuales
     */
    renderMonthlyAnalytics(monthlyData) {
        let output = `
📅 ANÁLISIS MENSUAL (${monthlyData.description}):
${this.renderSeparator()}

`;

        monthlyData.data.slice(0, 3).forEach((month, index) => {
            const indicator = month.isCurrentMonth ? '👈 ACTUAL' : '';
            output += `📆 ${month.month} ${month.year} (${month.dateRange}) ${indicator}\n`;
            
            // Mostrar métricas por servicio
            Object.entries(month.services).forEach(([serviceName, data]) => {
                const icon = this.colors[serviceName] || '⚪';
                output += `   ${icon} ${serviceName}:\n`;
                output += `     💰 Ingresos: $${this.formatCurrency(data.financial.totalRevenue)}\n`;
                output += `     📊 Transacciones: ${data.volume.totalTransactions}\n`;
                output += `     📱 Dispositivos únicos: ${data.volume.uniqueDevices}\n`;
                output += `     ✅ Tasa éxito: ${data.performance.successRate.toFixed(1)}%\n`;
                output += `     📈 Frecuencia/dispositivo: ${data.performance.transactionFrequency.toFixed(1)}\n\n`;
            });
            
            output += `   📊 TOTALES MES: $${this.formatCurrency(month.totals.totalRevenue)} | ${month.totals.totalTransactions} transacciones\n`;
            
            if (month.dailyAverages) {
                output += `   📈 PROMEDIO DIARIO: $${this.formatCurrency(month.dailyAverages.dailyRevenue)} | ${month.dailyAverages.dailyTransactions.toFixed(0)} transacciones\n`;
            }
            
            output += '\n';
        });

        // Mostrar tendencias estacionales si existen
        if (monthlyData.summary.seasonalTrends) {
            output += '🌤️ TENDENCIAS ESTACIONALES:\n';
            Object.entries(monthlyData.summary.seasonalTrends).forEach(([quarter, data]) => {
                output += `   ${quarter}: $${this.formatCurrency(data.averageRevenue)} promedio | ${data.averageTransactions.toFixed(0)} transacciones\n`;
            });
            output += '\n';
        }

        return output;
    }

    /**
     * Renderiza analíticas semestrales
     */
    renderSemiannualAnalytics(semiannualData) {
        let output = `
📅 ANÁLISIS SEMESTRAL (${semiannualData.description}):
${this.renderSeparator()}

`;

        semiannualData.data.forEach((semester, index) => {
            const indicator = semester.isCurrentSemester ? '👈 ACTUAL' : '';
            output += `📆 ${semester.semester} ${semester.year} (${semester.dateRange}) ${indicator}\n`;
            
            // Resumen de servicios
            let servicesOutput = '';
            Object.entries(semester.services).forEach(([serviceName, data]) => {
                const icon = this.colors[serviceName] || '⚪';
                servicesOutput += `   ${icon} ${serviceName}: $${this.formatCurrency(data.financial.totalRevenue)} | ${data.volume.totalTransactions} trans.\n`;
            });
            
            output += servicesOutput;
            output += `   📊 TOTAL SEMESTRE: $${this.formatCurrency(semester.totals.totalRevenue)} | ${semester.totals.totalTransactions} transacciones\n\n`;
        });

        // Mostrar crecimiento año sobre año
        if (semiannualData.summary.yearOverYearGrowth !== null && semiannualData.summary.yearOverYearGrowth !== undefined) {
            const trendIcon = semiannualData.summary.yearOverYearGrowth > 0 ? '📈' : '📉';
            output += `${trendIcon} CRECIMIENTO AÑO/AÑO: ${semiannualData.summary.yearOverYearGrowth.toFixed(1)}%\n\n`;
        }

        return output;
    }

    /**
     * Renderiza KPIs de negocio
     */
    renderBusinessKPIs(businessKPIs) {
        let output = `
╔═══════════════════════════════════════════════════════════════════════════════╗
║                             🎯 INDICADORES DE NEGOCIO                          ║
╚═══════════════════════════════════════════════════════════════════════════════╝

⚡ OPERACIONALES:
   🟢 Disponibilidad del sistema: ${businessKPIs.operational.systemAvailability}%
   ⚡ Tiempo promedio de procesamiento: ${businessKPIs.operational.averageProcessingTime}s
   ❌ Tasa de error: ${businessKPIs.operational.errorRate}%
   🔄 Tasa de recuperación: ${businessKPIs.operational.recoveryRate}%

💰 FINANCIEROS:
   💵 Ingresos últimos 30 días: $${this.formatCurrency(businessKPIs.financial.totalRevenue30Days)}
   💳 Ingresos por transacción: $${businessKPIs.financial.revenuePerTransaction}
   📊 Eficiencia de costos: ${businessKPIs.financial.costEfficiency}%
   📈 Margen de utilidad: ${businessKPIs.financial.profitMargin}%

👥 CLIENTES:
   🔒 Retención de dispositivos: ${businessKPIs.customer.deviceRetention}%
   📱 Uso promedio por dispositivo: ${businessKPIs.customer.averageDeviceUsage} transacciones/mes
   😊 Índice de satisfacción: ${businessKPIs.customer.customerSatisfactionIndex}/5.0

`;
        return output;
    }

    /**
     * Renderiza tendencias
     */
    renderTrends(trends) {
        let output = `
╔═══════════════════════════════════════════════════════════════════════════════╗
║                                📈 TENDENCIAS                                   ║
╚═══════════════════════════════════════════════════════════════════════════════╝

📈 CRECIMIENTO DE INGRESOS: ${trends.revenueGrowthTrend}% (tendencia)
📊 CRECIMIENTO DE VOLUMEN: ${trends.volumeGrowthTrend}% (tendencia)

🔮 INSIGHTS PREDICTIVOS:
   • Los patrones actuales sugieren un crecimiento sostenido
   • Mejor rendimiento en días laborales vs. fines de semana
   • Oportunidades de optimización en horarios de menor demanda

`;
        return output;
    }

    /**
     * Renderiza alertas
     */
    renderAlerts(alerts) {
        let output = `
╔═══════════════════════════════════════════════════════════════════════════════╗
║                                🚨 ALERTAS                                      ║
╚═══════════════════════════════════════════════════════════════════════════════╝

`;

        alerts.forEach(alert => {
            const icon = alert.level === 'critical' ? '🚨' : 
                        alert.level === 'warning' ? '⚠️' : 'ℹ️';
            output += `${icon} ${alert.title}\n`;
            output += `   ${alert.description}\n\n`;
        });

        return output;
    }

    /**
     * Renderiza footer
     */
    renderFooter(report) {
        return `
╔═══════════════════════════════════════════════════════════════════════════════╗
║                                💡 NOTAS                                       ║
╚═══════════════════════════════════════════════════════════════════════════════╝

• Los datos se actualizan en tiempo real basado en transacciones procesadas
• Las tendencias se calculan comparando períodos equivalentes
• Los KPIs se basan en métricas de la industria de telecomunicaciones
• Para análisis detallados, consulte los logs estructurados del sistema

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                    Sistema de Recargas Optimizado v2.0
                  Generado por AdvancedMonitor - ${new Date().toLocaleString()}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

`;
    }

    /**
     * Helpers de formateo
     */
    formatCurrency(amount) {
        return new Intl.NumberFormat('es-MX', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        }).format(amount);
    }

    renderSeparator() {
        return '─'.repeat(80) + '\n';
    }

    /**
     * Renderiza una tabla compacta para distribución de datos
     */
    renderCompactTable(data, headers) {
        let output = '';
        
        // Headers
        output += headers.join(' | ') + '\n';
        output += headers.map(h => '─'.repeat(h.length)).join(' | ') + '\n';
        
        // Data rows
        data.forEach(row => {
            output += row.join(' | ') + '\n';
        });
        
        return output;
    }

    /**
     * Renderiza gráfico de barras simple en ASCII
     */
    renderASCIIChart(data, maxWidth = 50) {
        let output = '';
        const maxValue = Math.max(...data.map(item => item.value));
        
        data.forEach(item => {
            const barLength = Math.round((item.value / maxValue) * maxWidth);
            const bar = '█'.repeat(barLength);
            output += `${item.label.padEnd(15)} ${bar} ${item.value}\n`;
        });
        
        return output;
    }
}

module.exports = { DashboardRenderer };