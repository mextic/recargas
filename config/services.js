/**
 * Configuración centralizada para todos los servicios de recargas
 * Unifica comportamientos y elimina configuraciones hardcodeadas
 */
module.exports = {
    GPS: {
        // ===== CONFIGURACIÓN FIJA =====
        IMPORTE: 10,                    // Monto fijo: $10
        DIAS: 7,                        // Vigencia fija: 7 días
        CODIGO: 'TEL010',               // Código de producto fijo
        
        // ===== COMPORTAMIENTO UNIFICADO =====
        DELAY_BETWEEN_CALLS: 500,       // 500ms entre llamadas (como estaba)
        RETRY_STRATEGY: 'exponential',   // Estrategia de reintentos exponencial
        RETRY_BASE_DELAY: 1000,         // Base de 1000ms para reintentos (1s, 2s, 3s...)
        MAX_RETRIES: 3,                 // Máximo 3 reintentos
        
        // ===== SCHEDULING =====
        SCHEDULE_TYPE: 'interval',      // Tipo de scheduling: intervalo
        SCHEDULE_MINUTES: parseInt(process.env.GPS_MINUTOS_SIN_REPORTAR) || 10, // Cada 10 min por default
        
        // ===== LÍMITES Y FILTROS =====
        DIAS_SIN_REPORTAR_LIMITE: parseInt(process.env.GPS_DIAS_SIN_REPORTAR) || 14,         // Para query: 14 días
        MINUTOS_SIN_REPORTAR_PARA_RECARGA: parseInt(process.env.GPS_MINUTOS_SIN_REPORTAR) || 10, // Para recarga: 10 min
        MIN_BALANCE_THRESHOLD: 10,       // Saldo mínimo requerido: $10
        
        // ===== FEATURES =====
        SHOW_PROGRESS_BAR: true,        // Mostrar barra de progreso
        BATCH_PROCESSING: true,         // Procesamiento en lotes
        USE_ANIMATIONS: true,           // Usar animaciones visuales
        
        // ===== TIMEOUTS =====
        LOCK_TIMEOUT: 3600,            // Lock timeout: 1 hora
        WEBSERVICE_TIMEOUT: 30000,     // Timeout webservice: 30s
    },
    
    VOZ: {
        // ===== COMPORTAMIENTO UNIFICADO CON GPS =====
        DELAY_BETWEEN_CALLS: 500,       // UNIFICADO: 500ms como GPS (era 2000ms)
        RETRY_STRATEGY: 'exponential',   // UNIFICADO: exponencial como GPS (era fijo)
        RETRY_BASE_DELAY: 1000,         // UNIFICADO: 1000ms base como GPS
        MAX_RETRIES: 3,                 // Mantener: 3 reintentos
        
        // ===== SCHEDULING VOZ =====
        SCHEDULE_TYPE: 'cron',          // Tipo: cron (horarios específicos)
        SCHEDULE_HOURS: [1, 4],         // Horarios: 1:00 AM y 4:00 AM
        
        // ===== LÍMITES ESPECÍFICOS VOZ =====
        MIN_BALANCE_THRESHOLD: 100,     // Saldo mínimo: $100
        
        // ===== FEATURES VOZ =====
        SHOW_PROGRESS_BAR: true,        // Activar barra de progreso animada
        BATCH_PROCESSING: false,        // Procesamiento individual
        USE_ANIMATIONS: true,           // Usar animaciones básicas
        
        // ===== TIMEOUTS =====
        LOCK_TIMEOUT: 3600,            // Lock timeout: 1 hora
        WEBSERVICE_TIMEOUT: 30000,     // Timeout webservice: 30s
        
        // ===== PAQUETES VOZ =====
        PAQUETES: {
            // Códigos activos en BD
            150005: { codigo: "PSL150", dias: 25, monto: 150, descripcion: "MDVR/Equipos especiales" },
            150006: { codigo: "PSL150", dias: 25, monto: 150, descripcion: "Usuarios individuales" },
            300005: { codigo: "PSL300", dias: 30, monto: 300, descripcion: "DashCam/Equipos avanzados" },
            
            // Códigos legacy por compatibilidad
            10007: { codigo: "PSL010", dias: 1, monto: 10, descripcion: "Legacy 10" },
            20006: { codigo: "PSL020", dias: 2, monto: 20, descripcion: "Legacy 20" },
            30006: { codigo: "PSL030", dias: 3, monto: 30, descripcion: "Legacy 30" },
            50006: { codigo: "PSL050", dias: 7, monto: 50, descripcion: "Legacy 50" },
            100006: { codigo: "PSL100", dias: 15, monto: 100, descripcion: "Legacy 100" },
            200006: { codigo: "PSL200", dias: 30, monto: 200, descripcion: "Legacy 200" }
        }
    },
    
    ELIOT: {
        // ===== CONFIGURACIÓN PLACEHOLDER =====
        // Configuración para implementación completa de ELIoT
        
        DELAY_BETWEEN_CALLS: 500,       // Unificado con GPS/VOZ
        RETRY_STRATEGY: 'exponential',   // Unificado con GPS/VOZ
        RETRY_BASE_DELAY: 1000,         // Unificado con GPS/VOZ
        MAX_RETRIES: 3,                 // Unificado con GPS/VOZ
        
        // ===== SCHEDULING ELIoT =====
        SCHEDULE_TYPE: 'interval',      // Cambiar a interval como GPS
        SCHEDULE_MINUTES: parseInt(process.env.ELIOT_MINUTOS_SIN_REPORTAR) || 10, // Usar variable de entorno
        
        // ===== CRITERIOS FILTRADO ELIoT =====
        DIAS_SIN_REPORTAR_LIMITE: parseInt(process.env.ELIOT_DIAS_SIN_REPORTAR) || 20,         // Para query: 20 días  
        MINUTOS_SIN_REPORTAR_PARA_RECARGA: parseInt(process.env.ELIOT_MINUTOS_SIN_REPORTAR) || 10, // Para recarga: 10 min
        
        // ===== LÍMITES =====
        MIN_BALANCE_THRESHOLD: 50,      // Placeholder: $50
        
        // ===== FEATURES =====
        SHOW_PROGRESS_BAR: true,        // Activar barra de progreso animada
        BATCH_PROCESSING: false,        // Individual (por definir)
        USE_ANIMATIONS: true,           // Con animaciones
        
        // ===== ESTADO =====
        IMPLEMENTED: true,              // ✅ IMPLEMENTADO con flujo completo
        
        // ===== TIMEOUTS =====
        LOCK_TIMEOUT: 3600,            // Lock timeout: 1 hora
        WEBSERVICE_TIMEOUT: 30000,     // Timeout webservice: 30s
    },
    
    // ===== CONFIGURACIÓN GLOBAL =====
    GLOBAL: {
        DEFAULT_TIMEZONE: 'America/Mazatlan',
        PROGRESS_BAR_LENGTH: 20,
        LOG_LEVEL: process.env.LOG_LEVEL || 'info'
    }
};