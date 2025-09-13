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

### Monitoring

The system includes built-in instrumentation (`lib/instrument.js`) and a separate monitoring service (`monitor.js`) for system health tracking.

## Key Design Patterns

- **Distributed Locking**: Each processor uses Redis-based locks to prevent concurrent execution
- **Queue-Based Persistence**: Operations are queued and persisted to disk for reliability
- **Service Orchestration**: Main orchestrator coordinates all processors with shared dependencies
- **Error Recovery**: Built-in retry mechanisms and crash recovery for resilience