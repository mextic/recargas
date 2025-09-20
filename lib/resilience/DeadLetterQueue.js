/**
 * DeadLetterQueue - Gestión de recargas irrecuperables
 * Maneja elementos que no pudieron ser procesados después de múltiples intentos
 */

const fs = require('fs');
const path = require('path');
const { getEventBus } = require('../events/EventBus');
const { EventTypes } = require('../events/EventTypes');
const moment = require('moment-timezone');

/**
 * Razones de ingreso al DLQ
 */
const DLQReason = {
    MAX_RETRIES_EXCEEDED: 'MAX_RETRIES_EXCEEDED',
    FATAL_ERROR: 'FATAL_ERROR',
    INVALID_DATA: 'INVALID_DATA',
    BUSINESS_RULE_VIOLATION: 'BUSINESS_RULE_VIOLATION',
    TIMEOUT: 'TIMEOUT',
    CIRCUIT_BREAKER_OPEN: 'CIRCUIT_BREAKER_OPEN'
};

/**
 * Estados de procesamiento de elementos DLQ
 */
const DLQStatus = {
    PENDING: 'PENDING',           // Pendiente de análisis
    ANALYZING: 'ANALYZING',       // En análisis
    RECOVERABLE: 'RECOVERABLE',   // Puede ser reprocesado
    MANUAL_REVIEW: 'MANUAL_REVIEW', // Requiere revisión manual
    DISCARDED: 'DISCARDED'        // Descartado permanentemente
};

class DeadLetterQueue {
    constructor(name, options = {}) {
        this.name = name;
        this.options = {
            maxSize: options.maxSize || 1000,
            retentionDays: options.retentionDays || 30,
            autoAnalyze: options.autoAnalyze !== false,
            analysisInterval: options.analysisInterval || 3600000, // 1 hora
            storageDir: options.storageDir || path.join(process.cwd(), 'data', 'dlq'),
            ...options
        };

        this.items = [];
        this.analysisPatterns = new Map();
        this.eventBus = getEventBus();
        this.metrics = {
            totalItems: 0,
            processed: 0,
            discarded: 0,
            recovered: 0,
            patterns: {}
        };

        // Asegurar que el directorio existe
        this.ensureStorageDir();

        // Cargar elementos existentes
        this.loadFromDisk();

        // Configurar análisis automático
        if (this.options.autoAnalyze) {
            this.scheduleAnalysis();
        }

        console.log(`💀 DeadLetterQueue "${name}" inicializada:`, {
            maxSize: this.options.maxSize,
            items: this.items.length,
            autoAnalyze: this.options.autoAnalyze
        });
    }

    /**
     * Agregar elemento al DLQ
     */
    async add(item, reason, originalError = null, context = {}) {
        const dlqItem = {
            id: `${this.name}_${Date.now()}_${Math.random()}`,
            timestamp: Date.now(),
            reason,
            status: DLQStatus.PENDING,
            attempts: context.attempts || 0,
            originalItem: item,
            originalError: originalError ? {
                message: originalError.message,
                stack: originalError.stack,
                code: originalError.code,
                status: originalError.status
            } : null,
            context: {
                service: context.service || 'UNKNOWN',
                operation: context.operation || 'UNKNOWN',
                ...context
            },
            analysis: {
                analyzedAt: null,
                pattern: null,
                severity: this.calculateSeverity(reason),
                recoverable: null
            }
        };

        // Agregar a la cola
        this.items.unshift(dlqItem);
        this.metrics.totalItems++;

        // Mantener tamaño máximo
        if (this.items.length > this.options.maxSize) {
            const removed = this.items.splice(this.options.maxSize);
            console.log(`💀 DLQ "${this.name}" eliminó ${removed.length} elementos antiguos`);
        }

        // Guardar en disco
        await this.saveToDisk();

        // Emitir evento
        this.emitEvent('dlq_item_added', {
            itemId: dlqItem.id,
            reason,
            service: dlqItem.context.service,
            severity: dlqItem.analysis.severity
        });

        // Análisis inmediato si está habilitado
        if (this.options.autoAnalyze) {
            setImmediate(() => this.analyzeItem(dlqItem));
        }

        console.log(`💀 Elemento agregado al DLQ "${this.name}":`, {
            id: dlqItem.id,
            reason,
            service: dlqItem.context.service,
            attempts: dlqItem.attempts
        });

        return dlqItem.id;
    }

    /**
     * Calcular severidad del elemento
     */
    calculateSeverity(reason) {
        switch (reason) {
            case DLQReason.FATAL_ERROR:
            case DLQReason.BUSINESS_RULE_VIOLATION:
                return 'CRITICAL';
            case DLQReason.MAX_RETRIES_EXCEEDED:
            case DLQReason.CIRCUIT_BREAKER_OPEN:
                return 'HIGH';
            case DLQReason.TIMEOUT:
            case DLQReason.INVALID_DATA:
                return 'MEDIUM';
            default:
                return 'LOW';
        }
    }

    /**
     * Analizar elemento individual
     */
    async analyzeItem(item) {
        if (item.analysis.analyzedAt) {
            return; // Ya analizado
        }

        item.status = DLQStatus.ANALYZING;
        item.analysis.analyzedAt = Date.now();

        try {
            // Detectar patrón
            const pattern = this.detectPattern(item);
            item.analysis.pattern = pattern;

            // Determinar si es recuperable
            item.analysis.recoverable = this.isRecoverable(item);

            // Actualizar estado
            if (item.analysis.recoverable) {
                item.status = DLQStatus.RECOVERABLE;
            } else {
                item.status = this.requiresManualReview(item) ?
                    DLQStatus.MANUAL_REVIEW : DLQStatus.DISCARDED;
            }

            // Registrar patrón
            this.recordPattern(pattern, item);

            // Emitir evento de análisis
            this.emitEvent('dlq_item_analyzed', {
                itemId: item.id,
                pattern,
                recoverable: item.analysis.recoverable,
                status: item.status
            });

            console.log(`🔍 Elemento DLQ analizado:`, {
                id: item.id,
                pattern,
                recoverable: item.analysis.recoverable,
                status: item.status
            });

        } catch (error) {
            console.error(`❌ Error analizando elemento DLQ ${item.id}:`, error.message);
            item.status = DLQStatus.MANUAL_REVIEW;
        }

        await this.saveToDisk();
    }

    /**
     * Detectar patrón del error
     */
    detectPattern(item) {
        const { reason, originalError, context } = item;

        // Patrón por razón principal
        let pattern = reason;

        // Añadir contexto específico
        if (originalError) {
            if (originalError.code) {
                pattern += `_${originalError.code}`;
            } else if (originalError.status) {
                pattern += `_HTTP_${originalError.status}`;
            }
        }

        // Añadir servicio
        if (context.service) {
            pattern += `_${context.service}`;
        }

        return pattern;
    }

    /**
     * Determinar si un elemento es recuperable
     */
    isRecoverable(item) {
        switch (item.reason) {
            case DLQReason.TIMEOUT:
            case DLQReason.CIRCUIT_BREAKER_OPEN:
                return true; // Problemas temporales

            case DLQReason.MAX_RETRIES_EXCEEDED:
                // Recuperable si el error original era temporal
                if (item.originalError) {
                    const errorCode = item.originalError.code;
                    const httpStatus = item.originalError.status;

                    return errorCode === 'ETIMEDOUT' ||
                           errorCode === 'ECONNREFUSED' ||
                           httpStatus >= 500;
                }
                return false;

            case DLQReason.FATAL_ERROR:
            case DLQReason.BUSINESS_RULE_VIOLATION:
            case DLQReason.INVALID_DATA:
                return false; // Errores no recuperables

            default:
                return false;
        }
    }

    /**
     * Determinar si requiere revisión manual
     */
    requiresManualReview(item) {
        // Alta frecuencia del mismo patrón
        const pattern = item.analysis.pattern;
        const patternCount = this.analysisPatterns.get(pattern)?.count || 0;

        if (patternCount > 10) {
            return true;
        }

        // Errores críticos siempre requieren revisión
        if (item.analysis.severity === 'CRITICAL') {
            return true;
        }

        return false;
    }

    /**
     * Registrar patrón para análisis estadístico
     */
    recordPattern(pattern, item) {
        if (!this.analysisPatterns.has(pattern)) {
            this.analysisPatterns.set(pattern, {
                count: 0,
                firstSeen: Date.now(),
                lastSeen: Date.now(),
                severity: item.analysis.severity,
                items: []
            });
        }

        const patternData = this.analysisPatterns.get(pattern);
        patternData.count++;
        patternData.lastSeen = Date.now();
        patternData.items.push({
            id: item.id,
            timestamp: item.timestamp,
            service: item.context.service
        });

        // Mantener solo los últimos 20 elementos por patrón
        if (patternData.items.length > 20) {
            patternData.items = patternData.items.slice(-20);
        }

        // Actualizar métricas globales
        if (!this.metrics.patterns[pattern]) {
            this.metrics.patterns[pattern] = 0;
        }
        this.metrics.patterns[pattern]++;
    }

    /**
     * Procesar elementos recuperables
     */
    async processRecoverable(callback, options = {}) {
        const limit = options.limit || 10;
        const recoverableItems = this.items
            .filter(item => item.status === DLQStatus.RECOVERABLE)
            .slice(0, limit);

        if (recoverableItems.length === 0) {
            console.log(`💀 No hay elementos recuperables en DLQ "${this.name}"`);
            return { processed: 0, succeeded: 0, failed: 0 };
        }

        console.log(`🔄 Procesando ${recoverableItems.length} elementos recuperables...`);

        let succeeded = 0;
        let failed = 0;

        for (const item of recoverableItems) {
            try {
                await callback(item.originalItem, item.context);

                // Remover del DLQ al éxito
                this.removeItem(item.id);
                succeeded++;
                this.metrics.recovered++;

                this.emitEvent('dlq_item_recovered', {
                    itemId: item.id,
                    pattern: item.analysis.pattern
                });

            } catch (error) {
                failed++;
                item.status = DLQStatus.MANUAL_REVIEW;

                console.error(`❌ Error reprocesando elemento DLQ ${item.id}:`, error.message);

                this.emitEvent('dlq_item_recovery_failed', {
                    itemId: item.id,
                    error: error.message
                });
            }
        }

        await this.saveToDisk();

        console.log(`✅ Procesamiento DLQ completado:`, { succeeded, failed });
        return { processed: recoverableItems.length, succeeded, failed };
    }

    /**
     * Obtener elementos por estado
     */
    getItemsByStatus(status) {
        return this.items.filter(item => item.status === status);
    }

    /**
     * Obtener elementos por patrón
     */
    getItemsByPattern(pattern) {
        return this.items.filter(item => item.analysis.pattern === pattern);
    }

    /**
     * Remover elemento por ID
     */
    removeItem(itemId) {
        const index = this.items.findIndex(item => item.id === itemId);
        if (index !== -1) {
            const removed = this.items.splice(index, 1)[0];
            this.metrics.processed++;

            console.log(`🗑️ Elemento removido del DLQ: ${itemId}`);
            return removed;
        }
        return null;
    }

    /**
     * Limpiar elementos antiguos
     */
    async cleanup() {
        const cutoff = Date.now() - (this.options.retentionDays * 24 * 60 * 60 * 1000);
        const initialLength = this.items.length;

        this.items = this.items.filter(item => item.timestamp >= cutoff);

        const removed = initialLength - this.items.length;
        if (removed > 0) {
            console.log(`🧹 DLQ "${this.name}" limpiado: ${removed} elementos antiguos removidos`);
            await this.saveToDisk();
        }

        return removed;
    }

    /**
     * Programar análisis automático
     */
    scheduleAnalysis() {
        setInterval(async () => {
            const pendingItems = this.items.filter(item => item.status === DLQStatus.PENDING);

            if (pendingItems.length > 0) {
                console.log(`🔍 Analizando ${pendingItems.length} elementos pendientes en DLQ "${this.name}"`);

                for (const item of pendingItems) {
                    await this.analyzeItem(item);
                }
            }

            // Limpieza automática
            await this.cleanup();

        }, this.options.analysisInterval);
    }

    /**
     * Obtener métricas del DLQ
     */
    getMetrics() {
        const statusCounts = {
            [DLQStatus.PENDING]: 0,
            [DLQStatus.ANALYZING]: 0,
            [DLQStatus.RECOVERABLE]: 0,
            [DLQStatus.MANUAL_REVIEW]: 0,
            [DLQStatus.DISCARDED]: 0
        };

        this.items.forEach(item => {
            statusCounts[item.status]++;
        });

        const topPatterns = Object.entries(this.metrics.patterns)
            .sort(([,a], [,b]) => b - a)
            .slice(0, 10)
            .map(([pattern, count]) => ({ pattern, count }));

        return {
            name: this.name,
            totalItems: this.metrics.totalItems,
            currentItems: this.items.length,
            processed: this.metrics.processed,
            recovered: this.metrics.recovered,
            discarded: this.metrics.discarded,
            statusCounts,
            topPatterns,
            patternCount: this.analysisPatterns.size,
            oldestItem: this.items.length > 0 ?
                Math.min(...this.items.map(item => item.timestamp)) : null
        };
    }

    /**
     * Asegurar que el directorio de almacenamiento existe
     */
    ensureStorageDir() {
        if (!fs.existsSync(this.options.storageDir)) {
            fs.mkdirSync(this.options.storageDir, { recursive: true });
        }
    }

    /**
     * Cargar elementos desde disco
     */
    loadFromDisk() {
        const filePath = path.join(this.options.storageDir, `${this.name}_dlq.json`);

        try {
            if (fs.existsSync(filePath)) {
                const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                this.items = data.items || [];
                this.metrics = { ...this.metrics, ...data.metrics };

                console.log(`💾 DLQ "${this.name}" cargado desde disco: ${this.items.length} elementos`);
            }
        } catch (error) {
            console.error(`❌ Error cargando DLQ desde disco:`, error.message);
            this.items = [];
        }
    }

    /**
     * Guardar elementos en disco
     */
    async saveToDisk() {
        const filePath = path.join(this.options.storageDir, `${this.name}_dlq.json`);

        try {
            const data = {
                items: this.items,
                metrics: this.metrics,
                lastSaved: Date.now()
            };

            fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        } catch (error) {
            console.error(`❌ Error guardando DLQ en disco:`, error.message);
        }
    }

    /**
     * Emitir evento al EventBus
     */
    emitEvent(eventType, data) {
        this.eventBus.emitEvent(`dlq.${eventType}`, {
            dlqName: this.name,
            ...data
        }, 'DLQ');
    }

    /**
     * Obtener resumen para dashboard
     */
    getSummary() {
        return {
            name: this.name,
            totalItems: this.items.length,
            recoverable: this.items.filter(item => item.status === DLQStatus.RECOVERABLE).length,
            manualReview: this.items.filter(item => item.status === DLQStatus.MANUAL_REVIEW).length,
            topPattern: this.getTopPattern(),
            lastActivity: this.items.length > 0 ? Math.max(...this.items.map(item => item.timestamp)) : null
        };
    }

    /**
     * Obtener patrón más común
     */
    getTopPattern() {
        const patterns = Object.entries(this.metrics.patterns);
        if (patterns.length === 0) return null;

        const [pattern, count] = patterns.reduce(([maxPattern, maxCount], [pattern, count]) =>
            count > maxCount ? [pattern, count] : [maxPattern, maxCount], ['', 0]);

        return { pattern, count };
    }
}

/**
 * Manager para múltiples Dead Letter Queues
 */
class DeadLetterQueueManager {
    constructor() {
        this.queues = new Map();
        this.eventBus = getEventBus();
    }

    /**
     * Obtener o crear DLQ
     */
    getQueue(name, options = {}) {
        if (!this.queues.has(name)) {
            const queue = new DeadLetterQueue(name, options);
            this.queues.set(name, queue);

            console.log(`📦 DLQ "${name}" registrada`);
        }

        return this.queues.get(name);
    }

    /**
     * Crear DLQs por defecto para el sistema
     */
    createDefaultQueues() {
        // DLQ para recargas GPS
        this.getQueue('gps_recharges', {
            maxSize: 500,
            retentionDays: 30,
            autoAnalyze: true
        });

        // DLQ para recargas VOZ
        this.getQueue('voz_recharges', {
            maxSize: 300,
            retentionDays: 30,
            autoAnalyze: true
        });

        // DLQ para recargas ELIoT
        this.getQueue('eliot_recharges', {
            maxSize: 200,
            retentionDays: 30,
            autoAnalyze: true
        });

        // DLQ para operaciones de health check
        this.getQueue('health_checks', {
            maxSize: 100,
            retentionDays: 7,
            autoAnalyze: true,
            analysisInterval: 1800000 // 30 minutos
        });

        console.log('📚 DLQs por defecto creadas');
    }

    /**
     * Obtener métricas de todas las DLQs
     */
    getAllMetrics() {
        const metrics = {};

        for (const [name, queue] of this.queues) {
            metrics[name] = queue.getMetrics();
        }

        return metrics;
    }

    /**
     * Obtener resumen general
     */
    getGlobalSummary() {
        const summary = {
            totalQueues: this.queues.size,
            totalItems: 0,
            recoverableItems: 0,
            manualReviewItems: 0,
            queues: {}
        };

        for (const [name, queue] of this.queues) {
            const queueSummary = queue.getSummary();
            summary.totalItems += queueSummary.totalItems;
            summary.recoverableItems += queueSummary.recoverable;
            summary.manualReviewItems += queueSummary.manualReview;
            summary.queues[name] = queueSummary;
        }

        return summary;
    }

    /**
     * Limpiar todas las DLQs
     */
    async cleanupAll() {
        console.log('🧹 Limpiando todas las DLQs...');

        let totalCleaned = 0;
        for (const [name, queue] of this.queues) {
            const cleaned = await queue.cleanup();
            totalCleaned += cleaned;
        }

        console.log(`✅ Limpieza completada: ${totalCleaned} elementos removidos`);
        return totalCleaned;
    }
}

// Instancia singleton
let managerInstance = null;

/**
 * Obtener instancia del manager
 */
function getDeadLetterQueueManager() {
    if (!managerInstance) {
        managerInstance = new DeadLetterQueueManager();
        managerInstance.createDefaultQueues();
    }
    return managerInstance;
}

module.exports = {
    DeadLetterQueue,
    DeadLetterQueueManager,
    getDeadLetterQueueManager,
    DLQReason,
    DLQStatus
};