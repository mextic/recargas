#!/usr/bin/env node

/**
 * Script para limpiar locks expirados o zombie en Redis
 * Uso: node scripts/clean-locks.js [--force]
 */

const Redis = require('ioredis');

async function cleanLocks() {
    const redis = new Redis({
        host: process.env.REDIS_HOST || '10.8.0.1',
        port: process.env.REDIS_PORT || 6379,
        password: process.env.REDIS_PASSWORD || undefined,
        db: process.env.REDIS_DB || 0,
        retryDelayOnFailover: 100,
        maxRetriesPerRequest: 3
    });

    try {
        console.log('🧹 Limpiando locks en Redis...');

        // Buscar todos los locks
        const lockKeys = await redis.keys('lockRecharge:*');
        console.log(`   📋 Encontrados ${lockKeys.length} locks`);

        if (lockKeys.length === 0) {
            console.log('   ✅ No hay locks para limpiar');
            return;
        }

        let cleaned = 0;
        let kept = 0;

        for (const lockKey of lockKeys) {
            const lockData = await redis.get(lockKey);

            if (!lockData) {
                console.log(`   🗑️ Lock vacío eliminado: ${lockKey}`);
                await redis.del(lockKey);
                cleaned++;
                continue;
            }

            try {
                const lock = JSON.parse(lockData);
                const now = Date.now();
                const expirationTime = lock.timestamp + (lock.ttl * 1000);
                const isExpired = now > expirationTime;
                const force = process.argv.includes('--force');

                if (isExpired || force) {
                    console.log(`   🗑️ Lock eliminado: ${lockKey}`);
                    console.log(`      • PID: ${lock.pid}`);
                    console.log(`      • Edad: ${Math.round((now - lock.timestamp) / 60000)} minutos`);
                    console.log(`      • ${isExpired ? 'Expirado' : 'Forzado'}`);

                    await redis.del(lockKey);
                    cleaned++;
                } else {
                    console.log(`   ⏰ Lock activo mantenido: ${lockKey}`);
                    console.log(`      • PID: ${lock.pid}`);
                    console.log(`      • Expira en: ${Math.round((expirationTime - now) / 60000)} minutos`);
                    kept++;
                }
            } catch (error) {
                console.log(`   ❌ Error procesando lock ${lockKey}: ${error.message}`);
                if (process.argv.includes('--force')) {
                    await redis.del(lockKey);
                    cleaned++;
                }
            }
        }

        console.log(`\n📊 Resumen:`);
        console.log(`   • Locks eliminados: ${cleaned}`);
        console.log(`   • Locks mantenidos: ${kept}`);
        console.log(`   • Total procesados: ${lockKeys.length}`);

        if (cleaned > 0) {
            console.log('\n✅ Locks limpiados exitosamente');
        }

    } catch (error) {
        console.error('❌ Error limpiando locks:', error.message);
        process.exit(1);
    } finally {
        await redis.disconnect();
    }
}

// Ejecutar si es llamado directamente
if (require.main === module) {
    cleanLocks().catch(error => {
        console.error('❌ Error fatal:', error.message);
        process.exit(1);
    });
}

module.exports = { cleanLocks };