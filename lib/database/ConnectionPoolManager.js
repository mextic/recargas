const Redis = require('ioredis');
const { createPool } = require('generic-pool');
const config = require('../../config/database');

/**
 * Connection Pool Manager for Redis and MySQL connections
 * Provides optimized connection pooling with health monitoring and graceful shutdown
 */
class ConnectionPoolManager {
    constructor() {
        this.redisPool = null;
        this.stats = {
            redis: {
                created: 0,
                destroyed: 0,
                errors: 0,
                activeConnections: 0,
                pendingAcquires: 0
            }
        };
        this.isShuttingDown = false;
        this.statsInterval = null;
    }

    /**
     * Initialize Redis connection pool with ioredis and generic-pool
     */
    async initializeRedisPool() {
        const redisConfig = config.REDIS;
        const poolConfig = redisConfig.pool;

        // Redis connection factory
        const factory = {
            create: async () => {
                try {
                    const client = new Redis({
                        host: redisConfig.host,
                        port: redisConfig.port,
                        retryDelayOnFailover: 100,
                        maxRetriesPerRequest: 3,
                        lazyConnect: true,
                        enableReadyCheck: true,
                        autoResubscribe: true,
                        enableOfflineQueue: false,
                        connectTimeout: 10000,
                        commandTimeout: 5000
                    });

                    // Setup event handlers
                    client.on('connect', () => {
                        this.stats.redis.created++;
                    });

                    client.on('error', (err) => {
                        this.stats.redis.errors++;
                        console.error('Redis connection error:', err.message);
                    });

                    client.on('close', () => {
                        this.stats.redis.destroyed++;
                    });

                    // Test connection
                    await client.connect();
                    await client.ping();

                    return client;
                } catch (error) {
                    this.stats.redis.errors++;
                    throw new Error(`Failed to create Redis connection: ${error.message}`);
                }
            },

            destroy: async (client) => {
                try {
                    if (client && client.status === 'ready') {
                        await client.quit();
                    } else if (client) {
                        client.disconnect();
                    }
                } catch (error) {
                    console.error('Error destroying Redis connection:', error.message);
                    if (client) {
                        client.disconnect();
                    }
                }
            },

            validate: async (client) => {
                try {
                    if (!client || client.status !== 'ready') {
                        return false;
                    }
                    await client.ping();
                    return true;
                } catch (error) {
                    return false;
                }
            }
        };

        // Create connection pool
        this.redisPool = createPool(factory, {
            min: poolConfig.min,
            max: poolConfig.max,
            acquireTimeoutMillis: poolConfig.acquireTimeoutMillis,
            idleTimeoutMillis: poolConfig.idleTimeoutMillis,
            evictionRunIntervalMillis: poolConfig.evictionRunIntervalMillis,
            testOnBorrow: true,
            testOnReturn: false
        });

        // Pool event handlers
        this.redisPool.on('factoryCreateError', (err) => {
            this.stats.redis.errors++;
            console.error('Redis pool factory error:', err.message);
        });

        this.redisPool.on('factoryDestroyError', (err) => {
            console.error('Redis pool destroy error:', err.message);
        });

        console.log('Redis connection pool initialized:', {
            min: poolConfig.min,
            max: poolConfig.max,
            acquireTimeout: poolConfig.acquireTimeoutMillis
        });
    }

    /**
     * Get Redis connection from pool with automatic release
     */
    async getRedisConnection() {
        if (this.isShuttingDown) {
            throw new Error('Connection pool is shutting down');
        }

        if (!this.redisPool) {
            throw new Error('Redis pool not initialized');
        }

        let connection = null;
        try {
            connection = await this.redisPool.acquire();
            this.stats.redis.activeConnections++;

            // Return wrapped connection with auto-release
            return {
                client: connection,
                release: () => {
                    if (connection && this.redisPool) {
                        this.redisPool.release(connection);
                        this.stats.redis.activeConnections--;
                    }
                },
                // Proxy common Redis methods
                async get(key) {
                    return connection.get(key);
                },
                async set(key, value, ...args) {
                    return connection.set(key, value, ...args);
                },
                async del(key) {
                    return connection.del(key);
                },
                async exists(key) {
                    return connection.exists(key);
                },
                async expire(key, seconds) {
                    return connection.expire(key, seconds);
                },
                async hget(key, field) {
                    return connection.hget(key, field);
                },
                async hset(key, field, value) {
                    return connection.hset(key, field, value);
                },
                async hgetall(key) {
                    return connection.hgetall(key);
                },
                async eval(script, numKeys, ...args) {
                    return connection.eval(script, numKeys, ...args);
                },
                async ping() {
                    return connection.ping();
                }
            };
        } catch (error) {
            this.stats.redis.errors++;
            if (connection && this.redisPool) {
                try {
                    this.redisPool.release(connection);
                } catch (releaseError) {
                    console.error('Error releasing failed connection:', releaseError.message);
                }
            }
            throw new Error(`Failed to acquire Redis connection: ${error.message}`);
        }
    }

    /**
     * Execute Redis operation with automatic connection management
     */
    async executeRedisOperation(operation) {
        const connection = await this.getRedisConnection();
        try {
            return await operation(connection);
        } finally {
            connection.release();
        }
    }

    /**
     * Execute Redis operation with pooled client - Non-breaking API helper
     * @param {Function} fn - Function that receives a Redis client and returns a promise
     * @returns {Promise} - Result of the operation
     */
    async withRedis(fn) {
        if (this.isShuttingDown) {
            throw new Error('Connection pool is shutting down');
        }

        if (!this.redisPool) {
            throw new Error('Redis pool not initialized');
        }

        let connection = null;
        try {
            connection = await this.redisPool.acquire();
            this.stats.redis.activeConnections++;

            // Execute the function with the raw Redis client
            return await fn(connection);
        } catch (error) {
            this.stats.redis.errors++;
            throw new Error(`Redis operation failed: ${error.message}`);
        } finally {
            if (connection && this.redisPool) {
                this.redisPool.release(connection);
                this.stats.redis.activeConnections--;
            }
        }
    }

    /**
     * Get pool statistics for monitoring
     */
    getPoolStats() {
        const redisPoolStats = this.redisPool ? {
            size: this.redisPool.size,
            available: this.redisPool.available,
            borrowed: this.redisPool.borrowed,
            pending: this.redisPool.pending,
            max: this.redisPool.max,
            min: this.redisPool.min
        } : null;

        return {
            redis: {
                pool: redisPoolStats,
                stats: { ...this.stats.redis },
                isInitialized: !!this.redisPool,
                isShuttingDown: this.isShuttingDown
            },
            timestamp: new Date().toISOString()
        };
    }

    /**
     * Start pool monitoring if enabled
     */
    startMonitoring() {
        if (!config.POOL_MONITORING.enabled) {
            console.log('Pool monitoring disabled');
            return;
        }

        this.statsInterval = setInterval(() => {
            const stats = this.getPoolStats();

            // Basic pool stats logging
            console.log('📊 [POOL_MONITOR] Connection Pool Stats:', JSON.stringify(stats, null, 2));

            // Check for pool exhaustion alerts
            if (stats.redis?.pool) {
                const redis = stats.redis.pool;
                const utilizationPercent = (redis.borrowed / redis.max) * 100;

                if (utilizationPercent > 90) {
                    console.warn(`⚠️ [POOL_ALERT] Redis pool high utilization: ${utilizationPercent.toFixed(1)}% (${redis.borrowed}/${redis.max})`);
                }

                if (redis.pending > 5) {
                    console.warn(`⚠️ [POOL_ALERT] Redis pool high pending: ${redis.pending} connections waiting`);
                }
            }

            // Check Redis connection errors
            if (stats.redis?.stats && stats.redis.stats.errors > 0) {
                console.warn(`⚠️ [POOL_ALERT] Redis connection errors detected: ${stats.redis.stats.errors} total errors`);
            }

        }, config.POOL_MONITORING.statsInterval);

        console.log(`🔍 Connection pool monitoring started (interval: ${config.POOL_MONITORING.statsInterval}ms)`);
    }

    /**
     * Stop pool monitoring
     */
    stopMonitoring() {
        if (this.statsInterval) {
            clearInterval(this.statsInterval);
            this.statsInterval = null;
        }
    }

    /**
     * Health check for connection pools
     */
    async checkHealth() {
        const health = {
            redis: { healthy: false, error: null },
            timestamp: new Date().toISOString()
        };

        // Check Redis pool health
        if (this.redisPool) {
            try {
                const connection = await this.getRedisConnection();
                await connection.ping();
                connection.release();
                health.redis.healthy = true;
            } catch (error) {
                health.redis.error = error.message;
            }
        } else {
            health.redis.error = 'Redis pool not initialized';
        }

        return health;
    }

    /**
     * Graceful shutdown of all connection pools
     */
    async shutdown() {
        console.log('Initiating connection pool shutdown...');
        this.isShuttingDown = true;

        // Stop monitoring
        this.stopMonitoring();

        const shutdownPromises = [];

        // Shutdown Redis pool
        if (this.redisPool) {
            console.log('Draining Redis connection pool...');
            shutdownPromises.push(
                this.redisPool.drain().then(() => {
                    return this.redisPool.clear();
                }).catch(error => {
                    console.error('Error draining Redis pool:', error.message);
                })
            );
        }

        // Wait for all pools to shutdown with timeout
        try {
            await Promise.race([
                Promise.all(shutdownPromises),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Pool shutdown timeout')),
                    config.POOL_MONITORING.drainTimeout)
                )
            ]);
            console.log('Connection pools shutdown completed');
        } catch (error) {
            console.error('Connection pool shutdown error:', error.message);
        } finally {
            this.redisPool = null;
            this.isShuttingDown = false;
        }
    }
}

module.exports = ConnectionPoolManager;