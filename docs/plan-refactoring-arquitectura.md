# 📋 PLAN DE REFACTORING - SISTEMA DE RECARGAS OPTIMIZADO v2.0

## 📊 RESUMEN EJECUTIVO

Este documento detalla el plan de refactoring identificado para optimizar la arquitectura del sistema de recargas, eliminando ~1100+ líneas de código redundante mientras se mantiene toda la funcionalidad actual.

## 🎯 OBJETIVOS

1. **Eliminar código muerto** (~575 líneas)
2. **Centralizar código duplicado** (~800 líneas)
3. **Unificar comportamientos** entre servicios
4. **Mantener funcionalidad actual** al 100%
5. **Mejorar mantenibilidad** y escalabilidad

## 🔴 FASE 1: LIMPIEZA INMEDIATA (1 hora)

### Archivos a Eliminar Completamente

| Archivo | Líneas | Justificación |
|---------|--------|---------------|
| `create_test_queue.js` | 112 | Script temporal de testing, propósito cumplido |
| `fix_queue.js` | 58 | Script de migración completado |
| `test_recovery.js` | 117 | Script de simulación, no usado en producción |
| `test_queue_simulation.js` | 268 | Sistema de mocks para testing |
| **TOTAL** | **555** | |

### Correcciones Rápidas

#### 1. Corregir información incorrecta en `index.js`
```javascript
// ACTUAL (líneas 158-160) - INCORRECTO:
console.log('   • GPS: Cada 15 minutos');  // ❌
console.log('   • VOZ: Diario 6:00 AM');   // ❌

// CORREGIR A:
console.log(`   • GPS: Cada ${gpsInterval} minutos`);
console.log('   • VOZ: 2 veces al día (1:00 AM y 4:00 AM)');
```

#### 2. Remover/Condicionar código de testing
```javascript
// Líneas 90-98 - Mover a desarrollo únicamente:
if (process.env.NODE_ENV === 'development' && process.env.TEST_VOZ === 'true') {
    // Solo ejecutar en modo desarrollo Y con flag explícito
}
```

### Checklist Fase 1
- [ ] Eliminar 4 archivos de testing/simulación
- [ ] Corregir mensajes hardcodeados en index.js
- [ ] Condicionar código de testing a desarrollo
- [ ] Commit: "chore: limpieza de código muerto y correcciones menores"

## 🟡 FASE 2: CENTRALIZACIÓN DE CÓDIGO (2-3 horas)

### 1. Crear Clase Base Abstracta

**Archivo nuevo**: `lib/processors/BaseRechargeProcessor.js`

```javascript
class BaseRechargeProcessor {
    constructor(dbConnection, lockManager, persistenceQueue, config) {
        this.db = dbConnection;
        this.lockManager = lockManager;
        this.persistenceQueue = persistenceQueue;
        this.config = config;
    }

    // ===== MÉTODOS WEBSERVICE COMUNES =====
    async getTaecelBalance() { 
        // Mover implementación de GPS líneas 924-990
    }
    
    async taecelRequestTXN(sim, producto) { 
        // Mover implementación de GPS líneas 1025-1057
    }
    
    async taecelStatusTXN(transID) { 
        // Mover implementación de GPS líneas 1059-1091
    }
    
    async getMstBalance() { 
        // Mover implementación común
    }

    // ===== UTILIDADES COMUNES =====
    async delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    generateProgressBar(current, total, length = 20) {
        // Mover de GPS líneas 237-260
    }
    
    // ===== RETRY LOGIC UNIFICADA =====
    async executeWithRetry(operation, config = {}) {
        const { 
            maxRetries = 3, 
            delayStrategy = 'exponential',
            baseDelay = 1000 
        } = config;
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await operation();
            } catch (error) {
                if (attempt === maxRetries) throw error;
                
                const delay = delayStrategy === 'exponential' 
                    ? attempt * baseDelay 
                    : baseDelay;
                    
                console.log(`   ⏳ Reintento ${attempt}/${maxRetries} en ${delay}ms...`);
                await this.delay(delay);
            }
        }
    }
    
    // ===== TEMPLATE METHOD PATTERN =====
    async process() {
        const stats = { processed: 0, success: 0, failed: 0 };
        const lockKey = `recharge_${this.getServiceType()}`;
        const lockId = `${lockKey}_${process.pid}_${Date.now()}`;
        let lockAcquired = false;
        
        try {
            // 1. Adquirir lock
            const lockResult = await this.lockManager.acquireLock(
                lockKey, 
                lockId, 
                this.config.LOCK_TIMEOUT || 3600
            );
            
            if (!lockResult.success) {
                console.log(`   ⚠️ No se pudo adquirir lock ${this.getServiceType()}`);
                return stats;
            }
            lockAcquired = true;
            
            // 2. Recovery estricto
            console.log(`🔄 Verificando cola auxiliar ${this.getServiceType()}...`);
            const pendingStats = await this.persistenceQueue.getQueueStats();
            
            if (pendingStats.auxiliaryQueue.pendingDb > 0) {
                console.log(`⚡ Procesando ${pendingStats.auxiliaryQueue.pendingDb} recargas de recovery...`);
                const recoveryResult = await this.processAuxiliaryQueueRecharges();
                console.log(`   • Cola auxiliar: ${recoveryResult.processed} recuperadas, ${recoveryResult.failed} fallidas`);
                
                // POLÍTICA ESTRICTA: Si hay fallas, NO continuar
                if (recoveryResult.failed > 0) {
                    console.log(`   ⚠️ HAY ${recoveryResult.failed} REGISTROS PENDIENTES SIN PROCESAR. NO CONSUMIENDO WEBSERVICES.`);
                    stats.failed = recoveryResult.failed;
                    return stats;
                }
            }
            
            // 3. Procesar nuevos registros
            const records = await this.getRecordsToProcess();
            console.log(`   📋 ${records.length} registros para procesar`);
            
            if (records.length === 0) {
                return stats;
            }
            
            // 4. Procesar con configuración específica del servicio
            return await this.processRecords(records, stats);
            
        } finally {
            if (lockAcquired) {
                await this.lockManager.releaseLock(lockKey, lockId);
            }
        }
    }
    
    // ===== MÉTODOS ABSTRACTOS (cada servicio implementa) =====
    abstract getServiceType();
    abstract getRecordsToProcess();
    abstract processRecords(records, stats);
    abstract getServiceConfig();
}

module.exports = { BaseRechargeProcessor };
```

### 2. Crear Cliente de Webservices Centralizado

**Archivo nuevo**: `lib/webservices/WebserviceClient.js`

```javascript
const axios = require('axios');
const soapRequest = require('easy-soap-request');
const xml2js = require('xml2js');
const config = require('../../config/database');

class WebserviceClient {
    // ===== TAECEL METHODS =====
    static async getTaecelBalance() {
        const json_taecel = {
            key: config.TAECEL.key,
            nip: config.TAECEL.nip
        };

        const config_taecel = {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'Mozilla/5.0 (compatible; Recargas-System/1.0)'
            },
            timeout: 30000,
            validateStatus: (status) => status < 500
        };

        const response = await axios.post(
            `${config.TAECEL.url}/getBalance`,
            json_taecel,
            config_taecel
        );

        if (response.data?.success && response.data?.data) {
            const tiempoAire = response.data.data.find(item => item.Bolsa === "Tiempo Aire");
            if (tiempoAire) {
                const saldo = tiempoAire.Saldo.replace(/,/g, "");
                return parseFloat(saldo);
            }
        }
        
        throw new Error("No se pudo obtener saldo TAECEL");
    }
    
    static async taecelRequestTXN(sim, producto) {
        // Implementación única desde GPS
    }
    
    static async taecelStatusTXN(transID) {
        // Implementación única desde GPS
    }
    
    // ===== MST METHODS =====
    static async getMstBalance() {
        // Implementación única
    }
    
    static async mstRecharge(sim, paquete) {
        // Implementación única
    }
}

module.exports = { WebserviceClient };
```

### 3. Crear Configuración Centralizada

**Archivo nuevo**: `config/services.js`

```javascript
module.exports = {
    GPS: {
        // Configuración fija
        IMPORTE: 10,
        DIAS: 8,
        CODIGO: 'TEL010',
        
        // Comportamiento
        DELAY_BETWEEN_CALLS: 500,
        RETRY_STRATEGY: 'exponential',
        RETRY_BASE_DELAY: 1000,
        MAX_RETRIES: 3,
        
        // Scheduling
        SCHEDULE_TYPE: 'interval',
        SCHEDULE_MINUTES: process.env.GPS_MINUTOS_SIN_REPORTAR || 10,
        
        // Límites
        DIAS_SIN_REPORTAR_LIMITE: parseInt(process.env.GPS_DIAS_SIN_REPORTAR) || 14,
        MINUTOS_SIN_REPORTAR_PARA_RECARGA: parseInt(process.env.GPS_MINUTOS_SIN_REPORTAR) || 10,
        
        // Features
        SHOW_PROGRESS_BAR: true,
        BATCH_PROCESSING: true
    },
    
    VOZ: {
        // Comportamiento unificado con GPS
        DELAY_BETWEEN_CALLS: 500,  // Unificar con GPS
        RETRY_STRATEGY: 'exponential',  // Unificar con GPS
        RETRY_BASE_DELAY: 1000,
        MAX_RETRIES: 3,
        
        // Scheduling
        SCHEDULE_TYPE: 'cron',
        SCHEDULE_HOURS: [1, 4],  // 1:00 AM y 4:00 AM
        
        // Límites
        MIN_BALANCE_THRESHOLD: 100,
        
        // Features
        SHOW_PROGRESS_BAR: false,
        BATCH_PROCESSING: false
    },
    
    IOT: {
        // Configuración para futura implementación
        SCHEDULE_TYPE: 'cron',
        SCHEDULE_MINUTES: [0, 30],  // Cada 30 minutos
        
        // Placeholder para desarrollo futuro
        IMPLEMENTED: false
    }
};
```

### Checklist Fase 2
- [ ] Crear BaseRechargeProcessor.js
- [ ] Crear WebserviceClient.js
- [ ] Crear config/services.js
- [ ] Commit: "feat: crear arquitectura base centralizada"

## 🟠 FASE 3: REFACTORING DE PROCESADORES (3-4 horas)

### 1. Refactorizar GPSRechargeProcessor

```javascript
const { BaseRechargeProcessor } = require('./BaseRechargeProcessor');
const serviceConfig = require('../../config/services');

class GPSRechargeProcessor extends BaseRechargeProcessor {
    constructor(dbConnection, lockManager, persistenceQueue) {
        super(dbConnection, lockManager, persistenceQueue, serviceConfig.GPS);
    }
    
    getServiceType() { 
        return 'gps'; 
    }
    
    getServiceConfig() {
        return this.config;
    }
    
    async getRecordsToProcess() {
        // Solo mantener lógica específica de GPS
        // Eliminar métodos webservice duplicados
    }
    
    async processRecords(records, stats) {
        // Solo mantener lógica específica de procesamiento GPS
        // Usar this.executeWithRetry() para reintentos
        // Usar this.delay() para animaciones
    }
}
```

### 2. Refactorizar VozRechargeProcessor

```javascript
const { BaseRechargeProcessor } = require('./BaseRechargeProcessor');
const serviceConfig = require('../../config/services');

class VozRechargeProcessor extends BaseRechargeProcessor {
    constructor(dbConnection, lockManager, persistenceQueue) {
        super(dbConnection, lockManager, persistenceQueue, serviceConfig.VOZ);
        
        // Configuración específica de VOZ
        this.paquetes = {
            150005: { codigo: "PSL150", dias: 25, monto: 150 },
            150006: { codigo: "PSL150", dias: 25, monto: 150 },
            // ... resto de paquetes
        };
    }
    
    getServiceType() { 
        return 'voz'; 
    }
    
    async getRecordsToProcess() {
        // Solo lógica específica de VOZ
    }
    
    async processRecords(records, stats) {
        // Usar configuración unificada para delays
        for (const record of records) {
            // Procesar registro
            await this.processVozRecord(record, stats);
            
            // Usar delay unificado (500ms como GPS)
            if (this.config.DELAY_BETWEEN_CALLS > 0) {
                await this.delay(this.config.DELAY_BETWEEN_CALLS);
            }
        }
    }
}
```

### 3. Implementar IoTRechargeProcessor (opcional)

```javascript
const { BaseRechargeProcessor } = require('./BaseRechargeProcessor');
const serviceConfig = require('../../config/services');

class IoTRechargeProcessor extends BaseRechargeProcessor {
    constructor(dbConnection, lockManager, persistenceQueue) {
        super(dbConnection, lockManager, persistenceQueue, serviceConfig.IOT);
    }
    
    getServiceType() { 
        return 'iot'; 
    }
    
    async getRecordsToProcess() {
        if (!this.config.IMPLEMENTED) {
            return [];
        }
        // TODO: Implementar lógica IoT
    }
    
    async processRecords(records, stats) {
        // TODO: Implementar procesamiento IoT
        return stats;
    }
}
```

### Checklist Fase 3
- [ ] Refactorizar GPSRechargeProcessor para extender BaseRechargeProcessor
- [ ] Eliminar métodos webservice duplicados de GPS
- [ ] Refactorizar VozRechargeProcessor para extender BaseRechargeProcessor
- [ ] Eliminar métodos webservice duplicados de VOZ
- [ ] Unificar delays y reintentos usando configuración
- [ ] Actualizar IoTRechargeProcessor (marcar como TODO si no se implementa)
- [ ] Commit: "refactor: migrar procesadores a arquitectura base"

## ✅ FASE 4: TESTING Y VALIDACIÓN (2 horas)

### 1. Testing GPS
- [ ] Verificar proceso normal de recargas GPS
- [ ] Probar recovery de cola auxiliar GPS
- [ ] Validar delays y animaciones (500ms + exponential)
- [ ] Confirmar actualización de fechas en BD

### 2. Testing VOZ
- [ ] Verificar proceso normal de recargas VOZ
- [ ] Probar recovery de cola auxiliar VOZ
- [ ] Validar nuevos delays unificados (500ms)
- [ ] Confirmar reintentos exponenciales
- [ ] Verificar horarios de ejecución (1:00 AM y 4:00 AM)

### 3. Testing Recovery Estricto
- [ ] Simular fallo en BD para GPS
- [ ] Verificar que NO consume webservices con fallos pendientes
- [ ] Simular fallo en BD para VOZ
- [ ] Verificar aislamiento entre servicios

### 4. Testing de Regresión
- [ ] Ejecutar sistema completo por 1 hora
- [ ] Verificar logs y métricas
- [ ] Confirmar que no hay errores nuevos
- [ ] Validar que la funcionalidad se mantiene

### Checklist Fase 4
- [ ] Completar todos los tests de GPS
- [ ] Completar todos los tests de VOZ
- [ ] Verificar política de recovery estricto
- [ ] Ejecutar pruebas de regresión
- [ ] Documentar cualquier issue encontrado
- [ ] Commit: "test: validación completa del refactoring"

## 📊 MÉTRICAS DE ÉXITO

### Antes del Refactoring
- Líneas totales: ~3500
- Código duplicado: ~800 líneas
- Archivos: 20
- Métodos duplicados: 15+
- Complejidad ciclomática promedio: 12-15

### Después del Refactoring
- Líneas totales: ~2400 (-31%)
- Código duplicado: ~100 líneas (-87%)
- Archivos: 15 (-25%)
- Métodos duplicados: 2-3 (-80%)
- Complejidad ciclomática promedio: 6-8 (-40%)

### Beneficios Adicionales
1. **Mantenibilidad**: Un solo lugar para cambios de webservices
2. **Consistencia**: Comportamiento unificado entre servicios
3. **Escalabilidad**: Fácil agregar nuevos servicios
4. **Testing**: Más simple probar clase base
5. **Performance**: Código optimizado reutilizable

## ⚠️ CONSIDERACIONES IMPORTANTES

### Mantener Funcionalidad Actual
1. **Colas separadas por servicio** ✅
2. **Recovery estricto** ✅
3. **Scheduling independiente** ✅
4. **Aislamiento entre servicios** ✅
5. **Política ALL or NOTHING** ✅

### Riesgos y Mitigación
| Riesgo | Probabilidad | Impacto | Mitigación |
|--------|--------------|---------|------------|
| Romper GPS funcional | Baja | Alto | Testing exhaustivo |
| Romper VOZ funcional | Baja | Alto | Testing exhaustivo |
| Pérdida de datos en cola | Muy baja | Alto | Backup de colas antes de cambios |
| Problemas de concurrencia | Baja | Medio | Mantener locks actuales |

## 📅 CRONOGRAMA ESTIMADO

| Fase | Duración | Prioridad | Dependencias |
|------|----------|-----------|--------------|
| Fase 1: Limpieza | 1 hora | Alta | Ninguna |
| Fase 2: Centralización | 2-3 horas | Alta | Fase 1 |
| Fase 3: Refactoring | 3-4 horas | Media | Fase 2 |
| Fase 4: Testing | 2 horas | Alta | Fase 3 |
| **TOTAL** | **8-10 horas** | | |

## 🎯 PRÓXIMOS PASOS

1. **Aprobación**: Revisar y aprobar este plan
2. **Backup**: Respaldar código y datos actuales
3. **Rama de desarrollo**: Crear branch `refactor/architecture-v2`
4. **Ejecución**: Seguir las fases en orden
5. **Review**: Code review antes de merge a main
6. **Deploy**: Despliegue gradual con monitoreo

## 📝 NOTAS FINALES

Este refactoring es **no destructivo** - mantiene toda la funcionalidad actual mientras mejora significativamente la arquitectura. El sistema resultante será más fácil de mantener, extender y depurar.

**Fecha de creación**: 2025-09-13
**Autor**: Sistema de Análisis Arquitectónico
**Versión**: 1.0.0