# Sistema de Bloqueos (Locks) - OptimizedLockManager

## Descripción General

El sistema utiliza un gestor de locks distribuidos para prevenir ejecución concurrente de procesos. El `OptimizedLockManager` puede configurarse para usar **Redis** o **MySQL** como proveedor de locks, **sin fallback automático** para evitar inconsistencias.

## Configuración

### Variables de Entorno

```env
# Lock Configuration
LOCK_EXPIRATION_MINUTES=60    # Tiempo de expiración en minutos (default: 60)
LOCK_PROVIDER=redis           # Proveedor: 'redis' o 'mysql' (default: redis)
```

### Opciones de Proveedor

#### 1. Redis (Recomendado)
```env
LOCK_PROVIDER=redis
```

**Ventajas:**
- ✅ Diseñado específicamente para locks distribuidos
- ✅ Expiración automática con TTL
- ✅ Mejor rendimiento para operaciones de locks
- ✅ Menos carga en la base de datos principal

**Requisitos:**
- Servidor Redis disponible (configurado en `REDIS_HOST` y `REDIS_PORT`)
- Cliente Redis inicializado correctamente

#### 2. MySQL
```env
LOCK_PROVIDER=mysql
```

**Ventajas:**
- ✅ Usa la infraestructura de base de datos existente
- ✅ No depende de servicios externos adicionales
- ✅ Persistencia en caso de fallos de Redis

**Consideraciones:**
- ⚠️ Mayor carga en la base de datos principal
- ⚠️ Requiere limpieza manual de locks expirados

## Arquitectura

### Diseño Sin Fallback

**Anterior (problemático):**
```
1. Intenta Redis → falla → usa MySQL (lock creado)
2. Redis se recupera → solo busca en Redis → ❌ permite acceso concurrente
```

**Actual (consistente):**
```
1. Config: redis → solo usa Redis
2. Config: mysql → solo usa MySQL
3. Sin verificación cruzada → sin inconsistencias
```

### Métodos por Proveedor

#### Métodos Redis
- `acquireLockRedis(lockKey, lockId, timeoutSeconds)`
- `releaseLockRedis(lockKey, lockId)`
- `isLockedRedis(lockKey)`
- `cleanupExpiredLocksRedis()`

#### Métodos MySQL
- `acquireLockMySQL(lockKey, lockId, timeoutSeconds)`
- `releaseLockMySQL(lockKey, lockId)`
- `isLockedMySQL(lockKey)`
- `cleanupExpiredLocksMySQL()`

## Funcionamiento

### 1. Adquisición de Lock

```javascript
const lockResult = await lockManager.acquireLock('GPS_PROCESS', lockId, 3600);
if (!lockResult.success) {
    console.log('Proceso ya en ejecución');
    return;
}
```

**Flujo:**
1. Limpia locks expirados automáticamente
2. Verifica proveedor configurado
3. Intenta adquirir lock usando solo el proveedor seleccionado
4. Retorna resultado con información del proveedor usado

### 2. Liberación de Lock

```javascript
await lockManager.releaseLock('GPS_PROCESS', lockId);
```

**Comportamiento:**
- Solo opera en el proveedor configurado
- Logs específicos del proveedor usado
- Error handling individual por proveedor

### 3. Limpieza Automática

**Redis:**
- Verifica `expiresAt` timestamp en datos JSON
- Elimina keys expirados manualmente
- TTL como respaldo de seguridad

**MySQL:**
- Query: `DELETE FROM recargas_process_locks WHERE expires_at <= NOW()`
- Limpieza basada en timestamps de base de datos

## Estructura de Datos

### Redis
```json
{
  "lockId": "GPS_PROCESS_1234567890",
  "pid": 12345,
  "timestamp": 1703123456789,
  "expiresAt": 1703127056789
}
```

### MySQL
```sql
CREATE TABLE recargas_process_locks (
    id INT AUTO_INCREMENT PRIMARY KEY,
    lock_key VARCHAR(100) NOT NULL UNIQUE,
    lock_id VARCHAR(255) NOT NULL,
    pid INT,
    acquired_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NULL,
    INDEX idx_lock_key (lock_key),
    INDEX idx_expires (expires_at)
);
```

## Configuración por Proceso

### GPS Processor
```javascript
const lockExpirationMinutes = parseInt(process.env.LOCK_EXPIRATION_MINUTES) || 60;
const lockTimeoutSeconds = lockExpirationMinutes * 60;
const lockResult = await this.lockManager.acquireLock('GPS_PROCESS', lockId, lockTimeoutSeconds);
```

### VOZ Processor
```javascript
const lockExpirationMinutes = parseInt(process.env.LOCK_EXPIRATION_MINUTES) || 60;
const lockTimeoutSeconds = lockExpirationMinutes * 60;
const lockResult = await this.lockManager.acquireLock('VOZ_PROCESS', lockId, lockTimeoutSeconds);
```

## Monitoreo y Debug

### Logs del Sistema
```
🔧 [LOCK_MANAGER] Proveedor configurado: REDIS
🔐 [LOCK] Intentando adquirir lock: GPS_PROCESS
   • Lock ID: GPS_PROCESS_1703123456789
   • PID: 12345
   • Timeout: 3600s
   • Proveedor: REDIS
🧹 [CLEANUP] Limpiando locks expirados (proveedor: REDIS)...
✅ [REDIS] Lock adquirido exitosamente
```

### Stats del Sistema
```javascript
const stats = await lockManager.getStats();
// {
//   provider: 'REDIS',
//   active: 2,
//   redis: { active: 2 },
//   mysql: { active: 0 }
// }
```

## Recomendaciones

### Para Producción
1. **Usar Redis** como proveedor principal
2. **Configurar LOCK_EXPIRATION_MINUTES=60** para procesos largos
3. **Monitorear logs** para detectar locks colgados
4. **Backup de configuración** MySQL para mantenimiento de Redis

### Para Desarrollo
1. Usar **MySQL** si no tienes Redis local
2. **Tiempo menor** (15-30 minutos) para debugging rápido
3. **Limpiar locks manualmente** en caso de pruebas interrumpidas

### Troubleshooting
```bash
# Verificar locks activos en Redis
redis-cli keys "lockRecharge:*"

# Verificar locks activos en MySQL  
SELECT * FROM recargas_process_locks WHERE expires_at > NOW();

# Limpiar todos los locks (emergencia)
await lockManager.releaseAllLocks();
```

## Compatibilidad

### Migración desde Versión Anterior
- ✅ **Automática** - detecta variable `LOCK_PROVIDER`
- ✅ **Retrocompatible** - funciona sin configuración adicional
- ✅ **Default seguro** - Redis por defecto

### Cambio de Proveedor
1. Detener sistema: `npm stop`
2. Cambiar `LOCK_PROVIDER` en `.env`
3. Limpiar locks del proveedor anterior (opcional)
4. Reiniciar sistema: `npm start`