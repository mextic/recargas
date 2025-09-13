const Sequelize = require('sequelize');
const redis = require('redis');
const config = require('../../config/database');

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
                    max: 10,
                    min: 0,
                    acquire: 30000,
                    idle: 10000
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
        try {
            const result = await this.sequelize.query(sql, {
                type: Sequelize.QueryTypes.SELECT,
                ...options
            });
            return Array.isArray(result) ? result : [];
        } catch (error) {
            console.error(`Error en query ${this.name}:`, error.message);
            throw error;
        }
    }

    getSequelizeClient() {
        return this.sequelize;
    }
}

const dbGps = new DatabaseConnection(config.GPS_DB, 'GPS DB');
const dbEliot = new DatabaseConnection(config.ELIOT_DB, 'ELIoT DB');

let redisClient = null;

async function initDatabases() {
    await dbGps.initialize();
    await dbEliot.initialize();
    
    // Inicializar Redis
    try {
        redisClient = redis.createClient({
            socket: {
                host: config.REDIS.host,
                port: config.REDIS.port
            }
        });
        
        redisClient.on('error', (err) => {
            console.error('Redis Client Error:', err);
        });
        
        await redisClient.connect();
        console.log('   ✅ Redis conectado');
    } catch (error) {
        console.error('   ⚠️ Redis no disponible, usando fallback MySQL');
    }
}

function getRedisClient() {
    return redisClient;
}

module.exports = {
    dbGps,
    dbEliot,
    get redisClient() {
        return redisClient;
    },
    getRedisClient,
    initDatabases,
    Sequelize
};
