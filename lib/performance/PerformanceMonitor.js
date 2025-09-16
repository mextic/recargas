/**
 * Performance Monitor - FASE 4 Optimización
 * Sistema de monitoreo de performance con métricas detalladas
 */
const moment = require('moment-timezone');

class PerformanceMonitor {
    constructor() {
        this.metrics = new Map();
        this.operationTimers = new Map();
        this.alertThresholds = {
            dbQuery: 5000,        // 5 segundos
            webservice: 30000,    // 30 segundos
            recharge: 45000,      // 45 segundos
            cacheOp: 1000,        // 1 segundo
            batchProcess: 300000  // 5 minutos
        };
        
        this.currentSession = {
            startTime: Date.now(),
            operations: 0,
            errors: 0,
            warnings: 0
        };
    }

    // ===== TIMING OPERATIONS =====

    startTimer(operationId, operationType, metadata = {}) {
        const timer = {
            id: operationId,
            type: operationType,
            startTime: Date.now(),
            metadata
        };
        
        this.operationTimers.set(operationId, timer);
        return operationId;
    }

    endTimer(operationId, result = 'success', additionalMetadata = {}) {
        const timer = this.operationTimers.get(operationId);
        if (!timer) {
            console.warn(`⚠️ Timer no encontrado: ${operationId}`);
            return null;
        }

        const duration = Date.now() - timer.startTime;
        const metric = {
            id: operationId,
            type: timer.type,
            duration,
            result,
            timestamp: Date.now(),
            metadata: { ...timer.metadata, ...additionalMetadata }
        };

        // Guardar métrica
        this.recordMetric(metric);

        // Verificar umbrales y alertas
        this.checkAlertThresholds(metric);

        // Limpiar timer
        this.operationTimers.delete(operationId);

        return metric;
    }

    recordMetric(metric) {
        const key = `${metric.type}_${metric.timestamp}`;
        this.metrics.set(key, metric);

        // Limpiar métricas antiguas (mantener solo últimas 1000)
        if (this.metrics.size > 1000) {
            const oldestKey = Array.from(this.metrics.keys())[0];
            this.metrics.delete(oldestKey);
        }

        this.currentSession.operations++;
        if (metric.result === 'error') {
            this.currentSession.errors++;
        }
    }

    checkAlertThresholds(metric) {
        const threshold = this.alertThresholds[metric.type];
        if (threshold && metric.duration > threshold) {
            console.log(`🚨 ALERTA PERFORMANCE: ${metric.type} tardó ${metric.duration}ms (umbral: ${threshold}ms)`);
            console.log(`   • Operación: ${metric.id}`);
            console.log(`   • Metadata:`, metric.metadata);
            this.currentSession.warnings++;
        }
    }

    // ===== WRAPPERS PARA OPERACIONES COMUNES =====

    async measureDatabaseQuery(queryName, queryFunction, metadata = {}) {
        const timerId = this.startTimer(`db_${Date.now()}`, 'dbQuery', {
            queryName,
            ...metadata
        });

        try {
            const result = await queryFunction();
            this.endTimer(timerId, 'success', {
                resultCount: Array.isArray(result) ? result.length : 1
            });
            return result;
        } catch (error) {
            this.endTimer(timerId, 'error', {
                errorMessage: error.message
            });
            throw error;
        }
    }

    async measureWebserviceCall(operation, webserviceFunction, metadata = {}) {
        const timerId = this.startTimer(`ws_${Date.now()}`, 'webservice', {
            operation,
            ...metadata
        });

        try {
            const result = await webserviceFunction();
            this.endTimer(timerId, 'success', {
                provider: result.provider,
                transId: result.transID
            });
            return result;
        } catch (error) {
            this.endTimer(timerId, 'error', {
                errorMessage: error.message
            });
            throw error;
        }
    }

    async measureRechargeProcess(service, sim, rechargeFunction, metadata = {}) {
        const timerId = this.startTimer(`recharge_${service}_${sim}`, 'recharge', {
            service,
            sim,
            ...metadata
        });

        try {
            const result = await rechargeFunction();
            this.endTimer(timerId, 'success', {
                amount: result.amount,
                provider: result.provider
            });
            return result;
        } catch (error) {
            this.endTimer(timerId, 'error', {
                errorMessage: error.message
            });
            throw error;
        }
    }

    async measureCacheOperation(operation, cacheFunction, metadata = {}) {
        const timerId = this.startTimer(`cache_${Date.now()}`, 'cacheOp', {
            operation,
            ...metadata
        });

        try {
            const result = await cacheFunction();
            this.endTimer(timerId, 'success', {
                hit: result !== null
            });
            return result;
        } catch (error) {
            this.endTimer(timerId, 'error', {
                errorMessage: error.message
            });
            throw error;
        }
    }

    async measureBatchProcess(service, batchSize, batchFunction, metadata = {}) {
        const timerId = this.startTimer(`batch_${service}_${Date.now()}`, 'batchProcess', {
            service,
            batchSize,
            ...metadata
        });

        try {
            const result = await batchFunction();
            this.endTimer(timerId, 'success', {
                processed: result.processed,
                successful: result.successful,
                failed: result.failed
            });
            return result;
        } catch (error) {
            this.endTimer(timerId, 'error', {
                errorMessage: error.message
            });
            throw error;
        }
    }

    // ===== ANÁLISIS Y REPORTES =====

    getOperationStats(operationType, lastMinutes = 60) {
        const cutoff = Date.now() - (lastMinutes * 60 * 1000);
        const relevantMetrics = Array.from(this.metrics.values())
            .filter(m => m.type === operationType && m.timestamp > cutoff);

        if (relevantMetrics.length === 0) {
            return null;
        }

        const durations = relevantMetrics.map(m => m.duration);
        const successes = relevantMetrics.filter(m => m.result === 'success').length;

        return {
            count: relevantMetrics.length,
            successRate: `${((successes / relevantMetrics.length) * 100).toFixed(1)}%`,
            avgDuration: Math.round(durations.reduce((a, b) => a + b, 0) / durations.length),
            minDuration: Math.min(...durations),
            maxDuration: Math.max(...durations),
            medianDuration: this.calculateMedian(durations)
        };
    }

    calculateMedian(arr) {
        const sorted = [...arr].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    getSystemPerformanceReport() {
        const sessionDuration = Date.now() - this.currentSession.startTime;
        const sessionHours = sessionDuration / (1000 * 60 * 60);

        const report = {
            session: {
                duration: this.formatDuration(sessionDuration),
                operations: this.currentSession.operations,
                errors: this.currentSession.errors,
                warnings: this.currentSession.warnings,
                operationsPerHour: Math.round(this.currentSession.operations / sessionHours)
            },
            operations: {}
        };

        // Estadísticas por tipo de operación
        for (const opType of Object.keys(this.alertThresholds)) {
            const stats = this.getOperationStats(opType);
            if (stats) {
                report.operations[opType] = stats;
            }
        }

        return report;
    }

    formatDuration(ms) {
        const duration = moment.duration(ms);
        const hours = Math.floor(duration.asHours());
        const minutes = duration.minutes();
        const seconds = duration.seconds();
        
        return `${hours}h ${minutes}m ${seconds}s`;
    }

    // ===== ALERTAS EN TIEMPO REAL =====

    setCustomThreshold(operationType, thresholdMs) {
        this.alertThresholds[operationType] = thresholdMs;
        console.log(`📊 Umbral actualizado: ${operationType} = ${thresholdMs}ms`);
    }

    enableVerboseLogging() {
        this.verboseLogging = true;
        console.log('📊 Logging verboso activado para performance');
    }

    disableVerboseLogging() {
        this.verboseLogging = false;
        console.log('📊 Logging verboso desactivado');
    }

    // ===== EXPORTACIÓN DE MÉTRICAS =====

    exportMetrics(format = 'json') {
        const data = {
            session: this.currentSession,
            metrics: Array.from(this.metrics.values()),
            thresholds: this.alertThresholds,
            exportTime: Date.now()
        };

        if (format === 'csv') {
            return this.convertToCSV(data.metrics);
        }

        return JSON.stringify(data, null, 2);
    }

    convertToCSV(metrics) {
        if (metrics.length === 0) return '';

        const headers = ['timestamp', 'type', 'duration', 'result', 'id'];
        const csvRows = [headers.join(',')];

        metrics.forEach(metric => {
            const row = [
                metric.timestamp,
                metric.type,
                metric.duration,
                metric.result,
                metric.id
            ];
            csvRows.push(row.join(','));
        });

        return csvRows.join('\n');
    }

    // ===== UTILIDADES =====

    logCurrentStatus() {
        const report = this.getSystemPerformanceReport();
        
        console.log('📊 ===== PERFORMANCE STATUS =====');
        console.log(`   • Sesión: ${report.session.duration}`);
        console.log(`   • Operaciones: ${report.session.operations} (${report.session.operationsPerHour}/hora)`);
        console.log(`   • Errores: ${report.session.errors}`);
        console.log(`   • Warnings: ${report.session.warnings}`);
        
        Object.entries(report.operations).forEach(([type, stats]) => {
            console.log(`   • ${type.toUpperCase()}:`);
            console.log(`     - Count: ${stats.count}, Success: ${stats.successRate}`);
            console.log(`     - Avg: ${stats.avgDuration}ms, Max: ${stats.maxDuration}ms`);
        });
        
        console.log('================================');
    }

    clearMetrics() {
        this.metrics.clear();
        this.operationTimers.clear();
        this.currentSession = {
            startTime: Date.now(),
            operations: 0,
            errors: 0,
            warnings: 0
        };
        console.log('📊 Métricas de performance limpiadas');
    }
}

// Singleton para uso global
const performanceMonitor = new PerformanceMonitor();

module.exports = performanceMonitor;