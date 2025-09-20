/**
 * RetryStrategy - Estrategias de reintento exponencial con jitter
 * Implementa backoff exponencial, límites configurables y categorización de errores
 */

const { getEventBus } = require('../events/EventBus');
const { EventTypes } = require('../events/EventTypes');

/**
 * Tipos de estrategia de retry
 */
const RetryType = {
    EXPONENTIAL: 'EXPONENTIAL',
    LINEAR: 'LINEAR',
    FIXED: 'FIXED',
    CUSTOM: 'CUSTOM'
};

/**
 * Categorías de error para diferentes estrategias
 */
const ErrorCategory = {
    RETRIABLE: 'RETRIABLE',         // Timeout, conexión, 5xx
    FATAL: 'FATAL',                 // Configuración, auth, 4xx (excepto 429)
    RATE_LIMITED: 'RATE_LIMITED',   // 429, rate limiting
    BUSINESS: 'BUSINESS'            // SIM inválido, saldo insuficiente
};

class RetryStrategy {
    constructor(name, options = {}) {
        this.name = name;
        this.options = {
            maxAttempts: options.maxAttempts || 3,
            baseDelay: options.baseDelay || 1000,        // Delay inicial en ms
            maxDelay: options.maxDelay || 30000,         // Delay máximo en ms
            multiplier: options.multiplier || 2,         // Factor de multiplicación
            jitterType: options.jitterType || 'FULL',    // NONE, EQUAL, FULL
            retryType: options.retryType || RetryType.EXPONENTIAL,

            // Categorización de errores
            retriableErrors: options.retriableErrors || [
                'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND',
                'ECONNRESET', 'EHOSTUNREACH'
            ],
            retriableHttpCodes: options.retriableHttpCodes || [500, 502, 503, 504, 429],

            // Configuración específica por categoría
            categoryConfig: {
                [ErrorCategory.RETRIABLE]: {
                    maxAttempts: options.maxAttempts || 3,
                    baseDelay: options.baseDelay || 1000,
                    multiplier: options.multiplier || 2
                },
                [ErrorCategory.RATE_LIMITED]: {
                    maxAttempts: options.rateLimitMaxAttempts || 5,
                    baseDelay: options.rateLimitBaseDelay || 5000,
                    multiplier: options.rateLimitMultiplier || 1.5
                },
                [ErrorCategory.BUSINESS]: {
                    maxAttempts: options.businessMaxAttempts || 2,
                    baseDelay: options.businessBaseDelay || 10000,
                    multiplier: options.businessMultiplier || 1
                },
                [ErrorCategory.FATAL]: {
                    maxAttempts: 0, // No retry for fatal errors
                    baseDelay: 0,
                    multiplier: 0
                }
            },

            ...options
        };

        this.eventBus = getEventBus();
        this.metrics = {
            totalAttempts: 0,
            successfulRetries: 0,
            failedRetries: 0,
            categoryCounts: {
                [ErrorCategory.RETRIABLE]: 0,
                [ErrorCategory.FATAL]: 0,
                [ErrorCategory.RATE_LIMITED]: 0,
                [ErrorCategory.BUSINESS]: 0
            }
        };

        console.log(`🔄 RetryStrategy "${name}" initialized:`, {
            maxAttempts: this.options.maxAttempts,
            baseDelay: this.options.baseDelay,
            retryType: this.options.retryType
        });
    }

    /**
     * Ejecutar función con retry automático
     */
    async execute(fn, context = {}) {
        const operationId = `${this.name}_${Date.now()}_${Math.random()}`;
        let lastError = null;
        let attempt = 0;

        this.emitEvent('retry_operation_start', {
            operationId,
            context,
            maxAttempts: this.options.maxAttempts
        });

        while (attempt < this.options.maxAttempts) {
            attempt++;
            this.metrics.totalAttempts++;

            try {
                // Emitir evento de intento
                this.emitEvent('retry_attempt_start', {
                    operationId,
                    attempt,
                    maxAttempts: this.options.maxAttempts,
                    context
                });

                // Ejecutar función
                const result = await fn();

                // Éxito
                if (attempt > 1) {
                    this.metrics.successfulRetries++;
                    this.emitEvent('retry_success', {
                        operationId,
                        totalAttempts: attempt,
                        context
                    });
                }

                return result;

            } catch (error) {
                lastError = error;

                // Categorizar error
                const category = this.categorizeError(error);
                this.metrics.categoryCounts[category]++;

                // Obtener configuración para esta categoría
                const categoryConfig = this.options.categoryConfig[category];

                this.emitEvent('retry_attempt_failed', {
                    operationId,
                    attempt,
                    error: error.message,
                    category,
                    context
                });

                // Verificar si debe continuar reintentando
                if (!this.shouldRetry(error, attempt, category, categoryConfig)) {
                    break;
                }

                // Calcular delay para próximo intento
                if (attempt < this.options.maxAttempts) {
                    const delay = this.calculateDelay(attempt, category, categoryConfig);

                    this.emitEvent('retry_waiting', {
                        operationId,
                        attempt,
                        nextAttemptIn: delay,
                        category,
                        context
                    });

                    await this.sleep(delay);
                }
            }
        }

        // Todos los intentos fallaron
        this.metrics.failedRetries++;

        this.emitEvent('retry_operation_failed', {
            operationId,
            totalAttempts: attempt,
            finalError: lastError.message,
            category: this.categorizeError(lastError),
            context
        });

        // Lanzar error original con información de retry
        const retryError = new Error(`Operation failed after ${attempt} attempts: ${lastError.message}`);
        retryError.originalError = lastError;
        retryError.totalAttempts = attempt;
        retryError.category = this.categorizeError(lastError);

        throw retryError;
    }

    /**
     * Categorizar error para determinar estrategia
     */
    categorizeError(error) {
        // Errores fatales (no reintentar)
        if (error.status === 401 || error.status === 403) {
            return ErrorCategory.FATAL;
        }

        if (error.status >= 400 && error.status < 500 && error.status !== 429) {
            return ErrorCategory.FATAL;
        }

        // Rate limiting
        if (error.status === 429 || error.message?.includes('rate limit')) {
            return ErrorCategory.RATE_LIMITED;
        }

        // Errores de negocio (SIM inválido, saldo insuficiente)
        if (error.message?.includes('SIM no válido') ||
            error.message?.includes('saldo insuficiente') ||
            error.message?.includes('servicio no disponible')) {
            return ErrorCategory.BUSINESS;
        }

        // Errores de conexión/timeout (retriable)
        if (this.options.retriableErrors.includes(error.code) ||
            this.options.retriableHttpCodes.includes(error.status) ||
            error.message?.includes('timeout') ||
            error.message?.includes('connection')) {
            return ErrorCategory.RETRIABLE;
        }

        // Por defecto, consideramos retriable
        return ErrorCategory.RETRIABLE;
    }

    /**
     * Determinar si debe continuar reintentando
     */
    shouldRetry(error, attempt, category, categoryConfig) {
        // No retry para errores fatales
        if (category === ErrorCategory.FATAL) {
            return false;
        }

        // Verificar límite de intentos para la categoría
        const maxAttempts = categoryConfig.maxAttempts;
        if (attempt >= maxAttempts) {
            return false;
        }

        return true;
    }

    /**
     * Calcular delay para próximo intento
     */
    calculateDelay(attempt, category, categoryConfig) {
        const baseDelay = categoryConfig.baseDelay;
        const multiplier = categoryConfig.multiplier;
        let delay;

        switch (this.options.retryType) {
            case RetryType.EXPONENTIAL:
                delay = baseDelay * Math.pow(multiplier, attempt - 1);
                break;

            case RetryType.LINEAR:
                delay = baseDelay * attempt;
                break;

            case RetryType.FIXED:
                delay = baseDelay;
                break;

            default:
                delay = baseDelay * Math.pow(multiplier, attempt - 1);
                break;
        }

        // Aplicar límite máximo
        delay = Math.min(delay, this.options.maxDelay);

        // Aplicar jitter
        delay = this.applyJitter(delay);

        return Math.round(delay);
    }

    /**
     * Aplicar jitter al delay
     */
    applyJitter(delay) {
        switch (this.options.jitterType) {
            case 'NONE':
                return delay;

            case 'EQUAL':
                // Jitter del 50%
                const jitter = delay * 0.5;
                return delay + (Math.random() * jitter - jitter / 2);

            case 'FULL':
                // Jitter completo (0 to delay)
                return Math.random() * delay;

            default:
                return delay;
        }
    }

    /**
     * Sleep por tiempo especificado
     */
    async sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Emitir evento al EventBus
     */
    emitEvent(eventType, data) {
        this.eventBus.emitEvent(`retry.${eventType}`, {
            strategy: this.name,
            ...data
        }, 'RETRY_STRATEGY');
    }

    /**
     * Obtener métricas de la estrategia
     */
    getMetrics() {
        const totalOperations = this.metrics.successfulRetries + this.metrics.failedRetries;

        return {
            name: this.name,
            totalAttempts: this.metrics.totalAttempts,
            totalOperations,
            successfulRetries: this.metrics.successfulRetries,
            failedRetries: this.metrics.failedRetries,
            successRate: totalOperations > 0 ? this.metrics.successfulRetries / totalOperations : 0,
            categoryCounts: { ...this.metrics.categoryCounts },
            configuration: {
                maxAttempts: this.options.maxAttempts,
                baseDelay: this.options.baseDelay,
                maxDelay: this.options.maxDelay,
                retryType: this.options.retryType,
                jitterType: this.options.jitterType
            }
        };
    }

    /**
     * Reset métricas
     */
    resetMetrics() {
        this.metrics = {
            totalAttempts: 0,
            successfulRetries: 0,
            failedRetries: 0,
            categoryCounts: {
                [ErrorCategory.RETRIABLE]: 0,
                [ErrorCategory.FATAL]: 0,
                [ErrorCategory.RATE_LIMITED]: 0,
                [ErrorCategory.BUSINESS]: 0
            }
        };

        console.log(`📊 RetryStrategy "${this.name}" metrics reset`);
    }
}

/**
 * Manager para múltiples estrategias de retry
 */
class RetryStrategyManager {
    constructor() {
        this.strategies = new Map();
        this.eventBus = getEventBus();
    }

    /**
     * Crear o obtener estrategia de retry
     */
    getStrategy(name, options = {}) {
        if (!this.strategies.has(name)) {
            const strategy = new RetryStrategy(name, options);
            this.strategies.set(name, strategy);

            console.log(`🔧 RetryStrategy "${name}" registered`);
        }

        return this.strategies.get(name);
    }

    /**
     * Crear estrategias predefinidas para el sistema
     */
    createDefaultStrategies() {
        // Estrategia para webservices externos (TAECEL, MST)
        this.getStrategy('webservice', {
            maxAttempts: 3,
            baseDelay: 2000,
            maxDelay: 15000,
            multiplier: 2,
            jitterType: 'FULL',
            categoryConfig: {
                [ErrorCategory.RETRIABLE]: {
                    maxAttempts: 3,
                    baseDelay: 2000,
                    multiplier: 2
                },
                [ErrorCategory.RATE_LIMITED]: {
                    maxAttempts: 5,
                    baseDelay: 10000,
                    multiplier: 1.5
                },
                [ErrorCategory.BUSINESS]: {
                    maxAttempts: 1, // No retry para errores de negocio
                    baseDelay: 0,
                    multiplier: 0
                }
            }
        });

        // Estrategia para base de datos
        this.getStrategy('database', {
            maxAttempts: 5,
            baseDelay: 1000,
            maxDelay: 10000,
            multiplier: 1.5,
            jitterType: 'EQUAL',
            categoryConfig: {
                [ErrorCategory.RETRIABLE]: {
                    maxAttempts: 5,
                    baseDelay: 1000,
                    multiplier: 1.5
                },
                [ErrorCategory.FATAL]: {
                    maxAttempts: 0,
                    baseDelay: 0,
                    multiplier: 0
                }
            }
        });

        // Estrategia para operaciones críticas
        this.getStrategy('critical', {
            maxAttempts: 5,
            baseDelay: 500,
            maxDelay: 30000,
            multiplier: 2.5,
            jitterType: 'FULL',
            categoryConfig: {
                [ErrorCategory.RETRIABLE]: {
                    maxAttempts: 5,
                    baseDelay: 500,
                    multiplier: 2.5
                },
                [ErrorCategory.RATE_LIMITED]: {
                    maxAttempts: 10,
                    baseDelay: 30000,
                    multiplier: 1.2
                }
            }
        });

        console.log('📚 Default retry strategies created');
    }

    /**
     * Obtener métricas de todas las estrategias
     */
    getAllMetrics() {
        const metrics = {};

        for (const [name, strategy] of this.strategies) {
            metrics[name] = strategy.getMetrics();
        }

        return metrics;
    }

    /**
     * Reset de todas las métricas
     */
    resetAllMetrics() {
        console.log('🔄 Resetting all retry strategy metrics');

        for (const [name, strategy] of this.strategies) {
            strategy.resetMetrics();
        }
    }

    /**
     * Obtener resumen de estado
     */
    getStatus() {
        const status = {
            totalStrategies: this.strategies.size,
            summary: {
                totalAttempts: 0,
                successfulRetries: 0,
                failedRetries: 0
            },
            strategies: {}
        };

        for (const [name, strategy] of this.strategies) {
            const metrics = strategy.getMetrics();

            status.summary.totalAttempts += metrics.totalAttempts;
            status.summary.successfulRetries += metrics.successfulRetries;
            status.summary.failedRetries += metrics.failedRetries;

            status.strategies[name] = {
                totalOperations: metrics.totalOperations,
                successRate: metrics.successRate,
                mostCommonError: this.getMostCommonErrorCategory(metrics.categoryCounts)
            };
        }

        return status;
    }

    /**
     * Obtener categoría de error más común
     */
    getMostCommonErrorCategory(categoryCounts) {
        let maxCount = 0;
        let mostCommon = null;

        for (const [category, count] of Object.entries(categoryCounts)) {
            if (count > maxCount) {
                maxCount = count;
                mostCommon = category;
            }
        }

        return mostCommon;
    }
}

// Instancia singleton
let managerInstance = null;

/**
 * Obtener instancia del manager
 */
function getRetryStrategyManager() {
    if (!managerInstance) {
        managerInstance = new RetryStrategyManager();
        // Crear estrategias por defecto
        managerInstance.createDefaultStrategies();
    }
    return managerInstance;
}

module.exports = {
    RetryStrategy,
    RetryStrategyManager,
    getRetryStrategyManager,
    RetryType,
    ErrorCategory
};