class OptimizedLockManager {
    constructor(config = {}) {
        // Configuración del proveedor de locks basada en variable de entorno
        const lockProvider = process.env.LOCK_PROVIDER || 'redis';
        this.lockProvider = lockProvider.toLowerCase();
        
        // Mantener compatibilidad con configuración anterior
        this.useRedis = config.useRedis !== false && this.lockProvider === 'redis';
        this.useMySQL = this.lockProvider === 'mysql';
        
        this.getRedisClient = config.getRedisClient || (() => null);
        this.dbConnection = null;
        this.lockPrefix = 'lockRecharge:';
        this.activeHeartbeats = new Map();
        
        console.log(`🔧 [LOCK_MANAGER] Proveedor configurado: ${this.lockProvider.toUpperCase()}`);
    }

    get redisClient() {
        return this.getRedisClient();
    }

    setDbConnection(db) {
        this.dbConnection = db;
    }

    async acquireLock(lockKey, lockId, timeoutSeconds = 1800) {
        console.log(`🔐 [LOCK] Intentando adquirir lock: ${lockKey}`);
        console.log(`   • Lock ID: ${lockId}`);
        console.log(`   • PID: ${process.pid}`);
        console.log(`   • Timeout: ${timeoutSeconds}s`);
        console.log(`   • Proveedor: ${this.lockProvider.toUpperCase()}`);

        // Limpiar locks expirados antes de intentar adquirir
        await this.cleanupExpiredLocks();

        // Usar solo el proveedor configurado (sin fallback)
        if (this.lockProvider === 'redis') {
            return await this.acquireLockRedis(lockKey, lockId, timeoutSeconds);
        } else if (this.lockProvider === 'mysql') {
            return await this.acquireLockMySQL(lockKey, lockId, timeoutSeconds);
        } else {
            console.error(`❌ [LOCK] Proveedor no válido: ${this.lockProvider}`);
            return { success: false, reason: 'invalid_provider' };
        }
    }

    async acquireLockRedis(lockKey, lockId, timeoutSeconds) {
        if (!this.redisClient) {
            console.error(`❌ [REDIS] Cliente Redis no disponible`);
            return { success: false, reason: 'redis_unavailable' };
        }

        const fullKey = `${this.lockPrefix}${lockKey}`;
        const lockData = {
            lockId,
            pid: process.pid,
            timestamp: Date.now(),
            expiresAt: Date.now() + (timeoutSeconds * 1000)
        };

        console.log(`🔴 [REDIS] Intentando lock en Redis: ${fullKey}`);
        try {
            // Verificar si existe un lock expirado en Redis
            const existingData = await this.redisClient.get(fullKey);
            if (existingData) {
                const parsed = JSON.parse(existingData);
                if (Date.now() > parsed.expiresAt) {
                    console.log(`🧹 [REDIS] Lock expirado encontrado, eliminando...`);
                    await this.redisClient.del(fullKey);
                }
            }

            const result = await this.redisClient.set(
                fullKey,
                JSON.stringify(lockData),
                {
                    NX: true,
                    EX: timeoutSeconds
                }
            );

            if (result === 'OK') {
                console.log(`✅ [REDIS] Lock adquirido exitosamente`);
                return { success: true, lockId, provider: 'Redis' };
            } else {
                // Verificar cuándo expira el lock existente
                try {
                    const existingData = await this.redisClient.get(fullKey);
                    if (existingData) {
                        const parsed = JSON.parse(existingData);
                        const moment = require('moment-timezone');
                        const timezone = process.env.TZ || process.env.TIMEZONE || 'America/Mazatlan';
                        const expiresAt = moment(parsed.expiresAt).tz(timezone).format('YYYY-MM-DD HH:mm:ss');
                        const ageMinutes = Math.round((Date.now() - parsed.timestamp) / 60000);
                        
                        console.log(`❌ [REDIS] Lock ya existe, no se pudo adquirir`);
                        console.log(`   • PID propietario: ${parsed.pid}`);
                        console.log(`   • Edad: ${ageMinutes} minutos`);
                        console.log(`   • Expira: ${expiresAt} (${timezone})`);
                    }
                } catch (e) {
                    console.log(`❌ [REDIS] Lock ya existe, no se pudo adquirir`);
                }
                return { success: false, reason: 'lock_exists' };
            }
        } catch (error) {
            console.error(`❌ [REDIS] Error en Redis:`, error.message);
            return { success: false, reason: 'redis_error', error: error.message };
        }
    }

    async acquireLockMySQL(lockKey, lockId, timeoutSeconds) {
        if (!this.dbConnection) {
            console.error(`❌ [MYSQL] Conexión MySQL no disponible`);
            return { success: false, reason: 'mysql_unavailable' };
        }

        console.log(`🟡 [MYSQL] Intentando lock en MySQL: ${lockKey}`);
        try {
            console.log(`🟡 [MYSQL] Verificando tabla de locks...`);
            await this.ensureLockTable();

            // Limpiar locks expirados en MySQL
            await this.cleanupExpiredLocksMySQL();

            console.log(`🟡 [MYSQL] Verificando si lock ya existe...`);
            const checkSql = `
                SELECT * FROM recargas_process_locks
                WHERE lock_key = ? AND expires_at > NOW()
                LIMIT 1
            `;

            const existingLock = await this.dbConnection.querySequelize(checkSql, {
                replacements: [lockKey],
                type: this.dbConnection.getSequelizeClient().QueryTypes.SELECT
            });

            if (existingLock.length > 0) {
                const lock = existingLock[0];
                const moment = require('moment-timezone');
                const timezone = process.env.TZ || process.env.TIMEZONE || 'America/Mazatlan';
                const expiresAt = moment(lock.expires_at).tz(timezone).format('YYYY-MM-DD HH:mm:ss');
                const ageMinutes = Math.round((Date.now() - new Date(lock.acquired_at).getTime()) / 60000);
                
                console.log(`❌ [MYSQL] Lock ya existe en BD`);
                console.log(`   • PID propietario: ${lock.pid}`);
                console.log(`   • Edad: ${ageMinutes} minutos`);
                console.log(`   • Expira: ${expiresAt} (${timezone})`);
                return { success: false, reason: 'lock_exists' };
            }

            console.log(`🟡 [MYSQL] Insertando lock en BD...`);
            const insertSql = `
                INSERT INTO recargas_process_locks (lock_key, lock_id, pid, acquired_at, expires_at)
                VALUES (?, ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL ? SECOND))
            `;

            await this.dbConnection.querySequelize(insertSql, {
                replacements: [lockKey, lockId, process.pid, timeoutSeconds],
                type: this.dbConnection.getSequelizeClient().QueryTypes.INSERT
            });

            console.log(`✅ [MYSQL] Lock adquirido exitosamente en BD`);
            return { success: true, lockId, provider: 'MySQL' };

        } catch (error) {
            if (error.code === 'ER_DUP_ENTRY') {
                console.log(`❌ [MYSQL] Lock ya existe en BD (entrada duplicada)`);
                return { success: false, reason: 'lock_exists' };
            }
            console.error(`❌ [MYSQL] Error inesperado en BD:`, error.message);
            return { success: false, reason: 'mysql_error', error: error.message };
        }
    }

    async releaseLock(lockKey, lockId) {
        console.log(`🔓 [LOCK] Liberando lock: ${lockKey} (proveedor: ${this.lockProvider.toUpperCase()})`);
        
        if (this.lockProvider === 'redis') {
            return await this.releaseLockRedis(lockKey, lockId);
        } else if (this.lockProvider === 'mysql') {
            return await this.releaseLockMySQL(lockKey, lockId);
        }
    }

    async releaseLockRedis(lockKey, lockId) {
        if (!this.redisClient) return;
        
        const fullKey = `${this.lockPrefix}${lockKey}`;
        try {
            await this.redisClient.del(fullKey);
            console.log(`🔓 [REDIS] Lock liberado: ${lockKey}`);
        } catch (error) {
            console.error(`❌ [REDIS] Error liberando lock:`, error.message);
        }
    }

    async releaseLockMySQL(lockKey, lockId) {
        if (!this.dbConnection) return;
        
        try {
            const sql = 'DELETE FROM recargas_process_locks WHERE lock_key = ? AND lock_id = ?';
            await this.dbConnection.querySequelize(sql, {
                replacements: [lockKey, lockId],
                type: this.dbConnection.getSequelizeClient().QueryTypes.DELETE
            });
            console.log(`🔓 [MYSQL] Lock liberado: ${lockKey}`);
        } catch (error) {
            console.error(`❌ [MYSQL] Error liberando lock:`, error.message);
        }
    }

    async isLocked(lockKey) {
        if (this.lockProvider === 'redis') {
            return await this.isLockedRedis(lockKey);
        } else if (this.lockProvider === 'mysql') {
            return await this.isLockedMySQL(lockKey);
        }
        return { locked: false };
    }

    async isLockedRedis(lockKey) {
        if (!this.redisClient) return { locked: false };
        
        const fullKey = `${this.lockPrefix}${lockKey}`;
        try {
            const data = await this.redisClient.get(fullKey);
            if (data) {
                const parsed = JSON.parse(data);
                return {
                    locked: true,
                    provider: 'Redis',
                    age_minutes: Math.round((Date.now() - parsed.timestamp) / 60000)
                };
            }
        } catch (error) {
            console.error('Error verificando lock Redis:', error);
        }
        return { locked: false };
    }

    async isLockedMySQL(lockKey) {
        if (!this.dbConnection) return { locked: false };
        
        try {
            const sql = `
                SELECT *, TIMESTAMPDIFF(MINUTE, acquired_at, NOW()) as age_minutes
                FROM recargas_process_locks
                WHERE lock_key = ? AND expires_at > NOW()
                LIMIT 1
            `;

            const result = await this.dbConnection.querySequelize(sql, {
                replacements: [lockKey],
                type: this.dbConnection.getSequelizeClient().QueryTypes.SELECT
            });

            if (result.length > 0) {
                return {
                    locked: true,
                    provider: 'MySQL',
                    age_minutes: result[0].age_minutes
                };
            }
        } catch (error) {
            console.error('Error verificando lock MySQL:', error);
        }
        return { locked: false };
    }

    async getStats() {
        const stats = {
            provider: this.lockProvider.toUpperCase(),
            active: 0,
            redis: { active: 0 },
            mysql: { active: 0 }
        };

        if (this.lockProvider === 'redis') {
            // Stats de Redis with connection pool support
            if (this.redisClient) {
                try {
                    let keys = [];
                    if (this.redisClient.keys) {
                        keys = await this.redisClient.keys(`${this.lockPrefix}*`);
                    } else if (this.redisClient.getConnection) {
                        // Handle pooled connections
                        const conn = await this.redisClient.getConnection();
                        try {
                            keys = await conn.client.keys(`${this.lockPrefix}*`);
                        } finally {
                            conn.release();
                        }
                    }
                    stats.redis.active = keys.length;
                    stats.active = keys.length;
                } catch (error) {
                    console.error('Error obteniendo stats Redis:', error);
                }
            }
        } else if (this.lockProvider === 'mysql') {
            // Stats de MySQL
            if (this.dbConnection) {
                try {
                    const sql = 'SELECT COUNT(*) as count FROM recargas_process_locks WHERE expires_at > NOW()';
                    const result = await this.dbConnection.querySequelize(sql, {
                        type: this.dbConnection.getSequelizeClient().QueryTypes.SELECT
                    });
                    stats.mysql.active = result[0].count;
                    stats.active = result[0].count;
                } catch (error) {
                    console.error('Error obteniendo stats MySQL:', error);
                }
            }
        }

        return stats;
    }

    async releaseAllLocks() {
        console.log(`🔓 Liberando todos los locks (proveedor: ${this.lockProvider.toUpperCase()})...`);

        if (this.lockProvider === 'redis') {
            // Limpiar Redis with connection pool support
            if (this.redisClient) {
                try {
                    let keys = [];
                    if (this.redisClient.keys) {
                        keys = await this.redisClient.keys(`${this.lockPrefix}*`);
                    } else if (this.redisClient.getConnection) {
                        // Handle pooled connections
                        const conn = await this.redisClient.getConnection();
                        try {
                            keys = await conn.client.keys(`${this.lockPrefix}*`);
                        } finally {
                            conn.release();
                        }
                    }

                    for (const key of keys) {
                        await this.redisClient.del(key);
                    }
                    console.log(`🔓 [REDIS] ${keys.length} locks limpiados`);
                } catch (error) {
                    console.error('Error limpiando locks Redis:', error);
                }
            }
        } else if (this.lockProvider === 'mysql') {
            // Limpiar MySQL
            if (this.dbConnection) {
                try {
                    const result = await this.dbConnection.querySequelize('DELETE FROM recargas_process_locks', {
                        type: this.dbConnection.getSequelizeClient().QueryTypes.DELETE
                    });
                    console.log(`🔓 [MYSQL] ${result[1] || 0} locks limpiados`);
                } catch (error) {
                    console.error('Error limpiando locks MySQL:', error);
                }
            }
        }
    }

    async cleanupExpiredLocks() {
        console.log(`🧹 [CLEANUP] Limpiando locks expirados (proveedor: ${this.lockProvider.toUpperCase()})...`);
        
        if (this.lockProvider === 'redis') {
            await this.cleanupExpiredLocksRedis();
        } else if (this.lockProvider === 'mysql') {
            await this.cleanupExpiredLocksMySQL();
        }
    }

    async cleanupExpiredLocksRedis() {
        try {
            let keys = [];
            if (this.redisClient.keys) {
                keys = await this.redisClient.keys(`${this.lockPrefix}*`);
            } else if (this.redisClient.getConnection) {
                // Handle pooled connections
                const conn = await this.redisClient.getConnection();
                try {
                    keys = await conn.client.keys(`${this.lockPrefix}*`);
                } finally {
                    conn.release();
                }
            }

            let cleaned = 0;

            for (const key of keys) {
                const data = await this.redisClient.get(key);
                if (data) {
                    const parsed = JSON.parse(data);
                    if (Date.now() > parsed.expiresAt) {
                        await this.redisClient.del(key);
                        cleaned++;
                        console.log(`🧹 [REDIS] Lock expirado eliminado: ${key.replace(this.lockPrefix, '')}`);
                    }
                }
            }

            if (cleaned > 0) {
                console.log(`🧹 [REDIS] ${cleaned} locks expirados limpiados`);
            }
        } catch (error) {
            console.error('Error limpiando locks expirados Redis:', error);
        }
    }

    async cleanupExpiredLocksMySQL() {
        try {
            const deleteSql = `DELETE FROM recargas_process_locks WHERE expires_at <= NOW()`;
            const result = await this.dbConnection.querySequelize(deleteSql, {
                type: this.dbConnection.getSequelizeClient().QueryTypes.DELETE
            });
            
            if (result[1] > 0) {
                console.log(`🧹 [MYSQL] ${result[1]} locks expirados limpiados`);
            }
        } catch (error) {
            console.error('Error limpiando locks expirados MySQL:', error);
        }
    }

    async ensureLockTable() {
        const sql = `
            CREATE TABLE IF NOT EXISTS recargas_process_locks (
                id INT AUTO_INCREMENT PRIMARY KEY,
                lock_key VARCHAR(100) NOT NULL UNIQUE,
                lock_id VARCHAR(255) NOT NULL,
                pid INT,
                acquired_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                expires_at TIMESTAMP NULL,
                INDEX idx_lock_key (lock_key),
                INDEX idx_expires (expires_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `;

        try {
            await this.dbConnection.querySequelize(sql, {
                type: this.dbConnection.getSequelizeClient().QueryTypes.RAW
            });
        } catch (error) {
            // Tabla ya existe
        }
    }
}

module.exports = { OptimizedLockManager };
