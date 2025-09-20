const Sequelize = require('sequelize');
const redis = require('redis');
const config = require('../../config/database');
const PerformanceCache = require('./PerformanceCache');

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
                    max: 25,              // Incrementar máximo de conexiones
                    min: 5,               // Incrementar mínimo de conexiones
                    acquire: 60000,       // 60 segundos timeout para obtener conexión
                    idle: 30000,          // 30 segundos antes de cerrar conexión idle
                    evict: 5000,          // Verificar cada 5 segundos
                    handleDisconnects: true,
                    retry: {
                        max: 3            // Máximo 3 reintentos automáticos
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

                const result = await this.
                sequelize.query(sql, {
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
}

const dbGps = new DatabaseConnection(config.GPS_DB, 'GPS DB');
const dbEliot = new DatabaseConnection(config.ELIOT_DB, 'ELIoT DB');

let redisClient = null;
let performanceCache = null;

async function initDatabases() {
    await dbGps.initialize();
    await dbEliot.initialize();

    // Inicializar Redis
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
        console.log('   ✅ Redis conectado');

        // Inicializar cache de performance
        performanceCache = new PerformanceCache(redisClient);
        await performanceCache.initialize();
        console.log('   ✅ Performance Cache inicializado');
    } catch (error) {
        console.error('   ⚠️ Redis no disponible, usando fallback MySQL');
        // Inicializar cache en memoria como fallback
        performanceCache = new PerformanceCache(null);
        await performanceCache.initialize();
        console.log('   ✅ Performance Cache (memoria) inicializado');
    }
}

function getRedisClient() {
    return redisClient;
}

function getPerformanceCache() {
    return performanceCache;
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
    getRedisClient,
    getPerformanceCache,
    initDatabases,
    Sequelize
};
