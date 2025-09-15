// Demo Analytics con datos simulados basados en la estructura real
require('dotenv').config();

const { DashboardRenderer } = require('./lib/analytics/DashboardRenderer');

/**
 * Demo Analytics - Simula datos reales para mostrar el funcionamiento
 * del sistema de analíticas sin necesidad de conexión a BD
 */

class DemoAnalytics {
    constructor() {
        this.renderer = new DashboardRenderer();
        this.timezone = 'America/Mexico_City';
    }

    // Simular datos reales basados en la estructura de las tablas
    generateMockData() {
        const currentDate = new Date();
        
        // Datos simulados para últimas 4 semanas
        const weeklyData = [
            {
                period: 'Semana 1 (Actual)',
                startDate: new Date(currentDate.getTime() - 0 * 7 * 24 * 60 * 60 * 1000),
                endDate: currentDate,
                services: {
                    GPS: { transactions: 1247, revenue: 12470.00, avgAmount: 10.00, successRate: 98.5 },
                    VOZ: { transactions: 856, revenue: 25680.00, avgAmount: 30.00, successRate: 97.2 },
                    ELIOT: { transactions: 423, revenue: 6345.00, avgAmount: 15.00, successRate: 99.1 }
                }
            },
            {
                period: 'Semana 2',
                startDate: new Date(currentDate.getTime() - 1 * 7 * 24 * 60 * 60 * 1000),
                endDate: new Date(currentDate.getTime() - 0 * 7 * 24 * 60 * 60 * 1000),
                services: {
                    GPS: { transactions: 1189, revenue: 11890.00, avgAmount: 10.00, successRate: 97.8 },
                    VOZ: { transactions: 743, revenue: 22290.00, avgAmount: 30.00, successRate: 96.8 },
                    ELIOT: { transactions: 389, revenue: 5835.00, avgAmount: 15.00, successRate: 98.7 }
                }
            },
            {
                period: 'Semana 3',
                startDate: new Date(currentDate.getTime() - 2 * 7 * 24 * 60 * 60 * 1000),
                endDate: new Date(currentDate.getTime() - 1 * 7 * 24 * 60 * 60 * 1000),
                services: {
                    GPS: { transactions: 1356, revenue: 13560.00, avgAmount: 10.00, successRate: 98.1 },
                    VOZ: { transactions: 912, revenue: 27360.00, avgAmount: 30.00, successRate: 97.5 },
                    ELIOT: { transactions: 445, revenue: 6675.00, avgAmount: 15.00, successRate: 98.9 }
                }
            },
            {
                period: 'Semana 4',
                startDate: new Date(currentDate.getTime() - 3 * 7 * 24 * 60 * 60 * 1000),
                endDate: new Date(currentDate.getTime() - 2 * 7 * 24 * 60 * 60 * 1000),
                services: {
                    GPS: { transactions: 1098, revenue: 10980.00, avgAmount: 10.00, successRate: 97.2 },
                    VOZ: { transactions: 687, revenue: 20610.00, avgAmount: 30.00, successRate: 96.3 },
                    ELIOT: { transactions: 356, revenue: 5340.00, avgAmount: 15.00, successRate: 98.4 }
                }
            }
        ];

        // Datos mensuales (últimos 6 meses)
        const monthlyData = [
            { period: 'Septiembre 2025', GPS: 5234, VOZ: 3567, ELIOT: 1823, totalRevenue: 148950 },
            { period: 'Agosto 2025', GPS: 4987, VOZ: 3234, ELIOT: 1654, totalRevenue: 136780 },
            { period: 'Julio 2025', GPS: 5456, VOZ: 3789, ELIOT: 1987, totalRevenue: 162340 },
            { period: 'Junio 2025', GPS: 4123, VOZ: 2876, ELIOT: 1456, totalRevenue: 119870 },
            { period: 'Mayo 2025', GPS: 4678, VOZ: 3123, ELIOT: 1687, totalRevenue: 134560 },
            { period: 'Abril 2025', GPS: 3987, VOZ: 2654, ELIOT: 1234, totalRevenue: 108970 }
        ];

        // KPIs de negocio
        const businessKPIs = {
            operational: {
                totalTransactions: 15890,
                successRate: 97.8,
                avgProcessingTime: 2.3,
                peakHour: '14:00-15:00',
                concurrentUsers: 156
            },
            financial: {
                totalRevenue: 287450.00,
                revenueGrowth: 12.5,
                avgTicketSize: 18.09,
                profitMargin: 23.4,
                monthlyRecurring: 245670.00
            },
            customer: {
                activeCustomers: 8945,
                newCustomers: 234,
                customerRetention: 89.3,
                avgSessionDuration: 4.7,
                nps: 8.2
            }
        };

        // Indicadores de crecimiento
        const growthIndicators = {
            weekly: {
                GPS: { growth: 4.8, trend: 'up', comparison: 'vs semana anterior' },
                VOZ: { growth: 15.2, trend: 'up', comparison: 'vs semana anterior' },
                ELIOT: { growth: 8.7, trend: 'up', comparison: 'vs semana anterior' }
            },
            monthly: {
                GPS: { growth: 5.0, trend: 'up', comparison: 'vs mes anterior' },
                VOZ: { growth: 10.3, trend: 'up', comparison: 'vs mes anterior' },
                ELIOT: { growth: 10.2, trend: 'up', comparison: 'vs mes anterior' }
            }
        };

        return {
            timestamp: currentDate.toLocaleString('es-MX', { timeZone: this.timezone }),
            timezone: this.timezone,
            periods: {
                weekly: {
                    data: weeklyData,
                    summary: {
                        currentWeek: {
                            totalRevenue: 44495.00,
                            totalTransactions: 2526,
                            totalDevices: 2526,
                            averageSuccessRate: 98.3
                        },
                        bestPerformingService: { name: 'GPS', transactions: 1247, revenue: 12470.00 }
                    }
                },
                monthly: {
                    data: monthlyData,
                    summary: {
                        currentMonth: {
                            totalRevenue: 148950.00,
                            totalTransactions: 10624,
                            totalDevices: 10624,
                            averageSuccessRate: 97.9
                        },
                        bestPerformingService: { name: 'GPS', transactions: 5234, revenue: 52340.00 }
                    }
                },
                semiannual: {
                    data: monthlyData,
                    summary: {
                        currentPeriod: {
                            totalRevenue: 811470.00,
                            totalTransactions: 58321,
                            totalDevices: 58321,
                            averageSuccessRate: 97.5
                        }
                    }
                }
            },
            businessKPIs,
            trends: growthIndicators,
            alerts: [
                { type: 'info', message: 'Crecimiento sostenido en todos los servicios' },
                { type: 'success', message: 'Tasa de éxito superior al 97%' }
            ],
            summary: {
                totalTransactions: 15890,
                totalRevenue: 287450.00,
                successRate: 97.8,
                topService: 'GPS',
                trend: 'CRECIMIENTO'
            }
        };
    }

    renderDemo() {
        console.clear();
        
        console.log(`
╔════════════════════════════════════════════════════════════════════════════════╗
║                  🚀 DEMO: MONITOR EMPRESARIAL AVANZADO v2.0                   ║
║                                                                                ║
║  📊 Analíticas de Consumo por Períodos                                        ║
║  📈 Indicadores Profesionales de Negocio                                      ║
║  🎯 KPIs Empresariales en Tiempo Real                                         ║
║                                                                                ║
║  Servicios: GPS, VOZ, ELIoT                                                   ║
║  Períodos: Semanal | Mensual | Semestral                                     ║
║                                                                                ║
║  ⚡ DATOS SIMULADOS BASADOS EN ESTRUCTURA REAL                                ║
╚════════════════════════════════════════════════════════════════════════════════╝

🎯 Generando dashboard con datos de demostración...
`);

        // Generar datos mock
        const reportData = this.generateMockData();
        
        // Renderizar dashboard
        const dashboard = this.renderer.renderComprehensiveDashboard(reportData);
        
        // Mostrar dashboard
        console.log(dashboard);
        
        console.log(`
╔════════════════════════════════════════════════════════════════════════════════╗
║                                 📋 NOTAS DEMO                                  ║
║                                                                                ║
║  ✅ Estructura de datos basada en tablas reales: 'recargas' y 'detalle_recargas' ║
║  ✅ Mapeo de servicios: tipo='rastreo'→GPS, 'paquete'→VOZ, 'eliot'→ELIoT       ║
║  ✅ KPIs profesionales calculados en base a datos empresariales               ║
║  ✅ Dashboard totalmente funcional, solo necesita conexión a BD real          ║
║                                                                                ║
║  🔄 Con conexión real: npm run analytics                                      ║
║  📊 Demo sin BD: node demo-analytics.js                                       ║
╚════════════════════════════════════════════════════════════════════════════════╝
`);
    }
}

// Ejecutar demo
const demo = new DemoAnalytics();
demo.renderDemo();

module.exports = { DemoAnalytics };