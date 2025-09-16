const Sequelize = require('sequelize');
const redis = require('redis');
const config = require('../../config/database');
const PerformanceCache = require('./PerformanceCache');
const ConnectionPoolManager = require('./ConnectionPoolManager');

class DatabaseConnection {
    constructor(dbConfig, name) {
        this.name = name;
        this.sequelize = new Sequelize(
            dbConfig.database,
            dbConfig.user,
            dbConfig.password,
            {
                host: dbConfig.host,
                dialect: 'mysql',
                logging: false,
                pool: {
                    max: config.MYSQL_POOL.max,              // Configurable máximo de conexiones
                    min: config.MYSQL_POOL.min,              // Configurable mínimo de conexiones
                    acquire: config.MYSQL_POOL.acquire,      // Timeout para obtener conexión
                    idle: config.MYSQL_POOL.idle,            // Tiempo antes de cerrar conexión idle
                    evict: config.MYSQL_POOL.evict,          // Intervalo de verificación
                    handleDisconnects: true,
                    retry: {
                        max: 3                                // Máximo 3 reintentos automáticos
                    }
                },
                // Opciones adicionales de resiliencia
                dialectOptions: {
                    connectTimeout: 60000,
                    // Configuraciones MySQL específicas para mejor manejo de conexiones
                    supportBigNumbers: true,
                    bigNumberStrings: true,
                    charset: 'utf8mb4'
                },
                retry: {
                    match: [
                        /ECONNRESET/,
                        /ENOTFOUND/,
                        /ECONNREFUSED/,
                        /ETIMEDOUT/,
                        /TimeoutError/,
                        /SequelizeConnectionError/,
                        /SequelizeConnectionRefusedError/,
                        /SequelizeHostNotFoundError/,
                        /SequelizeHostNotReachableError/,
                        /SequelizeInvalidConnectionError/,
                        /SequelizeConnectionTimedOutError/,
                        /Can't add new command when connection is in closed state/
                    ],
                    max: 3
                }
            }
        );
    }

    async initialize() {
        try {
            await this.sequelize.authenticate();
            console.log(`   ✅ ${this.name} conectada`);
            return true;
        } catch (error) {
            console.error(`   ❌ Error conectando ${this.name}:`, error.message);
            throw error;
        }
    }

    async querySequelize(sql, options = {}) {
        const maxRetries = 3;
        let attempt = 0;
        
        while (attempt < maxRetries) {
            try {
                // Verificar que la conexión esté activa
                if (this.sequelize.connectionManager.pool && 
                    this.sequelize.connectionManager.pool._factory) {
                    await this.sequelize.authenticate();
                }
                
                const result = await this.sequelize.query(sql, {
                    type: Sequelize.QueryTypes.SELECT,
                    ...options
                });
                return Array.isArray(result) ? result : [];
                
            } catch (error) {
                attempt++;
                const isConnectionError = this.isConnectionError(error);
                
                console.error(`Error en query ${this.name} (intento ${attempt}/${maxRetries}):`, error.message);
                
                if (isConnectionError && attempt < maxRetries) {
                    console.log(`   🔄 Reintentando conexión en 2 segundos...`);
                    await this.sleep(2000 * attempt); // Backoff exponencial
                    
                    // Intentar reconectar
                    try {
                        await this.reconnect();
                    } catch (reconnectError) {
                        console.error(`   ❌ Error en reconexión: ${reconnectError.message}`);
                    }
                } else {
                    throw error;
                }
            }
        }
    }

    isConnectionError(error) {
        const connectionErrors = [
            'ECONNRESET',
            'ENOTFOUND', 
            'ECONNREFUSED',
            'ETIMEDOUT',
            'TimeoutError',
            'SequelizeConnectionError',
            'SequelizeConnectionRefusedError',
            'SequelizeHostNotFoundError',
            'SequelizeHostNotReachableError',
            'SequelizeInvalidConnectionError',
            'SequelizeConnectionTimedOutError',
            'Can\'t add new command when connection is in closed state'
        ];
        
        return connectionErrors.some(errType => 
            error.message.includes(errType) || 
            error.name.includes(errType) ||
            error.code === errType
        );
    }

    async reconnect() {
        try {
            console.log(`   🔄 Intentando reconectar ${this.name}...`);
            await this.sequelize.close();
            await this.sleep(1000);
            await this.sequelize.authenticate();
            console.log(`   ✅ ${this.name} reconectada exitosamente`);
        } catch (error) {
            console.error(`   ❌ Error en reconexión ${this.name}:`, error.message);
            throw error;
        }
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    getSequelizeClient() {
        return this.sequelize;
    }

    /**
     * Get Sequelize pool statistics for monitoring
     */
    getPoolStats() {
        const pool = this.sequelize.connectionManager.pool;
        if (!pool) {
            return { error: 'Pool not available' };
        }

        return {
            size: pool.size || 0,
            available: pool.available || 0,
            borrowed: pool.borrowed || 0,
            pending: pool.pending || 0,
            max: pool.max || 0,
            min: pool.min || 0,
            config: {
                max: config.MYSQL_POOL.max,
                min: config.MYSQL_POOL.min,
                acquire: config.MYSQL_POOL.acquire,
                idle: config.MYSQL_POOL.idle
            }
        };
    }

    /**
     * Check MySQL connection health
     */
    async checkHealth() {
        try {
            await this.sequelize.authenticate();
            return { healthy: true, database: this.name };
        } catch (error) {
            return { healthy: false, database: this.name, error: error.message };
        }
    }

    /**
     * Gracefully close database connection
     */
    async close() {
        try {
            await this.sequelize.close();
            console.log(`   ✅ ${this.name} connection closed`);
        } catch (error) {
            console.error(`   ❌ Error closing ${this.name}:`, error.message);
        }
    }
}

const dbGps = new DatabaseConnection(config.GPS_DB, 'GPS DB');
const dbEliot = new DatabaseConnection(config.ELIOT_DB, 'ELIoT DB');

let redisClient = null;
let performanceCache = null;
let connectionPoolManager = null;

async function initDatabases() {
    await dbGps.initialize();
    await dbEliot.initialize();

    // Inicializar Connection Pool Manager para Redis optimizado
    try {
        connectionPoolManager = new ConnectionPoolManager();
        await connectionPoolManager.initializeRedisPool();

        // Start monitoring if enabled
        connectionPoolManager.startMonitoring();

        console.log('   ✅ Redis connection pool initialized');

        // Crear un wrapper para mantener compatibilidad con código existente
        redisClient = {
            async get(key) {
                return connectionPoolManager.executeRedisOperation(async (conn) => {
                    return conn.get(key);
                });
            },
            async set(key, value, ...args) {
                return connectionPoolManager.executeRedisOperation(async (conn) => {
                    return conn.set(key, value, ...args);
                });
            },
            async del(key) {
                return connectionPoolManager.executeRedisOperation(async (conn) => {
                    return conn.del(key);
                });
            },
            async exists(key) {
                return connectionPoolManager.executeRedisOperation(async (conn) => {
                    return conn.exists(key);
                });
            },
            async expire(key, seconds) {
                return connectionPoolManager.executeRedisOperation(async (conn) => {
                    return conn.expire(key, seconds);
                });
            },
            async hget(key, field) {
                return connectionPoolManager.executeRedisOperation(async (conn) => {
                    return conn.hget(key, field);
                });
            },
            async hset(key, field, value) {
                return connectionPoolManager.executeRedisOperation(async (conn) => {
                    return conn.hset(key, field, value);
                });
            },
            async hgetall(key) {
                return connectionPoolManager.executeRedisOperation(async (conn) => {
                    return conn.hgetall(key);
                });
            },
            async eval(script, numKeys, ...args) {
                return connectionPoolManager.executeRedisOperation(async (conn) => {
                    return conn.eval(script, numKeys, ...args);
                });
            },
            async ping() {
                return connectionPoolManager.executeRedisOperation(async (conn) => {
                    return conn.ping();
                });
            },
            // Método para obtener conexión directa cuando sea necesario
            async getConnection() {
                return connectionPoolManager.getRedisConnection();
            },
            // Método para estadísticas del pool
            getPoolStats() {
                return connectionPoolManager.getPoolStats();
            }
        };

        // Inicializar cache de performance con el cliente optimizado
        performanceCache = new PerformanceCache(redisClient);
        await performanceCache.initialize();
        console.log('   ✅ Performance Cache inicializado con connection pooling');

    } catch (error) {
        console.error('   ⚠️ Error inicializando Redis pool, intentando conexión tradicional...');

        // Fallback a conexión tradicional Redis
        try {
            redisClient = redis.createClient({
                socket: {
                    host: config.REDIS.host,
                    port: config.REDIS.port,
                    reconnectStrategy: (retries) => Math.min(retries * 50, 1000)
                },
                isolationPoolOptions: {
                    min: 2,
                    max: 10
                }
            });

            redisClient.on('error', (err) => {
                console.error('Redis Client Error:', err);
            });

            await redisClient.connect();
            console.log('   ✅ Redis conectado (modo tradicional)');

            // Inicializar cache de performance
            performanceCache = new PerformanceCache(redisClient);
            await performanceCache.initialize();
            console.log('   ✅ Performance Cache inicializado');

        } catch (fallbackError) {
            console.error('   ⚠️ Redis no disponible, usando fallback MySQL');
            // Inicializar cache en memoria como fallback
            performanceCache = new PerformanceCache(null);
            await performanceCache.initialize();
            console.log('   ✅ Performance Cache (memoria) inicializado');
        }
    }
}

function getRedisClient() {
    return redisClient;
}

function getPerformanceCache() {
    return performanceCache;
}

/**
 * Get combined connection pool statistics for monitoring
 */
function getPoolStats() {
    const stats = {
        mysql: {
            gps: dbGps.getPoolStats(),
            eliot: dbEliot.getPoolStats()
        },
        redis: connectionPoolManager ? connectionPoolManager.getPoolStats() : null,
        timestamp: new Date().toISOString()
    };
    return stats;
}

/**
 * Check health of all database connections
 */
async function checkDatabaseHealth() {
    const health = {
        mysql: {
            gps: await dbGps.checkHealth(),
            eliot: await dbEliot.checkHealth()
        },
        redis: connectionPoolManager ? await connectionPoolManager.checkHealth() : { healthy: false, error: 'Pool manager not initialized' },
        timestamp: new Date().toISOString()
    };
    return health;
}

/**
 * Graceful shutdown of all database connections and pools
 */
async function shutdownDatabases() {
    console.log('Shutting down database connections...');

    const shutdownPromises = [];

    // Shutdown MySQL connections
    shutdownPromises.push(dbGps.close());
    shutdownPromises.push(dbEliot.close());

    // Shutdown Redis connection pool
    if (connectionPoolManager) {
        shutdownPromises.push(connectionPoolManager.shutdown());
    } else if (redisClient && redisClient.quit) {
        shutdownPromises.push(redisClient.quit());
    }

    // Shutdown performance cache
    if (performanceCache && performanceCache.shutdown) {
        shutdownPromises.push(performanceCache.shutdown());
    }

    try {
        await Promise.all(shutdownPromises);
        console.log('   ✅ All database connections closed successfully');
    } catch (error) {
        console.error('   ❌ Error during database shutdown:', error.message);
    }
}

module.exports = {
    dbGps,
    dbEliot,
    get redisClient() {
        return redisClient;
    },
    get performanceCache() {
        return performanceCache;
    },
    get connectionPoolManager() {
        return connectionPoolManager;
    },
    getRedisClient,
    getPerformanceCache,
    getPoolStats,
    checkDatabaseHealth,
    shutdownDatabases,
    initDatabases,
    Sequelize
};
