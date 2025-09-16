require('dotenv').config();

module.exports = {
    GPS_DB: {
        host: process.env.GPS_DB_HOST || 'localhost',
        user: process.env.GPS_DB_USER || 'root',
        password: process.env.GPS_DB_PASSWORD,
        database: process.env.GPS_DB_NAME || 'gps_db'
    },
    ELIOT_DB: {
        host: process.env.ELIOT_DB_HOST || 'localhost',
        user: process.env.ELIOT_DB_USER || 'root',
        password: process.env.ELIOT_DB_PASSWORD,
        database: process.env.ELIOT_DB_NAME || 'eliot_db'
    },
    REDIS: {
        host: process.env.REDIS_HOST || '10.8.0.1',
        port: parseInt(process.env.REDIS_PORT) || 6379,
        // Redis Connection Pool Configuration
        pool: {
            min: parseInt(process.env.REDIS_POOL_MIN) || 2,
            max: parseInt(process.env.REDIS_POOL_MAX) || 10,
            acquireTimeoutMillis: parseInt(process.env.REDIS_POOL_ACQUIRE_TIMEOUT) || 30000,
            idleTimeoutMillis: parseInt(process.env.REDIS_POOL_IDLE_TIMEOUT) || 300000,
            evictionRunIntervalMillis: parseInt(process.env.REDIS_POOL_EVICTION_INTERVAL) || 60000
        }
    },
    MONGODB: {
        url: process.env.MONGODB_URL || 'mongodb://localhost:27017/metrics'
    },
    // Configuración de proveedores
    TAECEL: {
        url: process.env.TAECEL_URL || "https://taecel.com/app/api",
        key: process.env.TAECEL_KEY,
        nip: process.env.TAECEL_NIP
    },
    MST: {
        url: process.env.MST_URL || "https://www.ventatelcel.com/ws/index.php?wsdl",
        usuario: process.env.MST_USER,
        clave: process.env.MST_PASSWORD
    },
    // MySQL/Sequelize Pool Configuration
    MYSQL_POOL: {
        min: parseInt(process.env.MYSQL_POOL_MIN) || 5,
        max: parseInt(process.env.MYSQL_POOL_MAX) || 25,
        acquire: parseInt(process.env.MYSQL_POOL_ACQUIRE_TIMEOUT) || 60000,
        idle: parseInt(process.env.MYSQL_POOL_IDLE_TIMEOUT) || 30000,
        evict: parseInt(process.env.MYSQL_POOL_EVICTION_TIMEOUT) || 60000
    },
    // Connection Pool Monitoring
    POOL_MONITORING: {
        enabled: process.env.POOL_MONITORING_ENABLED !== 'false',
        statsInterval: parseInt(process.env.POOL_STATS_INTERVAL) || 300000,
        drainTimeout: parseInt(process.env.POOL_DRAIN_TIMEOUT) || 10000
    }
};
