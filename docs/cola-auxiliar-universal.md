# Cola Auxiliar Universal

## Descripción
La cola auxiliar es un sistema de persistencia que almacena transacciones exitosas de webservices para posterior recuperación en caso de fallos del sistema. Es universal y soporta **GPS**, **VOZ** y **ELIOT**.

## Estructura de Datos

### Campos Requeridos
```json
{
  "id": "aux_1736716800000_0.123",           // ID único de la transacción
  "sim": "6681997068",                       // SIM del dispositivo
  "vehiculo": "UNIDAD-001",                  // Identificador del vehículo/agente
  "empresa": "EMPRESA EJEMPLO",              // Nombre de la empresa
  "transID": "250900833181",                 // ID de transacción del proveedor
  "proveedor": "TAECEL",                     // Proveedor usado (TAECEL/MST)
  "provider": "TAECEL",                      // Campo adicional del proveedor
  
  // CAMPOS UNIVERSALES REQUERIDOS
  "tipo": "gps_recharge",                    // Tipo de recarga
  "tipoServicio": "GPS",                     // Servicio (GPS/VOZ/ELIOT)
  "monto": 10,                               // Monto de la recarga
  "diasVigencia": 8,                         // Días de vigencia a agregar
  
  // Respuesta del webservice
  "webserviceResponse": {
    "transId": "250900833181",
    "monto": 10,
    "folio": "250900833181",
    "saldoFinal": "N/A",
    "carrier": "TELCEL",
    "fecha": "2025-09-12"
  },
  
  // Control interno
  "status": "webservice_success_pending_db",  // Estado
  "timestamp": 1736716800000,                // Timestamp de creación
  "addedAt": 1736716800000                   // Timestamp de agregado a cola
}
```

## Tipos de Servicio

### 1. GPS (Sistema de Rastreo)
- **tipo**: `"gps_recharge"`
- **tipoServicio**: `"GPS"`
- **diasVigencia**: `8` días
- **Base de Datos**: `gps_db`
- **Tabla**: `dispositivos`
- **Campo**: `unix_saldo` (formato Unix timestamp)
- **Monto típico**: $10 pesos

### 2. VOZ (Telefonía)
- **tipo**: `"voz_recharge"`
- **tipoServicio**: `"VOZ"`
- **diasVigencia**: `30` días (típico)
- **Base de Datos**: `gps_db` 
- **Tabla**: `prepagos_automaticos`
- **Campo**: `fecha_expira_saldo` (formato YYYY-MM-DD HH:mm:ss)
- **Monto típico**: Variable

### 3. ELIOT (IoT)
- **tipo**: `"iot_recharge"`
- **tipoServicio**: `"ELIOT"`
- **diasVigencia**: `15` días (típico)
- **Base de Datos**: `eliot_db`
- **Tabla**: `agentes`
- **Campo**: `fecha_saldo` (formato YYYY-MM-DD HH:mm:ss)
- **Monto típico**: Variable

## Flujo de Recuperación

### 1. Detección
El sistema detecta elementos en la cola auxiliar con `status: "webservice_success_pending_db"`

### 2. Procesamiento
- **Individual**: Si hay 1 elemento → Recuperación individual
- **Lote**: Si hay múltiples elementos → Recuperación en lote

### 3. Inserción en Base de Datos
- Crea registro maestro en tabla `recargas`
- Crea registros de detalle en tabla `detalle_recargas`
- Actualiza fecha de vigencia según el tipo de servicio

### 4. Actualización de Vigencia
```sql
-- GPS
UPDATE dispositivos SET unix_saldo = ? WHERE sim = ?

-- VOZ  
UPDATE prepagos_automaticos SET fecha_expira_saldo = ? WHERE sim = ?

-- ELIOT
UPDATE agentes SET fecha_saldo = ? WHERE sim = ?
```

### 5. Limpieza
Remueve elementos exitosos de la cola auxiliar

## Identificación de Recuperación
Los registros recuperados se identifican con la nota:
```
< RECUPERACIÓN > [ 043 / 043 ] Recarga Automática **** 000 Pendientes al Finalizar el Día **** [ 0 Reportando en Tiempo y Forma ] (43 procesados de 43 total)
```

## Estados de la Cola
- `"webservice_success_pending_db"` - Exitoso en webservice, pendiente en BD
- `"db_success_completed"` - Completamente procesado (se remueve de la cola)

## Configuración por Servicio
| Servicio | BD | Tabla | Campo | Formato | Días Default |
|----------|----|----|-------|---------|--------------|
| GPS | gps_db | dispositivos | unix_saldo | Unix timestamp | 8 |
| VOZ | gps_db | prepagos_automaticos | fecha_expira_saldo | YYYY-MM-DD HH:mm:ss | 30 |
| ELIOT | eliot_db | agentes | fecha_saldo | YYYY-MM-DD HH:mm:ss | 15 |

## Ejemplo de Uso

### Agregar a Cola Auxiliar
```javascript
const auxItem = {
  sim: "6681997068",
  tipo: "gps_recharge",
  tipoServicio: "GPS",
  monto: 10,
  diasVigencia: 8,
  transID: "250900833181",
  proveedor: "TAECEL",
  // ... otros campos
};

await persistenceQueue.addToAuxiliaryQueue(auxItem);
```

### Procesar Cola
```javascript
const recoveryMethods = require('./lib/processors/recovery_methods.js');
recoveryMethods.db = dbGps;
const result = await recoveryMethods.processAuxiliaryQueueRecharges();
```

## Tolerancia a Fallos
- **Crash Recovery**: Si el sistema falla durante el procesamiento, las transacciones quedan en la cola
- **Reintentos**: Las transacciones fallidas pueden reintentarse
- **Integridad**: Solo se remueven de la cola tras inserción exitosa en BD