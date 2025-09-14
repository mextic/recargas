const winston = require('winston');
const path = require('path');

// Custom format para logs estructurados
const logFormat = winston.format.combine(
    winston.format.timestamp({
        format: 'YYYY-MM-DD HH:mm:ss.SSS'
    }),
    winston.format.errors({ stack: true }),
    winston.format.json(),
    winston.format.printf(({ timestamp, level, message, service, operation, transactionId, duration, error, ...metadata }) => {
        let log = {
            timestamp,
            level,
            message,
            service,
            operation,
            transactionId,
            duration,
            ...metadata
        };

        if (error) {
            log.error = {
                name: error.name,
                message: error.message,
                stack: error.stack,
                code: error.code
            };
        }

        return JSON.stringify(log);
    })
);

// Configuración de transports
const transports = [
    // Console transport para desarrollo
    new winston.transports.Console({
        level: process.env.LOG_LEVEL || 'info',
        format: winston.format.combine(
            winston.format.colorize(),
            winston.format.simple(),
            winston.format.printf(({ timestamp, level, message, service, operation, transactionId }) => {
                let logLine = `${timestamp} [${level}]`;
                if (service) logLine += ` [${service}]`;
                if (operation) logLine += ` [${operation}]`;
                if (transactionId) logLine += ` [${transactionId}]`;
                logLine += ` ${message}`;
                return logLine;
            })
        )
    })
];

// File transports para producción
if (process.env.NODE_ENV !== 'test') {
    // Crear directorio de logs
    const logsDir = path.join(__dirname, '../../logs');
    require('fs').mkdirSync(logsDir, { recursive: true });

    transports.push(
        // Logs generales
        new winston.transports.File({
            filename: path.join(logsDir, 'combined.log'),
            level: 'info',
            format: logFormat,
            maxsize: 10 * 1024 * 1024, // 10MB
            maxFiles: 5,
            tailable: true
        }),
        
        // Logs de errores
        new winston.transports.File({
            filename: path.join(logsDir, 'error.log'),
            level: 'error',
            format: logFormat,
            maxsize: 10 * 1024 * 1024, // 10MB
            maxFiles: 3,
            tailable: true
        }),

        // Logs de debug
        new winston.transports.File({
            filename: path.join(logsDir, 'debug.log'),
            level: 'debug',
            format: logFormat,
            maxsize: 5 * 1024 * 1024, // 5MB
            maxFiles: 2,
            tailable: true
        })
    );
}

// Crear logger principal
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: logFormat,
    defaultMeta: {
        service: 'recargas-system',
        version: '2.0.0'
    },
    transports,
    exitOnError: false
});

// Método helper para crear logger específico de servicio
function createServiceLogger(serviceName) {
    return {
        debug: (message, metadata = {}) => logger.debug(message, { service: serviceName, ...metadata }),
        info: (message, metadata = {}) => logger.info(message, { service: serviceName, ...metadata }),
        warn: (message, metadata = {}) => logger.warn(message, { service: serviceName, ...metadata }),
        error: (message, error = null, metadata = {}) => logger.error(message, { service: serviceName, error, ...metadata }),
        
        // Método especializado para operaciones con duración
        operation: (operation, message, metadata = {}) => logger.info(message, { 
            service: serviceName, 
            operation, 
            ...metadata 
        }),
        
        // Método para transacciones
        transaction: (transactionId, message, metadata = {}) => logger.info(message, { 
            service: serviceName, 
            transactionId, 
            ...metadata 
        })
    };
}

// Logger de métricas especializado
const metricsLogger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    defaultMeta: {
        type: 'metrics'
    },
    transports: process.env.NODE_ENV !== 'test' ? [
        new winston.transports.File({
            filename: path.join(__dirname, '../../logs/metrics.log'),
            maxsize: 50 * 1024 * 1024, // 50MB
            maxFiles: 10,
            tailable: true
        })
    ] : []
});

// Función para logging de métricas de negocio
function logMetrics(eventType, data) {
    metricsLogger.info('business_metric', {
        eventType,
        timestamp: new Date().toISOString(),
        data
    });
}

// Handler para errores no capturados
logger.exceptions.handle(
    process.env.NODE_ENV !== 'test' ? new winston.transports.File({ 
        filename: path.join(__dirname, '../../logs/exceptions.log') 
    }) : new winston.transports.Console()
);

logger.rejections.handle(
    process.env.NODE_ENV !== 'test' ? new winston.transports.File({ 
        filename: path.join(__dirname, '../../logs/rejections.log') 
    }) : new winston.transports.Console()
);

module.exports = {
    logger,
    createServiceLogger,
    logMetrics,
    metricsLogger
};