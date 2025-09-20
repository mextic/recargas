/**
 * Definición de tipos de eventos normalizados para el sistema de recargas
 * Utilizados tanto por el dashboard terminal como el dashboard web
 */

const EventTypes = {
    // === EVENTOS DE PROCESO ===
    PROCESS_START: 'process.start',
    PROCESS_END: 'process.end',
    PROCESS_ERROR: 'process.error',

    // === EVENTOS DE PROGRESO ===
    PROGRESS_START: 'progress.start',
    PROGRESS_UPDATE: 'progress.update',
    PROGRESS_COMPLETE: 'progress.complete',

    // === EVENTOS DE RECARGAS ===
    RECHARGE_START: 'recharge.start',
    RECHARGE_SUCCESS: 'recharge.success',
    RECHARGE_ERROR: 'recharge.error',
    RECHARGE_RETRY: 'recharge.retry',

    // === EVENTOS DE COLA AUXILIAR ===
    QUEUE_UPDATE: 'queue.update',
    QUEUE_RECOVERY_START: 'queue.recovery.start',
    QUEUE_RECOVERY_END: 'queue.recovery.end',
    QUEUE_ITEM_PROCESSED: 'queue.item.processed',

    // === EVENTOS DE WEBSERVICE ===
    WEBSERVICE_REQUEST: 'webservice.request',
    WEBSERVICE_RESPONSE: 'webservice.response',
    WEBSERVICE_ERROR: 'webservice.error',
    WEBSERVICE_TIMEOUT: 'webservice.timeout',

    // === EVENTOS DE MÉTRICAS ===
    METRICS_UPDATE: 'metrics.update',
    PERFORMANCE_UPDATE: 'performance.update',
    BALANCE_UPDATE: 'balance.update',

    // === EVENTOS DE SISTEMA ===
    SYSTEM_START: 'system.start',
    SYSTEM_READY: 'system.ready',
    SYSTEM_ERROR: 'system.error',
    LOCK_ACQUIRED: 'lock.acquired',
    LOCK_RELEASED: 'lock.released',

    // === EVENTOS DE BASE DE DATOS ===
    DB_CONNECTED: 'db.connected',
    DB_ERROR: 'db.error',
    DB_QUERY_START: 'db.query.start',
    DB_QUERY_END: 'db.query.end',

    // === EVENTOS DE ALERTAS ===
    ALERT_INFO: 'alert.info',
    ALERT_WARNING: 'alert.warning',
    ALERT_ERROR: 'alert.error',
    ALERT_CRITICAL: 'alert.critical'
};

/**
 * Prioridades de eventos para filtering y alerting
 */
const EventPriorities = {
    LOW: 1,
    NORMAL: 2,
    HIGH: 3,
    CRITICAL: 4
};

/**
 * Configuración de prioridades por tipo de evento
 */
const EventPriorityMap = {
    [EventTypes.SYSTEM_START]: EventPriorities.HIGH,
    [EventTypes.SYSTEM_READY]: EventPriorities.HIGH,
    [EventTypes.SYSTEM_ERROR]: EventPriorities.CRITICAL,

    [EventTypes.PROCESS_START]: EventPriorities.NORMAL,
    [EventTypes.PROCESS_END]: EventPriorities.NORMAL,
    [EventTypes.PROCESS_ERROR]: EventPriorities.HIGH,

    [EventTypes.RECHARGE_SUCCESS]: EventPriorities.LOW,
    [EventTypes.RECHARGE_ERROR]: EventPriorities.HIGH,
    [EventTypes.RECHARGE_RETRY]: EventPriorities.NORMAL,

    [EventTypes.QUEUE_RECOVERY_START]: EventPriorities.HIGH,
    [EventTypes.QUEUE_RECOVERY_END]: EventPriorities.HIGH,

    [EventTypes.WEBSERVICE_ERROR]: EventPriorities.HIGH,
    [EventTypes.WEBSERVICE_TIMEOUT]: EventPriorities.HIGH,

    [EventTypes.DB_ERROR]: EventPriorities.CRITICAL,

    [EventTypes.ALERT_CRITICAL]: EventPriorities.CRITICAL,
    [EventTypes.ALERT_ERROR]: EventPriorities.HIGH,
    [EventTypes.ALERT_WARNING]: EventPriorities.NORMAL,
    [EventTypes.ALERT_INFO]: EventPriorities.LOW
};

/**
 * Códigos de color para visualización
 */
const EventColors = {
    [EventTypes.RECHARGE_SUCCESS]: '\x1b[32m',    // Verde
    [EventTypes.RECHARGE_ERROR]: '\x1b[31m',      // Rojo
    [EventTypes.RECHARGE_RETRY]: '\x1b[33m',      // Amarillo
    [EventTypes.PROCESS_START]: '\x1b[36m',       // Cyan
    [EventTypes.PROCESS_END]: '\x1b[32m',         // Verde
    [EventTypes.QUEUE_UPDATE]: '\x1b[35m',        // Magenta
    [EventTypes.WEBSERVICE_REQUEST]: '\x1b[34m',  // Azul
    [EventTypes.SYSTEM_ERROR]: '\x1b[31m\x1b[1m', // Rojo bold
    default: '\x1b[37m'                           // Blanco
};

/**
 * Iconos para diferentes tipos de eventos
 */
const EventIcons = {
    [EventTypes.RECHARGE_SUCCESS]: '✅',
    [EventTypes.RECHARGE_ERROR]: '❌',
    [EventTypes.RECHARGE_RETRY]: '🔄',
    [EventTypes.PROCESS_START]: '🚀',
    [EventTypes.PROCESS_END]: '🏁',
    [EventTypes.QUEUE_UPDATE]: '📦',
    [EventTypes.WEBSERVICE_REQUEST]: '🌐',
    [EventTypes.WEBSERVICE_ERROR]: '⚠️',
    [EventTypes.SYSTEM_START]: '🟢',
    [EventTypes.SYSTEM_ERROR]: '🔴',
    [EventTypes.DB_CONNECTED]: '🗄️',
    [EventTypes.LOCK_ACQUIRED]: '🔐',
    [EventTypes.LOCK_RELEASED]: '🔓',
    [EventTypes.METRICS_UPDATE]: '📊',
    [EventTypes.ALERT_CRITICAL]: '🚨',
    [EventTypes.ALERT_WARNING]: '⚠️',
    [EventTypes.ALERT_INFO]: 'ℹ️',
    default: '📝'
};

/**
 * Servicios disponibles
 */
const Services = {
    GPS: 'GPS',
    VOZ: 'VOZ',
    ELIOT: 'ELIOT',
    SYSTEM: 'SYSTEM'
};

/**
 * Factory para crear eventos normalizados
 */
class EventFactory {
    /**
     * Crea un evento base con estructura normalizada
     */
    static createEvent(type, data = {}, service = Services.SYSTEM) {
        const event = {
            id: `event_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            type,
            service,
            timestamp: Date.now(),
            datetime: new Date().toISOString(),
            priority: EventPriorityMap[type] || EventPriorities.NORMAL,
            data: {
                ...data
            },
            metadata: {
                version: '2.2.0',
                environment: process.env.NODE_ENV || 'development',
                hostname: require('os').hostname(),
                pid: process.pid
            }
        };

        return event;
    }

    /**
     * Crea evento de progreso
     */
    static createProgressEvent(service, current, total, message, details = {}) {
        return this.createEvent(EventTypes.PROGRESS_UPDATE, {
            current,
            total,
            percentage: Math.round((current / total) * 100),
            message,
            ...details
        }, service);
    }

    /**
     * Crea evento de recarga exitosa
     */
    static createRechargeSuccessEvent(service, rechargeData) {
        return this.createEvent(EventTypes.RECHARGE_SUCCESS, {
            sim: rechargeData.sim,
            vehicle: rechargeData.vehicle,
            company: rechargeData.company,
            amount: rechargeData.amount,
            folio: rechargeData.folio,
            provider: rechargeData.provider,
            minutesSinceLastReport: rechargeData.minutesSinceLastReport,
            responseTime: rechargeData.responseTime
        }, service);
    }

    /**
     * Crea evento de error de recarga
     */
    static createRechargeErrorEvent(service, rechargeData, error) {
        return this.createEvent(EventTypes.RECHARGE_ERROR, {
            sim: rechargeData.sim,
            vehicle: rechargeData.vehicle,
            company: rechargeData.company,
            error: {
                message: error.message,
                code: error.code,
                type: error.name
            },
            attemptNumber: rechargeData.attemptNumber || 1,
            willRetry: rechargeData.willRetry || false
        }, service);
    }

    /**
     * Crea evento de métricas
     */
    static createMetricsEvent(service, metrics) {
        return this.createEvent(EventTypes.METRICS_UPDATE, {
            processed: metrics.processed || 0,
            successful: metrics.successful || 0,
            failed: metrics.failed || 0,
            pending: metrics.pending || 0,
            queueSize: metrics.queueSize || 0,
            balance: metrics.balance || 0,
            elapsedTime: metrics.elapsedTime || 0,
            estimatedTimeRemaining: metrics.estimatedTimeRemaining || 0
        }, service);
    }
}

module.exports = {
    EventTypes,
    EventPriorities,
    EventPriorityMap,
    EventColors,
    EventIcons,
    Services,
    EventFactory
};