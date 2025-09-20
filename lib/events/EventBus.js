/**
 * EventBus Central - Single Source of Truth para eventos del sistema
 * Maneja la distribución de eventos tanto para terminal como web dashboard
 */

const EventEmitter = require('events');
const { EventTypes, EventPriorities, EventFactory } = require('./EventTypes');

class EventBus extends EventEmitter {
    constructor() {
        super();
        this.eventHistory = [];
        this.maxHistorySize = 1000;
        this.metrics = {
            totalEvents: 0,
            eventsByType: {},
            eventsByService: {},
            startTime: Date.now()
        };

        // Estado actual del sistema
        this.systemState = {
            activeProcesses: new Map(),
            currentProgress: new Map(),
            lastMetrics: new Map(),
            systemStatus: 'idle'
        };

        // Configurar límite de listeners para evitar warnings
        this.setMaxListeners(50);

        this.setupInternalListeners();

        console.log('🌟 EventBus inicializado - Sistema de eventos unificado activo');
    }

    /**
     * Configura listeners internos para mantenimiento del estado
     */
    setupInternalListeners() {
        // Listener para mantener historial
        this.on('*', (event) => {
            this.addToHistory(event);
            this.updateMetrics(event);
        });

        // Listener para procesos activos
        this.on(EventTypes.PROCESS_START, (event) => {
            this.systemState.activeProcesses.set(event.service, {
                startTime: event.timestamp,
                processId: event.data.processId
            });
            this.systemState.systemStatus = 'processing';
        });

        this.on(EventTypes.PROCESS_END, (event) => {
            this.systemState.activeProcesses.delete(event.service);
            if (this.systemState.activeProcesses.size === 0) {
                this.systemState.systemStatus = 'idle';
            }
        });

        // Listener para progreso actual
        this.on(EventTypes.PROGRESS_UPDATE, (event) => {
            this.systemState.currentProgress.set(event.service, {
                current: event.data.current,
                total: event.data.total,
                percentage: event.data.percentage,
                message: event.data.message,
                lastUpdate: event.timestamp
            });
        });

        this.on(EventTypes.PROGRESS_COMPLETE, (event) => {
            this.systemState.currentProgress.delete(event.service);
        });

        // Listener para métricas
        this.on(EventTypes.METRICS_UPDATE, (event) => {
            this.systemState.lastMetrics.set(event.service, event.data);
        });
    }

    /**
     * Emite un evento y lo propaga a todos los listeners
     */
    emitEvent(eventType, data = {}, service = 'SYSTEM') {
        const event = EventFactory.createEvent(eventType, data, service);

        // Emitir evento específico
        this.emit(eventType, event);

        // Emitir wildcard para listeners generales
        this.emit('*', event);

        // Log crítico/error inmediatamente
        if (event.priority >= EventPriorities.HIGH) {
            this.logCriticalEvent(event);
        }

        return event;
    }

    /**
     * Shortcut para emitir evento de progreso
     */
    emitProgress(service, current, total, message, details = {}) {
        return this.emitEvent(EventTypes.PROGRESS_UPDATE, {
            current,
            total,
            percentage: Math.round((current / total) * 100),
            message,
            ...details
        }, service);
    }

    /**
     * Shortcut para emitir recarga exitosa
     */
    emitRechargeSuccess(service, rechargeData) {
        return this.emitEvent(EventTypes.RECHARGE_SUCCESS, rechargeData, service);
    }

    /**
     * Shortcut para emitir error de recarga
     */
    emitRechargeError(service, rechargeData, error) {
        return this.emitEvent(EventTypes.RECHARGE_ERROR, {
            ...rechargeData,
            error: {
                message: error.message,
                code: error.code,
                type: error.name
            }
        }, service);
    }

    /**
     * Shortcut para emitir métricas
     */
    emitMetrics(service, metrics) {
        return this.emitEvent(EventTypes.METRICS_UPDATE, metrics, service);
    }

    /**
     * Agregar evento al historial
     */
    addToHistory(event) {
        this.eventHistory.unshift(event);

        // Mantener tamaño del historial
        if (this.eventHistory.length > this.maxHistorySize) {
            this.eventHistory = this.eventHistory.slice(0, this.maxHistorySize);
        }
    }

    /**
     * Actualizar métricas internas
     */
    updateMetrics(event) {
        this.metrics.totalEvents++;

        // Métricas por tipo
        if (!this.metrics.eventsByType[event.type]) {
            this.metrics.eventsByType[event.type] = 0;
        }
        this.metrics.eventsByType[event.type]++;

        // Métricas por servicio
        if (!this.metrics.eventsByService[event.service]) {
            this.metrics.eventsByService[event.service] = 0;
        }
        this.metrics.eventsByService[event.service]++;
    }

    /**
     * Log eventos críticos inmediatamente
     */
    logCriticalEvent(event) {
        const { EventIcons, EventColors } = require('./EventTypes');
        const icon = EventIcons[event.type] || EventIcons.default;
        const color = EventColors[event.type] || EventColors.default;
        const reset = '\x1b[0m';

        console.log(`${color}${icon} [${event.service}] ${event.data.message || event.type}${reset}`);
    }

    /**
     * Obtener historial de eventos con filtros opcionales
     */
    getEventHistory(options = {}) {
        let { limit = 50, service = null, type = null, priority = null } = options;

        let filteredEvents = this.eventHistory;

        // Filtrar por servicio
        if (service) {
            filteredEvents = filteredEvents.filter(event => event.service === service);
        }

        // Filtrar por tipo
        if (type) {
            filteredEvents = filteredEvents.filter(event => event.type === type);
        }

        // Filtrar por prioridad mínima
        if (priority) {
            filteredEvents = filteredEvents.filter(event => event.priority >= priority);
        }

        return filteredEvents.slice(0, limit);
    }

    /**
     * Obtener métricas actuales del sistema
     */
    getMetrics() {
        const uptime = Date.now() - this.metrics.startTime;
        const eventsPerMinute = this.metrics.totalEvents / (uptime / 60000);

        return {
            ...this.metrics,
            uptime,
            eventsPerMinute: Math.round(eventsPerMinute * 100) / 100,
            systemState: this.systemState
        };
    }

    /**
     * Obtener estado actual del progreso para todos los servicios
     */
    getCurrentProgress() {
        const progress = {};
        for (const [service, data] of this.systemState.currentProgress) {
            progress[service] = data;
        }
        return progress;
    }

    /**
     * Obtener estado de procesos activos
     */
    getActiveProcesses() {
        const processes = {};
        for (const [service, data] of this.systemState.activeProcesses) {
            processes[service] = {
                ...data,
                duration: Date.now() - data.startTime
            };
        }
        return processes;
    }

    /**
     * Resetear historial y métricas
     */
    reset() {
        this.eventHistory = [];
        this.metrics = {
            totalEvents: 0,
            eventsByType: {},
            eventsByService: {},
            startTime: Date.now()
        };
        this.systemState.activeProcesses.clear();
        this.systemState.currentProgress.clear();
        this.systemState.lastMetrics.clear();
        this.systemState.systemStatus = 'idle';

        this.emitEvent(EventTypes.SYSTEM_START, { message: 'EventBus reset completado' });
    }

    /**
     * Subscription helper con auto-cleanup
     */
    subscribe(eventType, handler, options = {}) {
        const { once = false, filter = null } = options;

        const wrappedHandler = (event) => {
            // Aplicar filtro si está definido
            if (filter && !filter(event)) {
                return;
            }

            handler(event);
        };

        if (once) {
            this.once(eventType, wrappedHandler);
        } else {
            this.on(eventType, wrappedHandler);
        }

        // Retornar función de cleanup
        return () => {
            this.removeListener(eventType, wrappedHandler);
        };
    }

    /**
     * Subscription a todos los eventos
     */
    subscribeToAll(handler, options = {}) {
        return this.subscribe('*', handler, options);
    }

    /**
     * Subscription a eventos de un servicio específico
     */
    subscribeToService(service, handler, options = {}) {
        return this.subscribe('*', handler, {
            ...options,
            filter: (event) => event.service === service
        });
    }

    /**
     * Subscription a eventos de alta prioridad
     */
    subscribeToHighPriority(handler, options = {}) {
        return this.subscribe('*', handler, {
            ...options,
            filter: (event) => event.priority >= EventPriorities.HIGH
        });
    }

    /**
     * Pausar/reanudar eventos (útil para testing)
     */
    pause() {
        this._paused = true;
    }

    resume() {
        this._paused = false;
    }

    /**
     * Override emit para manejar pausa
     */
    emit(eventType, ...args) {
        if (this._paused && eventType !== 'error') {
            return false;
        }
        return super.emit(eventType, ...args);
    }

    /**
     * Debugging - mostrar estadísticas
     */
    debugStats() {
        const metrics = this.getMetrics();
        console.log('\n📊 EventBus Statistics:');
        console.log(`Total Events: ${metrics.totalEvents}`);
        console.log(`Uptime: ${Math.round(metrics.uptime / 1000)}s`);
        console.log(`Events/min: ${metrics.eventsPerMinute}`);
        console.log(`Active Processes: ${Object.keys(this.getActiveProcesses()).length}`);
        console.log(`Current Progress: ${Object.keys(this.getCurrentProgress()).length}`);
        console.log(`History Size: ${this.eventHistory.length}`);
        console.log('');
    }
}

// Singleton instance
let instance = null;

/**
 * Obtener instancia singleton del EventBus
 */
function getEventBus() {
    if (!instance) {
        instance = new EventBus();
    }
    return instance;
}

/**
 * Helper para crear evento rápidamente
 */
function createEvent(type, data, service) {
    return EventFactory.createEvent(type, data, service);
}

module.exports = {
    EventBus,
    getEventBus,
    createEvent
};