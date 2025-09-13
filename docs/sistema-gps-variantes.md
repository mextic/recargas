# Sistema GPS - Tipos de Servicio y Variantes

## Descripción General
El sistema GPS maneja recargas automáticas para dispositivos de rastreo con diferentes configuraciones y proveedores. Es el servicio base que sirve como referencia para otros tipos de servicio (VOZ, ELIOT).

## Arquitectura GPS

### 📊 Base de Datos
- **BD Principal**: `gps_db`
- **Tabla objetivo**: `dispositivos`
- **Campo vigencia**: `unix_saldo` (formato Unix timestamp)
- **Criterio filtro**: `prepago = 1`

### 🔄 Frecuencia de Verificación
- **Intervalo**: Configurable vía `GPS_MINUTOS_SIN_REPORTAR` (default: 10 minutos)
- **Lógica**: Verifica cada X minutos si hay dispositivos que:
  - Lleven más de X minutos sin reportar
  - Tengan el saldo vencido
  - Estén marcados como prepago

### 💰 Configuración de Recargas
- **Monto fijo**: $10 pesos
- **Días vigencia**: 8 días
- **Código TAECEL**: Configurado en `config.CODIGO`
- **Timezone**: America/Mazatlan

## Proveedores GPS

### 🔵 TAECEL (Proveedor Principal)
**API Endpoints:**
- `getBalance`: Consultar saldo disponible
- `RequestTXN`: Solicitar transacción de recarga
- `StatusTXN`: Verificar estatus de transacción

**Flujo TAECEL:**
```
1. getBalance() → Verificar saldo disponible
2. RequestTXN(sim, codigo) → Obtener transID
3. StatusTXN(transID) → Confirmar recarga exitosa
```

**Configuración (.env):**
```bash
TAECEL_URL=https://taecel.com/app/api
TAECEL_KEY=tu_key_aqui
TAECEL_NIP=tu_nip_aqui
```

### 🟡 MST (Proveedor Fallback)
**Protocolo**: SOAP
**Endpoint**: `https://www.ventatelcel.com/ws/index.php?wsdl`

**Flujo MST:**
```
1. ObtenSaldo → Consultar saldo
2. Recarga → Ejecutar recarga directa
```

**Configuración (.env):**
```bash
MST_URL=https://www.ventatelcel.com/ws/index.php?wsdl
MST_USER=tu_usuario
MST_PASSWORD=tu_password
```

## Lógica de Selección de Proveedor

### 🏆 Criterios de Prioridad
1. **Balance disponible**: Proveedor con mayor saldo
2. **Saldo mínimo**: >$100 para ser considerado válido
3. **Reintentos**: 3 intentos por proveedor
4. **Fallback**: Si TAECEL falla → MST (y viceversa)

### 🔄 Algoritmo de Reintentos
```javascript
for (intento 1-3) {
    for (proveedor in [TAECEL, MST]) {
        if (saldo > 100) {
            intentar_recarga()
            if (exitoso) return success
        }
    }
    esperar(2_segundos)
}
```

## Flujo de Procesamiento GPS

### 1. 🔍 Query de Dispositivos
```sql
SELECT * FROM dispositivos 
WHERE prepago = 1 
  AND unix_saldo <= {ahora + margen}
  AND ultimo_registro < {ahora - GPS_MINUTOS_SIN_REPORTAR}
```

### 2. 💳 Proceso de Recarga
```
Para cada dispositivo:
  1. Consultar saldos (TAECEL, MST)
  2. Seleccionar proveedor (mayor saldo)
  3. Ejecutar recarga con reintentos
  4. Si exitoso → Cola auxiliar
  5. Si falla → Intentar otro proveedor
```

### 3. 📋 Cola Auxiliar Universal
```json
{
  "tipo": "gps_recharge",
  "tipoServicio": "GPS", 
  "monto": 10,
  "diasVigencia": 8,
  "sim": "6681234567",
  "vehiculo": "UNIDAD-001",
  "empresa": "EMPRESA EJEMPLO",
  "transID": "TAECEL_12345",
  "proveedor": "TAECEL",
  "webserviceResponse": {
    "transId": "12345",
    "monto": 10,
    "folio": "F12345",
    "saldoFinal": "$115,245.00",
    "carrier": "TELCEL",
    "fecha": "2025-09-12"
  },
  "status": "webservice_success_pending_db"
}
```

### 4. 🗄️ Recuperación Automática
```
1. recovery_methods.js procesa cola auxiliar
2. Inserta en tabla `recargas` (maestro)
3. Inserta en tabla `detalle_recargas` (detalle)
4. Actualiza `dispositivos.unix_saldo` (+8 días)
5. Limpia elementos exitosos de cola auxiliar
```

## Variables de Configuración

### 🔧 Variables GPS Específicas
```bash
# Intervalos de verificación
GPS_MINUTOS_SIN_REPORTAR=10    # Cada cuántos minutos verificar
GPS_DIAS_SIN_REPORTAR=14       # Criterio para considerarlo inactivo

# Testing
GPS_TEST_COMPANY=              # Filtro por empresa (testing)
```

### 🔧 Variables de Proveedores
```bash
# TAECEL
TAECEL_URL=https://taecel.com/app/api
TAECEL_KEY=clave_api
TAECEL_NIP=nip_seguridad

# MST  
MST_URL=https://www.ventatelcel.com/ws/index.php?wsdl
MST_USER=usuario_soap
MST_PASSWORD=password_soap
```

### 🔧 Variables de Sistema
```bash
# Locks distribuidos
LOCK_EXPIRATION_MINUTES=60
LOCK_PROVIDER=redis

# Timezone
TIMEZONE=America/Mazatlan
```

## Archivos Clave GPS

### 📁 Estructura de Archivos
```
lib/processors/
├── GPSRechargeProcessor.js     # Procesador principal GPS
├── recovery_methods.js         # Sistema de recuperación universal
└── ...

config/
├── database.js                 # Configuración TAECEL/MST/DB
└── ...

data/
├── auxiliary_queue.json        # Cola auxiliar universal
└── ...
```

### 🎯 Puntos de Integración
- **GPSRechargeProcessor.js**: Lógica específica GPS
- **recovery_methods.js**: Sistema universal (GPS/VOZ/ELIOT)
- **index.js**: Orquestador y scheduler
- **auxiliary_queue.json**: Persistencia universal

## Casos de Uso GPS

### 🚛 Tipos de Dispositivos
- **Vehículos comerciales**: Camiones, flotillas
- **Maquinaria**: Tractores, equipo pesado  
- **Vehículos personales**: Autos, motos
- **Equipos especiales**: MDVR, dashcams

### 📈 Escenarios Típicos
1. **Vencimiento próximo**: Dispositivo con saldo por vencer en <24h
2. **Sin reportar**: Dispositivo inactivo >10 minutos con saldo vencido
3. **Recuperación**: Recargas exitosas en webservice pendientes en BD
4. **Fallback**: TAECEL sin saldo → MST automático

## Métricas y Logging

### 📊 Estadísticas GPS
```javascript
{
  processed: 43,     // Dispositivos procesados
  success: 41,       // Recargas exitosas
  failed: 2,         // Recargas fallidas
  provider: "TAECEL" // Proveedor usado
}
```

### 📝 Logging Detallado
```
🔄 GPS verificará cada 10 minutos
📋 43 dispositivos GPS para procesar
🔵 TAECEL: RequestTXN para SIM 6681234567
🔵 TAECEL: StatusTXN para TransID 12345
✅ GPS 6681234567 recargado (+8 días, $10, TAECEL)
🧹 Cola auxiliar limpiada: 43 recargas removidas
```

## Consideraciones Técnicas

### 🛡️ Seguridad
- **Credenciales**: Nunca en código, siempre en .env
- **Timeouts**: 30 segundos máximo por API call
- **Locks distribuidos**: Evita procesamiento concurrente
- **Validation**: Verificar respuestas de webservices

### ⚡ Performance
- **Batch processing**: Hasta 300 dispositivos por ejecución
- **Chunk inserts**: Bloques de 50 registros en BD
- **Connection pooling**: Conexiones reutilizadas
- **Queue cleanup**: Solo exitosos removidos

### 🔄 Tolerancia a Fallos
- **Reintentos**: 3 intentos automáticos
- **Provider fallback**: TAECEL ↔ MST
- **Queue persistence**: Estado guardado en disco
- **Crash recovery**: Reinicio automático desde cola

## Extensibilidad

### 🎨 Patrón Base para Otros Servicios
El sistema GPS sirve como **template** para implementar:

1. **VOZ**: Misma estructura, diferentes endpoints/códigos
2. **ELIOT**: Misma estructura, diferente BD (eliot_db)
3. **Otros**: Reutilizar recovery_methods.js universal

### 🔗 Integración Universal
- **Cola auxiliar**: Formato estándar para todos los servicios
- **Recovery methods**: Sistema compartido GPS/VOZ/ELIOT
- **Configuración**: Variables .env centralizadas
- **Logging**: Formato consistente entre servicios

---

📝 **Nota**: Este documento sirve como referencia para entender el sistema GPS y reutilizar su arquitectura en otros servicios (VOZ, ELIOT).