/**
 * DatabaseHealthCheck - FASE 5: Health Check para Bases de Datos
 * Monitoreo automático de MySQL, Redis y MongoDB con métricas detalladas
 */
const { dbGps, dbEliot, getRedisClient } = require('../../database');
const mongoose = require('mongoose');
const config = require('../../../config/database');

class DatabaseHealthCheck {
    constructor() {
        this.name = 'DATABASE';
        this.consecutiveFailures = {
            gps: 0,
            eliot: 0,
            redis: 0,
            mongodb: 0
        };
        this.lastSuccess = {
            gps: null,
            eliot: null,
            redis: null,
            mongodb: null
        };
        this.responseTimeHistory = {
            gps: [],
            eliot: [],
            redis: [],
            mongodb: []
        };
        
        console.log('🗄️ Database Health Check inicializado');
    }

    async check() {
        const timestamp = Date.now();
        const results = {};
        
        // Ejecutar checks en paralelo para mejor performance
        const checks = await Promise.allSettled([
            this.checkGpsDatabase(),
            this.checkEliotDatabase(),
            this.checkRedis(),
            this.checkMongoDB()
        ]);

        // Procesar resultados
        const databases = ['gps', 'eliot', 'redis', 'mongodb'];
        checks.forEach((result, index) => {
            const dbName = databases[index];
            
            if (result.status === 'fulfilled') {
                results[dbName] = result.value;
                if (result.value.status === 'healthy') {
                    this.consecutiveFailures[dbName] = 0;
                    this.lastSuccess[dbName] = timestamp;
                } else {
                    this.consecutiveFailures[dbName]++;
                }
            } else {
                this.consecutiveFailures[dbName]++;
                results[dbName] = {
                    status: 'unhealthy',
                    error: result.reason.message,
                    consecutiveFailures: this.consecutiveFailures[dbName],
                    lastSuccess: this.lastSuccess[dbName],
                    timestamp
                };
            }
        });

        return results;
    }

    async checkGpsDatabase() {
        const startTime = Date.now();
        
        try {
            // Test básico de conectividad
            await dbGps.querySequelize('SELECT 1 as test');
            
            // Test más complejo para verificar performance
            const [countResult] = await dbGps.querySequelize('SELECT COUNT(*) as total FROM dispositivos');
            const responseTime = Date.now() - startTime;
            
            this.updateResponseTimeHistory('gps', responseTime);
            
            console.log(`✅ GPS DB: Conectividad exitosa (${responseTime}ms)`);
            
            return {
                status: responseTime > 2000 ? 'degraded' : 'healthy',
                responseTime,
                timestamp: Date.now(),
                consecutiveFailures: this.consecutiveFailures.gps,
                lastSuccess: this.lastSuccess.gps,
                details: {
                    deviceCount: countResult.total,
                    avgResponseTime: this.getAverageResponseTime('gps'),
                    connectionPool: this.getConnectionPoolInfo(dbGps)
                }
            };
            
        } catch (error) {
            const responseTime = Date.now() - startTime;
            console.error(`❌ GPS DB Health Check falló:`, error.message);
            
            return {
                status: 'unhealthy',
                error: error.message,
                responseTime,
                timestamp: Date.now(),
                consecutiveFailures: this.consecutiveFailures.gps + 1,
                lastSuccess: this.lastSuccess.gps,
                details: {
                    errorCode: error.code,
                    sqlState: error.sqlState
                }
            };
        }
    }

    async checkEliotDatabase() {
        const startTime = Date.now();
        
        try {
            // Test básico de conectividad
            await dbEliot.querySequelize('SELECT 1 as test');
            
            // Test específico para ELIoT
            const [countResult] = await dbEliot.querySequelize('SELECT COUNT(*) as total FROM equipments');
            const responseTime = Date.now() - startTime;
            
            this.updateResponseTimeHistory('eliot', responseTime);
            
            console.log(`✅ ELIoT DB: Conectividad exitosa (${responseTime}ms)`);
            
            return {
                status: responseTime > 2000 ? 'degraded' : 'healthy',
                responseTime,
                timestamp: Date.now(),
                consecutiveFailures: this.consecutiveFailures.eliot,
                lastSuccess: this.lastSuccess.eliot,
                details: {
                    equipmentCount: countResult.total,
                    avgResponseTime: this.getAverageResponseTime('eliot'),
                    connectionPool: this.getConnectionPoolInfo(dbEliot)
                }
            };
            
        } catch (error) {
            const responseTime = Date.now() - startTime;
            console.error(`❌ ELIoT DB Health Check falló:`, error.message);
            
            return {
                status: 'unhealthy',
                error: error.message,
                responseTime,
                timestamp: Date.now(),
                consecutiveFailures: this.consecutiveFailures.eliot + 1,
                lastSuccess: this.lastSuccess.eliot,
                details: {
                    errorCode: error.code,
                    sqlState: error.sqlState
                }
            };
        }
    }

    async checkRedis() {
        const startTime = Date.now();
        
        try {
            const redisClient = getRedisClient();
            
            if (!redisClient) {
                throw new Error('Redis client not available');
            }
            
            // Test básico de conectividad
            await redisClient.ping();
            
            // Test de escritura/lectura
            const testKey = 'health_check_test';
            const testValue = Date.now().toString();
            
            await redisClient.setEx(testKey, 60, testValue);
            const retrievedValue = await redisClient.get(testKey);
            
            if (retrievedValue !== testValue) {
                throw new Error('Redis read/write test failed');
            }
            
            // Limpiar clave de test
            await redisClient.del(testKey);
            
            const responseTime = Date.now() - startTime;
            this.updateResponseTimeHistory('redis', responseTime);
            
            console.log(`✅ Redis: Conectividad exitosa (${responseTime}ms)`);
            
            return {
                status: responseTime > 1000 ? 'degraded' : 'healthy',
                responseTime,
                timestamp: Date.now(),
                consecutiveFailures: this.consecutiveFailures.redis,
                lastSuccess: this.lastSuccess.redis,
                details: {
                    avgResponseTime: this.getAverageResponseTime('redis'),
                    readWriteTest: 'passed',
                    connected: redisClient.isReady
                }
            };
            
        } catch (error) {
            const responseTime = Date.now() - startTime;
            console.error(`❌ Redis Health Check falló:`, error.message);
            
            return {
                status: 'unhealthy',
                error: error.message,
                responseTime,
                timestamp: Date.now(),
                consecutiveFailures: this.consecutiveFailures.redis + 1,
                lastSuccess: this.lastSuccess.redis,
                details: {
                    errorType: error.code || 'unknown'
                }
            };
        }
    }

    async checkMongoDB() {
        const startTime = Date.now();
        
        try {
            // Verificar si MongoDB está configurado
            if (!config.MONGODB || !config.MONGODB.url) {
                console.log('⚠️ MongoDB no configurado, saltando health check');
                return {
                    status: 'healthy',
                    responseTime: 0,
                    timestamp: Date.now(),
                    consecutiveFailures: 0,
                    lastSuccess: Date.now(),
                    details: {
                        note: 'MongoDB not configured - skipped'
                    }
                };
            }
            
            // Verificar estado de conexión de Mongoose
            const mongoState = mongoose.connection.readyState;
            
            if (mongoState !== 1) { // 1 = connected
                // Intentar conectar si no está conectado
                if (mongoState === 0) { // 0 = disconnected
                    await mongoose.connect(config.MONGODB.url);
                } else {
                    throw new Error(`MongoDB in invalid state: ${this.getMongoStateString(mongoState)}`);
                }
            }
            
            // Test básico de conectividad
            await mongoose.connection.db.admin().ping();
            
            const responseTime = Date.now() - startTime;
            this.updateResponseTimeHistory('mongodb', responseTime);
            
            console.log(`✅ MongoDB: Conectividad exitosa (${responseTime}ms)`);
            
            return {
                status: responseTime > 3000 ? 'degraded' : 'healthy',
                responseTime,
                timestamp: Date.now(),
                consecutiveFailures: this.consecutiveFailures.mongodb,
                lastSuccess: this.lastSuccess.mongodb,
                details: {
                    connectionState: this.getMongoStateString(mongoState),
                    avgResponseTime: this.getAverageResponseTime('mongodb'),
                    dbName: mongoose.connection.name
                }
            };
            
        } catch (error) {
            const responseTime = Date.now() - startTime;
            console.error(`❌ MongoDB Health Check falló:`, error.message);
            
            return {
                status: 'unhealthy',
                error: error.message,
                responseTime,
                timestamp: Date.now(),
                consecutiveFailures: this.consecutiveFailures.mongodb + 1,
                lastSuccess: this.lastSuccess.mongodb,
                details: {
                    connectionState: this.getMongoStateString(mongoose.connection.readyState),
                    errorCode: error.code
                }
            };
        }
    }

    getMongoStateString(state) {
        const states = {
            0: 'disconnected',
            1: 'connected',
            2: 'connecting',
            3: 'disconnecting'
        };
        return states[state] || 'unknown';
    }

    getConnectionPoolInfo(dbConnection) {
        try {
            const pool = dbConnection.getSequelizeClient().connectionManager.pool;
            return {
                size: pool.size,
                available: pool.available,
                using: pool.using,
                waiting: pool.waiting
            };
        } catch (error) {
            return { error: 'Pool info not available' };
        }
    }

    updateResponseTimeHistory(database, responseTime) {
        this.responseTimeHistory[database].unshift(responseTime);
        
        // Mantener solo las últimas 10 mediciones por database
        if (this.responseTimeHistory[database].length > 10) {
            this.responseTimeHistory[database] = this.responseTimeHistory[database].slice(0, 10);
        }
    }

    getAverageResponseTime(database) {
        const history = this.responseTimeHistory[database];
        if (history.length === 0) return 0;
        
        const sum = history.reduce((a, b) => a + b, 0);
        return Math.round(sum / history.length);
    }

    async testAllConnections() {
        console.log('🧪 Probando todas las conexiones de base de datos...');
        
        const results = await this.check();
        
        console.log('📊 Resultados de connectividad:');
        Object.entries(results).forEach(([db, result]) => {
            const status = result.status === 'healthy' ? '✅' : 
                          result.status === 'degraded' ? '⚠️' : '❌';
            console.log(`   ${status} ${db.toUpperCase()}: ${result.status} (${result.responseTime}ms)`);
            if (result.error) {
                console.log(`      Error: ${result.error}`);
            }
        });
        
        return results;
    }

    getStats() {
        const stats = {
            name: this.name,
            databases: {}
        };
        
        Object.keys(this.consecutiveFailures).forEach(db => {
            stats.databases[db] = {
                consecutiveFailures: this.consecutiveFailures[db],
                lastSuccess: this.lastSuccess[db],
                lastSuccessFormatted: this.lastSuccess[db] ? 
                    new Date(this.lastSuccess[db]).toLocaleString('es-MX', { 
                        timeZone: 'America/Mazatlan' 
                    }) : 'Never',
                averageResponseTime: this.getAverageResponseTime(db),
                status: this.consecutiveFailures[db] === 0 ? 'healthy' : 
                        this.consecutiveFailures[db] < 3 ? 'degraded' : 'unhealthy'
            };
        });
        
        return stats;
    }

    reset() {
        Object.keys(this.consecutiveFailures).forEach(db => {
            this.consecutiveFailures[db] = 0;
            this.lastSuccess[db] = null;
            this.responseTimeHistory[db] = [];
        });
        console.log('🔄 Database Health Checks reseteados');
    }
}

module.exports = DatabaseHealthCheck;