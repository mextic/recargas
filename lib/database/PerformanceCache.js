/**
 * Performance Cache System - FASE 4 Optimización
 * Sistema de caché seguro que NO cachea datos críticos para decisiones de recarga
 */
const moment = require('moment-timezone');

class PerformanceCache {
    constructor(redisClient) {
        this.redis = redisClient;
        this.memoryCache = new Map(); // Fallback cuando Redis no está disponible
        this.isRedisAvailable = !!redisClient;
        this.bypassMode = false; // Modo de emergencia para desactivar todo caché
        
        // Configuración de TTL para diferentes tipos de datos
        this.cacheTTL = {
            dispositivos_info: 300,     // 5 minutos - info estática de dispositivos
            provider_balance: 60,       // 1 minuto - saldos de proveedores
            analytics_data: 300,        // 5 minutos - datos de analytics
            voz_packages: 600,          // 10 minutos - configuración de paquetes VOZ
            company_info: 1800,         // 30 minutos - información de empresas
        };

        // Datos que NUNCA deben cachearse (críticos para decisiones de recarga)
        this.criticalDataPatterns = [
            'unix_saldo',
            'minutos_sin_reportar',
            'dias_sin_reportar',
            'metrics_mongodb',
            'recharge_status',
            'queue_status',
            'balance_real',
            'saldo_vencimiento'
        ];

        this.stats = {
            hits: 0,
            misses: 0,
            sets: 0,
            deletes: 0,
            bypasses: 0
        };
    }

    async initialize() {
        console.log('🚀 Inicializando Performance Cache System...');
        
        if (this.isRedisAvailable) {
            try {
                await this.redis.ping();
                console.log('   ✅ Redis disponible para cache');
            } catch (error) {
                console.log('   ⚠️ Redis no responde, usando cache en memoria');
                this.isRedisAvailable = false;
            }
        }

        // Pre-cargar algunos datos estáticos al inicio (cache warming)
        await this.warmupCache();
        
        console.log(`   📊 Cache configurado: ${this.isRedisAvailable ? 'Redis' : 'Memoria'}`);
    }

    async warmupCache() {
        console.log('🔥 Precargando cache con datos estáticos...');
        
        // Aquí se pueden precargar datos que cambian poco
        // Por ejemplo: configuraciones, catálogos, etc.
        
        console.log('   ✅ Cache warmup completado');
    }

    isCriticalData(key) {
        return this.criticalDataPatterns.some(pattern => 
            key.toLowerCase().includes(pattern.toLowerCase())
        );
    }

    generateKey(prefix, ...parts) {
        return `recargas:${prefix}:${parts.join(':')}`;
    }

    async get(key) {
        // Modo bypass - siempre devolver null para forzar consulta directa
        if (this.bypassMode) {
            this.stats.bypasses++;
            return null;
        }

        // Verificar si es dato crítico
        if (this.isCriticalData(key)) {
            console.log(`⚠️ Datos críticos no cacheados: ${key}`);
            this.stats.bypasses++;
            return null;
        }

        try {
            let value = null;

            if (this.isRedisAvailable) {
                const cached = await this.redis.get(key);
                if (cached) {
                    value = JSON.parse(cached);
                }
            } else {
                const cached = this.memoryCache.get(key);
                if (cached && cached.expires > Date.now()) {
                    value = cached.data;
                } else if (cached) {
                    this.memoryCache.delete(key);
                }
            }

            if (value) {
                this.stats.hits++;
                return value;
            } else {
                this.stats.misses++;
                return null;
            }
        } catch (error) {
            console.error('Error en cache get:', error.message);
            this.stats.misses++;
            return null;
        }
    }

    async set(key, value, ttlSeconds = null) {
        // Modo bypass - no cachear nada
        if (this.bypassMode) {
            this.stats.bypasses++;
            return false;
        }

        // Verificar si es dato crítico
        if (this.isCriticalData(key)) {
            console.log(`⚠️ Dato crítico rechazado para cache: ${key}`);
            return false;
        }

        try {
            const ttl = ttlSeconds || this.getDefaultTTL(key);
            
            if (this.isRedisAvailable) {
                await this.redis.setEx(key, ttl, JSON.stringify(value));
            } else {
                this.memoryCache.set(key, {
                    data: value,
                    expires: Date.now() + (ttl * 1000)
                });
            }

            this.stats.sets++;
            return true;
        } catch (error) {
            console.error('Error en cache set:', error.message);
            return false;
        }
    }

    async delete(key) {
        try {
            if (this.isRedisAvailable) {
                await this.redis.del(key);
            } else {
                this.memoryCache.delete(key);
            }
            
            this.stats.deletes++;
            return true;
        } catch (error) {
            console.error('Error en cache delete:', error.message);
            return false;
        }
    }

    async invalidatePattern(pattern) {
        try {
            if (this.isRedisAvailable) {
                const keys = await this.redis.keys(`*${pattern}*`);
                if (keys.length > 0) {
                    await this.redis.del(keys);
                    console.log(`🗑️ Invalidadas ${keys.length} claves con patrón: ${pattern}`);
                }
            } else {
                const keysToDelete = [];
                for (const [key] of this.memoryCache) {
                    if (key.includes(pattern)) {
                        keysToDelete.push(key);
                    }
                }
                keysToDelete.forEach(key => this.memoryCache.delete(key));
                console.log(`🗑️ Invalidadas ${keysToDelete.length} claves con patrón: ${pattern}`);
            }
        } catch (error) {
            console.error('Error invalidando patrón:', error.message);
        }
    }

    getDefaultTTL(key) {
        for (const [type, ttl] of Object.entries(this.cacheTTL)) {
            if (key.includes(type)) {
                return ttl;
            }
        }
        return 300; // Default 5 minutos
    }

    // ===== MÉTODOS DE CACHE ESPECÍFICOS PARA EL DOMINIO =====

    async getDeviceInfo(sim) {
        const key = this.generateKey('device_info', sim);
        return await this.get(key);
    }

    async setDeviceInfo(sim, deviceData) {
        const key = this.generateKey('device_info', sim);
        // Solo cachear datos estáticos, NO unix_saldo ni datos críticos
        const safeData = {
            descripcion: deviceData.descripcion,
            empresa: deviceData.empresa,
            dispositivo: deviceData.dispositivo,
            // EXCLUIR: unix_saldo, minutos_sin_reportar, dias_sin_reportar
        };
        return await this.set(key, safeData, this.cacheTTL.dispositivos_info);
    }

    async getProviderBalance(provider) {
        const key = this.generateKey('provider_balance', provider);
        return await this.get(key);
    }

    async setProviderBalance(provider, balance) {
        const key = this.generateKey('provider_balance', provider);
        return await this.set(key, balance, this.cacheTTL.provider_balance);
    }

    async getVozPackageConfig(packageCode) {
        const key = this.generateKey('voz_package', packageCode);
        return await this.get(key);
    }

    async setVozPackageConfig(packageCode, config) {
        const key = this.generateKey('voz_package', packageCode);
        return await this.set(key, config, this.cacheTTL.voz_packages);
    }

    async getAnalyticsData(period, service) {
        const key = this.generateKey('analytics', period, service);
        return await this.get(key);
    }

    async setAnalyticsData(period, service, data) {
        const key = this.generateKey('analytics', period, service);
        return await this.set(key, data, this.cacheTTL.analytics_data);
    }

    // ===== INVALIDACIÓN INTELIGENTE =====

    async invalidateOnRecharge(sim, service) {
        console.log(`🔄 Invalidando cache post-recarga: ${service} - ${sim}`);
        
        // Invalidar caches relacionados con la recarga
        await this.invalidatePattern(`device_info:${sim}`);
        await this.invalidatePattern(`provider_balance`);
        await this.invalidatePattern(`analytics`);
        
        console.log('   ✅ Cache invalidado correctamente');
    }

    async invalidateOnConfigChange() {
        console.log('🔄 Invalidando cache por cambio de configuración...');
        
        await this.invalidatePattern('voz_package');
        await this.invalidatePattern('config');
        
        console.log('   ✅ Cache de configuración invalidado');
    }

    // ===== MODO DE EMERGENCIA =====

    enableBypassMode(reason = 'Manual') {
        this.bypassMode = true;
        console.log(`🚨 MODO BYPASS ACTIVADO: ${reason}`);
        console.log('   ⚠️ Todo el cache está deshabilitado');
    }

    disableBypassMode() {
        this.bypassMode = false;
        console.log('✅ Modo bypass desactivado - Cache reactivado');
    }

    // ===== MÉTRICAS Y MONITOREO =====

    getStats() {
        const total = this.stats.hits + this.stats.misses;
        const hitRatio = total > 0 ? (this.stats.hits / total * 100).toFixed(2) : 0;
        
        return {
            ...this.stats,
            hitRatio: `${hitRatio}%`,
            totalRequests: total,
            cacheType: this.isRedisAvailable ? 'Redis' : 'Memory',
            bypassMode: this.bypassMode
        };
    }

    async getHealthStatus() {
        const stats = this.getStats();
        const memoryUsage = this.memoryCache.size;
        
        return {
            status: this.bypassMode ? 'BYPASS' : 'ACTIVE',
            backend: this.isRedisAvailable ? 'Redis' : 'Memory',
            stats,
            memoryEntries: memoryUsage,
            redisAvailable: this.isRedisAvailable
        };
    }

    logStats() {
        const stats = this.getStats();
        console.log('📊 Cache Performance Stats:');
        console.log(`   • Hit Ratio: ${stats.hitRatio}`);
        console.log(`   • Hits: ${stats.hits}, Misses: ${stats.misses}`);
        console.log(`   • Sets: ${stats.sets}, Deletes: ${stats.deletes}`);
        console.log(`   • Bypasses: ${stats.bypasses}`);
        console.log(`   • Backend: ${stats.cacheType}`);
        console.log(`   • Mode: ${this.bypassMode ? 'BYPASS' : 'ACTIVE'}`);
    }
}

module.exports = PerformanceCache;