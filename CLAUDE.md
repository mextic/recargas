# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Available Commands

- `npm start` - Starts the main recharge orchestrator system
- `npm test` - Runs integration tests
- `npm run setup` - Runs setup script for initial configuration  
- `npm run monitor` - Starts the monitoring system

## Architecture Overview

This is a prepaid recharge system for GPS, VOZ (Voice), and IoT services. The system is built around three main architectural components:

### Core Architecture

1. **RechargeOrchestrator** (`index.js`) - Main orchestrator that coordinates all recharge processors and manages scheduling
2. **Processors** (`lib/processors/`) - Service-specific processors:
   - `GPSRechargeProcessor` - Handles GPS device recharges (fixed $10, 8 days)
   - `VozRechargeProcessor` - Handles voice service recharges
   - `IoTRechargeProcessor` - Handles IoT device recharges
3. **Concurrency System** (`lib/concurrency/`) - Manages distributed locking and persistence:
   - `OptimizedLockManager` - Redis-based distributed locking
   - `PersistenceQueueSystem` - File-based queue system with crash recovery

### Database Architecture

The system uses multiple database connections managed through `lib/database/`:
- MySQL databases: GPS_DB and ELIOT_DB (via Sequelize ORM)
- Redis for caching and distributed locking
- MongoDB for metrics storage

### Configuration

The system uses environment variables for all sensitive configuration. Copy `.env.example` to `.env` and configure with your actual credentials:

Required environment variables:
- Database passwords: `GPS_DB_PASSWORD`, `ELIOT_DB_PASSWORD`  
- Provider credentials: `TAECEL_KEY`, `TAECEL_NIP`, `MST_USER`, `MST_PASSWORD`

Optional variables have defaults defined in `config/database.js`.

Key service integrations:
- TAECEL API for recharge processing
- MST SOAP service for additional recharge operations

### Data Persistence

The system uses a dual-queue persistence mechanism:
- Main queue for primary operations
- Auxiliary queue for backup/recovery
- Crash recovery system stores state in `data/` directory
- Auto-recovery enabled by default with 3 retry attempts

#### Database Recharge Storage Pattern

**CRITICAL**: All recharges must follow the master-detail pattern:

**Master Record** (`recargas` table - GPS_DB):
- ONE master record per batch of recharges processed together
- Contains total amount, batch count notation like "[003/003]", and summary data
- Uses `tipo` field: 'rastreo' (GPS), 'paquete' (VOZ), 'eliot' (ELIoT)

**Detail Records** (`detalle_recargas` table - GPS_DB):  
- Multiple detail records linked to master via `id_recarga`
- Each detail represents one individual recharge with specific SIM data
- Contains webservice response data (folio, saldo final, carrier info)

**Service-Specific Database Updates**:
- **GPS**: Updates `dispositivos.unix_saldo` in GPS_DB after successful recharge
- **VOZ**: Updates `prepagos_automaticos.fecha_expira_saldo` in GPS_DB after successful recharge  
- **ELIoT**: Updates `agentes.fecha_saldo` in ELIOT_DB after successful recharge

**Variable Pricing Support**:
- All services support variable pricing using `r.importe` or `r.monto` from individual records
- GPS: Usually fixed but supports variable via `r.importe || this.config.IMPORTE`
- VOZ: Variable pricing based on package type using `r.monto`
- ELIoT: Variable pricing using `r.importe` from device configuration

## Recent Major Changes (Session 2025-09-13)

### ✅ Batch Processing Implementation (Critical Fix)
**Problem**: All services were creating 1:1 records (one master per recharge) instead of proper 1:N structure.

**Solution**: Implemented `insertBatchRecharges()` method in all processors:
- **GPS**: `lib/processors/GPSRechargeProcessor.js` - Master record with `[002/002]` notation + linked details
- **ELIoT**: `lib/processors/ELIoTRechargeProcessor.js` - Same pattern for IoT devices  
- **VOZ**: `lib/processors/VozRechargeProcessor.js` - Added batch processing for voice packages
- **Recovery**: `lib/processors/BaseRechargeProcessor.js` - Recovery operations now use batch processing when available

### ✅ MongoDB Metrics Integration for ELIoT
**Implementation**: Created complete MongoDB integration for ELIoT device filtering:
- **Model**: `lib/models/Metrica.js` - Schema with automatic indexing (uuid_1_fecha_-1, fecha_-1)
- **Client**: `lib/database/mongoClient.js` - MongoDB connection management
- **Function**: `consultarMetricaPorUuid()` - Retrieves latest device metrics
- **Filtering Logic**: Only recharge devices with 10+ minutes without reporting (configurable)
- **Environment Variables**: `ELIOT_DIAS_SIN_REPORTAR=14`, `ELIOT_MINUTOS_SIN_REPORTAR=10`

### ✅ Dynamic Scheduling Configuration
**Change**: ELIoT now uses same pattern as GPS for consistent scheduling:
- **Before**: Fixed 30-minute intervals
- **After**: Configurable `ELIOT_MINUTOS_SIN_REPORTAR=10` minute intervals
- **Consistency**: Both filtering criteria and execution frequency use same environment variable

### ⚠️ Testing Notes for Future Sessions
1. **Batch Processing Verification**: Check that recovery operations create single master records with multiple details
2. **MongoDB Metrics**: Verify ELIoT filtering works correctly with actual device data
3. **Variable Pricing**: Ensure all services handle `r.importe`/`r.monto` correctly instead of fixed amounts
4. **Scheduling**: Confirm ELIoT runs every 10 minutes as configured

### 🔧 Environment Variables Added
```bash
# ELIoT Configuration
ELIOT_DIAS_SIN_REPORTAR=14      # Maximum days to consider for query
ELIOT_MINUTOS_SIN_REPORTAR=10   # Minimum minutes without reporting to trigger recharge
```

## 🚀 PLAN DE MEJORAS DETALLADO (Para Futuras Sesiones)

### ✅ FASE 1: Testing + Logging (INICIADA)
**Estado**: En progreso - Testing completo ✅, Winston logging ✅

#### 1.1 Sistema de Testing ✅
- **Jest configurado** con estructura profesional
- **Mocks completos**: DB, Webservices, MongoDB
- **Tests unitarios**: BaseRechargeProcessor implementado
- **Tests integración**: GPSRechargeProcessor con flujo completo
- **Scripts**: `npm test`, `npm run test:coverage`, `npm run test:watch`

#### 1.2 Logging Estructurado ✅
- **Winston implementado** con logs JSON estructurados
- **Múltiples transports**: Console, File, Error, Debug
- **Rotación automática**: 10MB max por archivo
- **Service loggers**: Método `createServiceLogger(serviceName)`
- **Métricas separadas**: `logMetrics()` para business events
- **Error handling**: Exceptions y rejections capturadas

### 📋 FASE 2: Monitoring + Error Handling (PENDIENTE)

#### 2.1 Monitoring Avanzado
- **Dashboard mejorado**: Expandir `monitor.js` con métricas en tiempo real
- **Métricas de negocio**:
  - Recargas/hora por servicio
  - Tasa de éxito (%)
  - Montos procesados ($)
  - Tiempo promedio por operación
  - Distribución de errores por categoría
- **Health checks**: Endpoints `/health` y `/metrics`
- **Alertas automáticas**: Slack/Email cuando falle > X veces

#### 2.2 Manejo de Errores Categorizado
- **Clasificación de errores**:
  - `RETRIABLE`: Saldo insuficiente, timeout red
  - `FATAL`: Error de configuración, DB down
  - `BUSINESS`: SIM inválido, servicio no disponible
- **Circuit breaker**: Para servicios externos (TAECEL/MST)
- **Dead letter queue**: Para recargas que fallan consistentemente
- **Retry policies**: Diferenciadas por tipo de error
- **Error aggregation**: Agrupar errores similares

### 📋 FASE 3: Performance + API (PENDIENTE)

#### 3.1 Optimización Performance
- **Procesamiento paralelo**: Worker threads para recargas independientes
- **Pool conexiones**: Optimizar MySQL/Redis/MongoDB pools
- **Cache inteligente**: Redis cache para consultas frecuentes
- **Batch optimizado**: Prepared statements para inserts masivos
- **Rate limiting**: Proteger servicios externos

#### 3.2 API REST Control
```javascript
// Endpoints propuestos:
POST /api/v1/recharge/force/:service     // Forzar ejecución manual
GET  /api/v1/status                      // Estado detallado sistema
GET  /api/v1/queues                      // Estado colas auxiliares
PUT  /api/v1/config                      // Modificar config temporal
GET  /api/v1/metrics/history             // Estadísticas históricas
GET  /api/v1/locks                       // Locks activos
DELETE /api/v1/locks/:lockId             // Liberar lock específico
```

### 📋 FASE 4: DevOps + Seguridad (PENDIENTE)

#### 4.1 Containerización
- **Dockerfile**: Multi-stage build optimizado
- **docker-compose.yml**: Con MySQL, Redis, MongoDB
- **Health checks**: Container health verification
- **Resource limits**: Memory/CPU constraints

#### 4.2 CI/CD Pipeline
```yaml
# .github/workflows/ci.yml estructura:
- name: Test Suite
  run: npm run test:coverage
- name: Security Audit  
  run: npm audit
- name: Docker Build
  run: docker build -t recargas-system .
- name: Deploy to Staging
  run: ./scripts/deploy.sh staging
```

#### 4.3 Seguridad Avanzada
- **Secrets management**: AWS Secrets Manager
- **Encriptación**: Datos sensibles en colas auxiliares
- **Audit logs**: Todas las operaciones críticas
- **Rate limiting**: Por IP/usuario en API
- **JWT Authentication**: Para endpoints administrativos

### 🎯 ORDEN DE IMPLEMENTACIÓN SUGERIDO

**Próxima sesión (Fase 2A)**:
1. Expandir `monitor.js` con métricas de negocio
2. Implementar sistema de categorización de errores
3. Crear health check endpoints básicos

**Sesión siguiente (Fase 2B)**:
1. Circuit breaker para webservices
2. Dead letter queue implementation  
3. Sistema de alertas básico

**Mediano plazo (Fase 3)**:
1. API REST endpoints
2. Optimizaciones de performance
3. Cache layer con Redis

**Largo plazo (Fase 4)**:
1. Containerización completa
2. CI/CD pipeline
3. Security hardening

### 💡 NOTAS TÉCNICAS IMPORTANTES

- **Testing**: Estructura creada permite fácil extensión a VOZ/ELIoT
- **Logging**: Usar `createServiceLogger('GPS')` en lugar de console.log
- **Métricas**: `logMetrics('recharge_completed', { service: 'GPS', amount: 10 })`
- **Mocks**: Reutilizar mocks existentes para nuevos tests
- **Performance**: Tests incluyen benchmarks básicos (30s timeout)

### Monitoring

The system includes built-in instrumentation (`lib/instrument.js`) and a separate monitoring service (`monitor.js`) for system health tracking.

## Key Design Patterns

- **Distributed Locking**: Each processor uses Redis-based locks to prevent concurrent execution
- **Queue-Based Persistence**: Operations are queued and persisted to disk for reliability
- **Service Orchestration**: Main orchestrator coordinates all processors with shared dependencies
- **Error Recovery**: Built-in retry mechanisms and crash recovery for resilience