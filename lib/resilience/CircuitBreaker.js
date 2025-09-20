/**
 * CircuitBreaker - Patrón Circuit Breaker para resiliencia de servicios
 * Protege contra fallos de servicios externos con estados CLOSED, OPEN, HALF_OPEN
 */

const { EventEmitter } = require('events');
const { getEventBus } = require('../events/EventBus');
const { EventTypes } = require('../events/EventTypes');

/**
 * Estados del Circuit Breaker
 */
const CircuitState = {
    CLOSED: 'CLOSED',       // Normal operation
    OPEN: 'OPEN',           // Circuit breaker activated (blocking calls)
    HALF_OPEN: 'HALF_OPEN'  // Testing if service is back online
};

/**
 * Tipos de error para configuración
 */
const ErrorType = {
    TIMEOUT: 'TIMEOUT',
    CONNECTION: 'CONNECTION',
    SERVER_ERROR: 'SERVER_ERROR',
    RATE_LIMIT: 'RATE_LIMIT'
};

class CircuitBreaker extends EventEmitter {
    constructor(name, options = {}) {
        super();

        this.name = name;
        this.options = {
            failureThreshold: options.failureThreshold || 5,      // Número de fallos para abrir
            recoveryTimeout: options.recoveryTimeout || 60000,    // Tiempo en OPEN antes de HALF_OPEN (ms)
            monitoringPeriod: options.monitoringPeriod || 60000,  // Período de monitoreo (ms)
            halfOpenMaxCalls: options.halfOpenMaxCalls || 3,      // Máximo de llamadas en HALF_OPEN
            slowCallThreshold: options.slowCallThreshold || 5000, // Umbral para llamadas lentas (ms)
            slowCallRateThreshold: options.slowCallRateThreshold || 0.5, // % de llamadas lentas
            minimumThroughput: options.minimumThroughput || 10,   // Mínimo de llamadas para evaluar
            ...options
        };

        // Estado actual
        this.state = CircuitState.CLOSED;
        this.failureCount = 0;
        this.slowCallCount = 0;
        this.totalCallCount = 0;
        this.lastFailureTime = null;
        this.nextAttemptTime = null;
        this.halfOpenCallCount = 0;

        // Métricas por ventana de tiempo
        this.callHistory = [];
        this.eventBus = getEventBus();

        // Limpieza periódica del historial
        this.cleanupInterval = setInterval(() => {
            this.cleanupOldCalls();
        }, this.options.monitoringPeriod);

        console.log(`🔒 CircuitBreaker "${name}" inicializado:`, {
            failureThreshold: this.options.failureThreshold,
            recoveryTimeout: this.options.recoveryTimeout
        });
    }

    /**
     * Ejecutar función protegida por circuit breaker
     */
    async execute(fn, ...args) {
        // Verificar si podemos ejecutar
        if (!this.canExecute()) {
            const error = new Error(`CircuitBreaker "${this.name}" is OPEN - calls blocked`);
            error.circuitBreakerOpen = true;
            this.emitEvent('circuit_breaker_blocked', { reason: 'OPEN_STATE' });
            throw error;
        }

        const startTime = Date.now();
        let call = null;

        try {
            // Registrar inicio de llamada
            call = this.recordCallStart();

            // Ejecutar función
            const result = await fn(...args);

            // Registrar éxito
            this.recordCallSuccess(call, startTime);

            return result;

        } catch (error) {
            // Registrar fallo
            this.recordCallFailure(call, startTime, error);
            throw error;
        }
    }

    /**
     * Verificar si podemos ejecutar
     */
    canExecute() {
        const now = Date.now();

        switch (this.state) {
            case CircuitState.CLOSED:
                return true;

            case CircuitState.OPEN:
                // Verificar si es tiempo de intentar recovery
                if (this.nextAttemptTime && now >= this.nextAttemptTime) {
                    this.transitionToHalfOpen();
                    return true;
                }
                return false;

            case CircuitState.HALF_OPEN:
                // Permitir número limitado de llamadas de prueba
                return this.halfOpenCallCount < this.options.halfOpenMaxCalls;

            default:
                return false;
        }
    }

    /**
     * Registrar inicio de llamada
     */
    recordCallStart() {
        if (this.state === CircuitState.HALF_OPEN) {
            this.halfOpenCallCount++;
        }

        const call = {
            id: `${this.name}_${Date.now()}_${Math.random()}`,
            startTime: Date.now(),
            state: this.state
        };

        this.callHistory.unshift(call);
        this.totalCallCount++;

        return call;
    }

    /**
     * Registrar llamada exitosa
     */
    recordCallSuccess(call, startTime) {
        const duration = Date.now() - startTime;
        const isSlowCall = duration > this.options.slowCallThreshold;

        // Actualizar historial
        call.success = true;
        call.duration = duration;
        call.slowCall = isSlowCall;
        call.endTime = Date.now();

        if (isSlowCall) {
            this.slowCallCount++;
        }

        // Evaluar estado según resultado
        if (this.state === CircuitState.HALF_OPEN) {
            // En HALF_OPEN, si todas las llamadas de prueba son exitosas, volver a CLOSED
            const halfOpenCalls = this.getHalfOpenCalls();
            const allSuccessful = halfOpenCalls.length >= this.options.halfOpenMaxCalls &&
                               halfOpenCalls.every(c => c.success && !c.slowCall);

            if (allSuccessful) {
                this.transitionToClosed();
            }
        } else if (this.state === CircuitState.CLOSED) {
            // Verificar si hay demasiadas llamadas lentas
            this.evaluateSlowCalls();
        }

        this.emitEvent('call_success', {
            duration,
            slowCall: isSlowCall,
            state: this.state
        });
    }

    /**
     * Registrar llamada fallida
     */
    recordCallFailure(call, startTime, error) {
        const duration = Date.now() - startTime;

        // Actualizar historial
        call.success = false;
        call.duration = duration;
        call.error = {
            message: error.message,
            type: this.categorizeError(error),
            code: error.code
        };
        call.endTime = Date.now();

        this.failureCount++;
        this.lastFailureTime = Date.now();

        // Evaluar si abrir circuit breaker
        if (this.state === CircuitState.HALF_OPEN) {
            // En HALF_OPEN, cualquier fallo vuelve a OPEN
            this.transitionToOpen();
        } else if (this.state === CircuitState.CLOSED) {
            // Evaluar si abrir por número de fallos
            this.evaluateFailures();
        }

        this.emitEvent('call_failure', {
            duration,
            errorType: call.error.type,
            errorMessage: error.message,
            state: this.state
        });
    }

    /**
     * Categorizar tipo de error
     */
    categorizeError(error) {
        if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
            return ErrorType.CONNECTION;
        }
        if (error.code === 'ETIMEDOUT' || error.message?.includes('timeout')) {
            return ErrorType.TIMEOUT;
        }
        if (error.status >= 500) {
            return ErrorType.SERVER_ERROR;
        }
        if (error.status === 429) {
            return ErrorType.RATE_LIMIT;
        }
        return 'UNKNOWN';
    }

    /**
     * Evaluar fallos para decidir si abrir
     */
    evaluateFailures() {
        const recentCalls = this.getRecentCalls();

        if (recentCalls.length < this.options.minimumThroughput) {
            return; // No hay suficientes llamadas para evaluar
        }

        const failures = recentCalls.filter(call => !call.success);
        const failureRate = failures.length / recentCalls.length;

        // Evaluar por número absoluto de fallos consecutivos
        const recentFailures = recentCalls.slice(0, this.options.failureThreshold);
        const allRecentFailed = recentFailures.every(call => !call.success);

        if (allRecentFailed && recentFailures.length >= this.options.failureThreshold) {
            this.transitionToOpen();
        }
    }

    /**
     * Evaluar llamadas lentas
     */
    evaluateSlowCalls() {
        const recentCalls = this.getRecentCalls();

        if (recentCalls.length < this.options.minimumThroughput) {
            return;
        }

        const slowCalls = recentCalls.filter(call => call.slowCall);
        const slowCallRate = slowCalls.length / recentCalls.length;

        if (slowCallRate >= this.options.slowCallRateThreshold) {
            this.transitionToOpen();
        }
    }

    /**
     * Transición a estado OPEN
     */
    transitionToOpen() {
        if (this.state === CircuitState.OPEN) return;

        this.state = CircuitState.OPEN;
        this.nextAttemptTime = Date.now() + this.options.recoveryTimeout;
        this.halfOpenCallCount = 0;

        console.log(`🔴 CircuitBreaker "${this.name}" OPEN - blocking calls for ${this.options.recoveryTimeout}ms`);

        this.emitEvent('circuit_breaker_opened', {
            failureCount: this.failureCount,
            recoveryTimeout: this.options.recoveryTimeout,
            nextAttemptTime: this.nextAttemptTime
        });

        this.emit('open');
    }

    /**
     * Transición a estado HALF_OPEN
     */
    transitionToHalfOpen() {
        if (this.state === CircuitState.HALF_OPEN) return;

        this.state = CircuitState.HALF_OPEN;
        this.halfOpenCallCount = 0;

        console.log(`🟡 CircuitBreaker "${this.name}" HALF_OPEN - testing with limited calls`);

        this.emitEvent('circuit_breaker_half_opened', {
            maxTestCalls: this.options.halfOpenMaxCalls
        });

        this.emit('half_open');
    }

    /**
     * Transición a estado CLOSED
     */
    transitionToClosed() {
        if (this.state === CircuitState.CLOSED) return;

        this.state = CircuitState.CLOSED;
        this.failureCount = 0;
        this.slowCallCount = 0;
        this.halfOpenCallCount = 0;
        this.lastFailureTime = null;
        this.nextAttemptTime = null;

        console.log(`🟢 CircuitBreaker "${this.name}" CLOSED - normal operation resumed`);

        this.emitEvent('circuit_breaker_closed', {
            resetTime: Date.now()
        });

        this.emit('closed');
    }

    /**
     * Obtener llamadas recientes dentro del período de monitoreo
     */
    getRecentCalls() {
        const cutoff = Date.now() - this.options.monitoringPeriod;
        return this.callHistory.filter(call => call.startTime >= cutoff);
    }

    /**
     * Obtener llamadas de prueba en estado HALF_OPEN
     */
    getHalfOpenCalls() {
        return this.callHistory.filter(call => call.state === CircuitState.HALF_OPEN);
    }

    /**
     * Limpiar llamadas antiguas del historial
     */
    cleanupOldCalls() {
        const cutoff = Date.now() - (this.options.monitoringPeriod * 2);
        const initialLength = this.callHistory.length;

        this.callHistory = this.callHistory.filter(call => call.startTime >= cutoff);

        const cleaned = initialLength - this.callHistory.length;
        if (cleaned > 0) {
            console.log(`🧹 CircuitBreaker "${this.name}" cleaned ${cleaned} old calls`);
        }
    }

    /**
     * Emitir evento al EventBus
     */
    emitEvent(eventType, data) {
        this.eventBus.emitEvent(`circuit_breaker.${eventType}`, {
            circuitBreaker: this.name,
            state: this.state,
            ...data
        }, 'CIRCUIT_BREAKER');
    }

    /**
     * Obtener métricas actuales
     */
    getMetrics() {
        const recentCalls = this.getRecentCalls();
        const successful = recentCalls.filter(call => call.success).length;
        const failed = recentCalls.filter(call => !call.success).length;
        const slow = recentCalls.filter(call => call.slowCall).length;

        return {
            name: this.name,
            state: this.state,
            failureCount: this.failureCount,
            totalCalls: this.totalCallCount,
            recentCalls: recentCalls.length,
            successfulCalls: successful,
            failedCalls: failed,
            slowCalls: slow,
            failureRate: recentCalls.length > 0 ? failed / recentCalls.length : 0,
            slowCallRate: recentCalls.length > 0 ? slow / recentCalls.length : 0,
            averageResponseTime: this.calculateAverageResponseTime(recentCalls),
            lastFailureTime: this.lastFailureTime,
            nextAttemptTime: this.nextAttemptTime,
            halfOpenCallCount: this.halfOpenCallCount
        };
    }

    /**
     * Calcular tiempo promedio de respuesta
     */
    calculateAverageResponseTime(calls) {
        if (calls.length === 0) return 0;

        const completedCalls = calls.filter(call => call.duration);
        if (completedCalls.length === 0) return 0;

        const totalDuration = completedCalls.reduce((sum, call) => sum + call.duration, 0);
        return Math.round(totalDuration / completedCalls.length);
    }

    /**
     * Reset manual del circuit breaker
     */
    reset() {
        console.log(`🔄 CircuitBreaker "${this.name}" manually reset`);

        this.callHistory = [];
        this.transitionToClosed();

        this.emitEvent('circuit_breaker_reset', {
            resetTime: Date.now(),
            manual: true
        });
    }

    /**
     * Forzar estado OPEN (para testing)
     */
    forceOpen() {
        console.log(`🔴 CircuitBreaker "${this.name}" manually forced OPEN`);
        this.transitionToOpen();
    }

    /**
     * Destructor - limpiar recursos
     */
    destroy() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
        }

        console.log(`🗑️ CircuitBreaker "${this.name}" destroyed`);
        this.removeAllListeners();
    }
}

/**
 * Manager para múltiples Circuit Breakers
 */
class CircuitBreakerManager {
    constructor() {
        this.circuitBreakers = new Map();
        this.eventBus = getEventBus();
    }

    /**
     * Crear o obtener circuit breaker
     */
    getCircuitBreaker(name, options = {}) {
        if (!this.circuitBreakers.has(name)) {
            const circuitBreaker = new CircuitBreaker(name, options);
            this.circuitBreakers.set(name, circuitBreaker);

            console.log(`🔧 CircuitBreaker "${name}" registered`);
        }

        return this.circuitBreakers.get(name);
    }

    /**
     * Obtener métricas de todos los circuit breakers
     */
    getAllMetrics() {
        const metrics = {};

        for (const [name, cb] of this.circuitBreakers) {
            metrics[name] = cb.getMetrics();
        }

        return metrics;
    }

    /**
     * Reset de todos los circuit breakers
     */
    resetAll() {
        console.log('🔄 Resetting all circuit breakers');

        for (const [name, cb] of this.circuitBreakers) {
            cb.reset();
        }
    }

    /**
     * Obtener estado resumido
     */
    getStatus() {
        const status = {
            total: this.circuitBreakers.size,
            open: 0,
            halfOpen: 0,
            closed: 0,
            details: {}
        };

        for (const [name, cb] of this.circuitBreakers) {
            const metrics = cb.getMetrics();

            switch (metrics.state) {
                case CircuitState.OPEN:
                    status.open++;
                    break;
                case CircuitState.HALF_OPEN:
                    status.halfOpen++;
                    break;
                case CircuitState.CLOSED:
                    status.closed++;
                    break;
            }

            status.details[name] = {
                state: metrics.state,
                failureRate: metrics.failureRate,
                slowCallRate: metrics.slowCallRate,
                recentCalls: metrics.recentCalls
            };
        }

        return status;
    }

    /**
     * Destruir todos los circuit breakers
     */
    destroy() {
        console.log('🗑️ Destroying all circuit breakers');

        for (const [name, cb] of this.circuitBreakers) {
            cb.destroy();
        }

        this.circuitBreakers.clear();
    }
}

// Instancia singleton
let managerInstance = null;

/**
 * Obtener instancia del manager
 */
function getCircuitBreakerManager() {
    if (!managerInstance) {
        managerInstance = new CircuitBreakerManager();
    }
    return managerInstance;
}

module.exports = {
    CircuitBreaker,
    CircuitBreakerManager,
    getCircuitBreakerManager,
    CircuitState,
    ErrorType
};