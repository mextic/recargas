const { createServiceLogger, logMetrics } = require('./logger');

// Logger específico para el sistema de errores
const errorLogger = createServiceLogger('ERROR_HANDLER');

/**
 * Sistema de categorización y manejo inteligente de errores
 * Impacto inmediato: Auto-recuperación de errores retriables
 */

// Definición de categorías de errores
const ERROR_CATEGORIES = {
    RETRIABLE: {
        patterns: [
            /insufficient.balance/i,
            /saldo.insuficiente/i,
            /timeout/i,
            /network.error/i,
            /connection.refused/i,
            /temporarily.unavailable/i,
            /service.busy/i,
            /rate.limit/i
        ],
        strategy: {
            maxRetries: 5,
            backoffType: 'exponential',
            baseDelay: 1000,
            maxDelay: 30000,
            alternateProvider: true,
            jitter: true
        },
        escalation: {
            notifyAfterRetries: 3,
            alertThreshold: 10 // errores por hora
        }
    },

    FATAL: {
        patterns: [
            /database.connection.lost/i,
            /redis.connection.failed/i,
            /mongodb.connection.failed/i,
            /invalid.configuration/i,
            /missing.environment.variable/i,
            /permission.denied/i,
            /authentication.failed/i
        ],
        strategy: {
            maxRetries: 0,
            immediateAlert: true,
            systemShutdown: false,
            requiresManualIntervention: true
        },
        escalation: {
            alertChannels: ['email', 'slack'],
            severity: 'critical'
        }
    },

    BUSINESS: {
        patterns: [
            /invalid.sim.number/i,
            /sim.not.found/i,
            /service.not.available.for.operator/i,
            /duplicate.transaction/i,
            /sim.blocked/i,
            /invalid.amount/i,
            /carrier.not.supported/i
        ],
        strategy: {
            maxRetries: 1,
            backoffType: 'fixed',
            baseDelay: 5000,
            quarantine: true,
            notifyAdmin: true
        },
        escalation: {
            alertThreshold: 5, // errores por hora
            requiresReview: true
        }
    }
};

// Estrategias de retry
const RETRY_STRATEGIES = {
    exponential: (attempt, baseDelay, maxDelay, jitter = true) => {
        let delay = Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay);
        if (jitter) {
            delay += Math.random() * 1000; // Add up to 1s jitter
        }
        return delay;
    },

    linear: (attempt, baseDelay, maxDelay) => {
        return Math.min(baseDelay * attempt, maxDelay);
    },

    fixed: (attempt, baseDelay) => {
        return baseDelay;
    }
};

// Contadores de errores para alertas
let errorCounters = {
    hourly: new Map(),
    daily: new Map()
};

// Limpiar contadores cada hora
setInterval(() => {
    errorCounters.hourly.clear();
}, 3600000);

// Limpiar contadores diarios cada 24 horas
setInterval(() => {
    errorCounters.daily.clear();
}, 86400000);

class ErrorHandler {
    constructor(serviceName) {
        this.serviceName = serviceName;
        this.logger = createServiceLogger(`ERROR_HANDLER_${serviceName.toUpperCase()}`);
    }

    /**
     * Clasifica un error según patrones predefinidos
     * @param {Error} error - Error a clasificar
     * @returns {Object} Información de clasificación
     */
    categorizeError(error) {
        const errorMessage = error.message || error.toString();
        
        for (const [category, config] of Object.entries(ERROR_CATEGORIES)) {
            for (const pattern of config.patterns) {
                if (pattern.test(errorMessage)) {
                    this.logger.info(`Error categorizado como ${category}`, {
                        operation: 'categorize_error',
                        errorMessage,
                        category,
                        pattern: pattern.toString()
                    });

                    return {
                        category,
                        config: config.strategy,
                        escalation: config.escalation,
                        originalError: error
                    };
                }
            }
        }

        // Error no categorizado - tratarlo como BUSINESS por defecto
        this.logger.warn('Error no categorizado, usando estrategia BUSINESS por defecto', {
            operation: 'categorize_error',
            errorMessage
        });

        return {
            category: 'BUSINESS',
            config: ERROR_CATEGORIES.BUSINESS.strategy,
            escalation: ERROR_CATEGORIES.BUSINESS.escalation,
            originalError: error
        };
    }

    /**
     * Ejecuta operación con manejo inteligente de errores y reintentos
     * @param {Function} operation - Operación a ejecutar
     * @param {Object} context - Contexto de la operación
     * @param {Object} options - Opciones adicionales
     * @returns {Promise} Resultado de la operación
     */
    async executeWithSmartRetry(operation, context = {}, options = {}) {
        const transactionId = context.transactionId || `txn_${Date.now()}`;
        let attempt = 0;
        let lastError = null;

        this.logger.operation('smart_retry_start', 'Iniciando operación con reintentos inteligentes', {
            transactionId,
            serviceName: this.serviceName,
            context
        });

        while (true) {
            attempt++;
            
            try {
                const startTime = Date.now();
                const result = await operation();
                const duration = Date.now() - startTime;

                // Log de éxito
                this.logger.operation('operation_success', 'Operación ejecutada exitosamente', {
                    transactionId,
                    attempt,
                    duration,
                    serviceName: this.serviceName
                });

                // Métrica de éxito
                logMetrics('operation_completed', {
                    service: this.serviceName,
                    operation: context.operation || 'unknown',
                    success: true,
                    attempts: attempt,
                    duration
                });

                return result;

            } catch (error) {
                lastError = error;
                const errorInfo = this.categorizeError(error);
                const duration = Date.now() - (context.startTime || Date.now());

                // Incrementar contador de errores
                this.incrementErrorCounter(errorInfo.category);

                // Log del error
                this.logger.error(`Error en intento ${attempt}`, error, {
                    operation: 'operation_retry',
                    transactionId,
                    attempt,
                    category: errorInfo.category,
                    serviceName: this.serviceName,
                    duration
                });

                // Verificar si debe hacer retry
                if (attempt >= (errorInfo.config.maxRetries + 1)) {
                    // Agotar intentos
                    this.logger.error('Intentos agotados, operación fallida', error, {
                        operation: 'operation_failed',
                        transactionId,
                        totalAttempts: attempt,
                        category: errorInfo.category,
                        serviceName: this.serviceName
                    });

                    // Manejo según categoría
                    await this.handleFailedOperation(errorInfo, context, attempt);

                    // Métrica de falla
                    logMetrics('operation_failed', {
                        service: this.serviceName,
                        operation: context.operation || 'unknown',
                        errorCategory: errorInfo.category,
                        attempts: attempt,
                        errorMessage: error.message
                    });

                    throw error;
                }

                // Calcular delay para el siguiente intento
                const delay = this.calculateDelay(errorInfo, attempt);

                this.logger.info(`Reintentando en ${delay}ms`, {
                    operation: 'calculate_retry_delay',
                    transactionId,
                    attempt,
                    nextAttemptIn: delay,
                    category: errorInfo.category
                });

                // Esperar antes del siguiente intento
                await this.delay(delay);

                // Intentar proveedor alternativo para errores RETRIABLE
                if (errorInfo.config.alternateProvider && options.alternateProviderCallback) {
                    try {
                        await options.alternateProviderCallback(attempt);
                        this.logger.info('Cambiando a proveedor alternativo', {
                            operation: 'alternate_provider',
                            transactionId,
                            attempt
                        });
                    } catch (providerError) {
                        this.logger.warn('No se pudo cambiar proveedor alternativo', providerError, {
                            operation: 'alternate_provider_failed',
                            transactionId,
                            attempt
                        });
                    }
                }
            }
        }
    }

    /**
     * Calcula el delay para el siguiente intento basado en la estrategia
     */
    calculateDelay(errorInfo, attempt) {
        const { backoffType, baseDelay, maxDelay, jitter } = errorInfo.config;
        const strategy = RETRY_STRATEGIES[backoffType] || RETRY_STRATEGIES.exponential;
        
        return strategy(attempt, baseDelay, maxDelay, jitter);
    }

    /**
     * Maneja operación fallida según la categoría
     */
    async handleFailedOperation(errorInfo, context, attempts) {
        const { category, escalation } = errorInfo;

        switch (category) {
            case 'FATAL':
                if (errorInfo.config.immediateAlert) {
                    await this.sendAlert('CRITICAL', errorInfo.originalError, context, attempts);
                }
                break;

            case 'BUSINESS':
                if (errorInfo.config.quarantine) {
                    await this.quarantineOperation(context);
                }
                if (errorInfo.config.notifyAdmin) {
                    await this.sendAlert('WARNING', errorInfo.originalError, context, attempts);
                }
                break;

            case 'RETRIABLE':
                if (attempts >= (escalation.notifyAfterRetries || 3)) {
                    await this.sendAlert('INFO', errorInfo.originalError, context, attempts);
                }
                break;
        }

        // Verificar thresholds de alertas
        await this.checkAlertThresholds(category, escalation);
    }

    /**
     * Incrementa contador de errores para alertas
     */
    incrementErrorCounter(category) {
        const hourKey = `${category}_${new Date().getHours()}`;
        const dayKey = `${category}_${new Date().toDateString()}`;

        errorCounters.hourly.set(hourKey, (errorCounters.hourly.get(hourKey) || 0) + 1);
        errorCounters.daily.set(dayKey, (errorCounters.daily.get(dayKey) || 0) + 1);
    }

    /**
     * Verifica thresholds de alertas
     */
    async checkAlertThresholds(category, escalation) {
        if (!escalation.alertThreshold) return;

        const hourKey = `${category}_${new Date().getHours()}`;
        const count = errorCounters.hourly.get(hourKey) || 0;

        if (count >= escalation.alertThreshold) {
            await this.sendAlert('THRESHOLD_EXCEEDED', null, {
                category,
                count,
                threshold: escalation.alertThreshold
            });

            // Reset counter para evitar spam
            errorCounters.hourly.set(hourKey, 0);
        }
    }

    /**
     * Envía alerta (placeholder para implementación futura)
     */
    async sendAlert(severity, error, context, attempts = 0) {
        this.logger.error(`ALERT [${severity}]: ${this.serviceName}`, error, {
            operation: 'send_alert',
            severity,
            context,
            attempts,
            timestamp: new Date().toISOString()
        });

        // Métrica de alerta
        logMetrics('alert_sent', {
            service: this.serviceName,
            severity,
            errorMessage: error?.message,
            context: JSON.stringify(context)
        });

        // TODO: Implementar envío real de alertas (Slack, Email, etc.)
        console.log(`🚨 ALERT [${severity}] - ${this.serviceName}: ${error?.message || 'Threshold exceeded'}`);
    }

    /**
     * Pone operación en cuarentena (placeholder)
     */
    async quarantineOperation(context) {
        this.logger.warn('Operación puesta en cuarentena', {
            operation: 'quarantine',
            context,
            serviceName: this.serviceName
        });

        // TODO: Implementar dead letter queue
        logMetrics('operation_quarantined', {
            service: this.serviceName,
            operation: context.operation || 'unknown',
            sim: context.sim
        });
    }

    /**
     * Utility para delay
     */
    async delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Obtiene estadísticas de errores
     */
    getErrorStats() {
        const stats = {
            hourly: Object.fromEntries(errorCounters.hourly),
            daily: Object.fromEntries(errorCounters.daily),
            categories: Object.keys(ERROR_CATEGORIES)
        };

        return stats;
    }
}

// Factory function para crear error handlers
function createErrorHandler(serviceName) {
    return new ErrorHandler(serviceName);
}

// Exportar categorías para tests
const getErrorCategories = () => ERROR_CATEGORIES;

module.exports = {
    ErrorHandler,
    createErrorHandler,
    getErrorCategories,
    ERROR_CATEGORIES
};