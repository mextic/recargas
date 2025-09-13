# Sistema de Recargas Optimizado v2.0

Sistema automatizado de recargas para servicios GPS, VOZ e IoT con arquitectura de colas distribuidas por tipo de servicio y recuperación ante fallos.

## 🚀 Características

- **Multi-Servicio**: Soporte para GPS, VOZ (Voz) e IoT con procesadores especializados
- **Colas Separadas por Servicio**: Sistema de persistencia con colas independientes (GPS, VOZ, ELIOT)
- **Recovery Estricto**: No consume webservices si hay registros pendientes sin procesar
- **Distributed Locking**: Prevención de ejecuciones concurrentes con Redis
- **Scheduling Inteligente**: Intervalos optimizados por tipo de servicio
- **Crash Recovery**: Recuperación automática ante fallos del sistema

## 📋 Requisitos

- Node.js 14+
- MySQL/MariaDB (GPS_DB, ELIOT_DB)
- Redis (para locks distribuidos)
- Acceso a APIs: TAECEL y MST

## 🛠 Instalación

```bash
npm install
cp .env.example .env
# Configurar variables en .env
npm start
```

## ⚙️ Configuración

### Variables de Entorno Requeridas

```bash
# Bases de Datos
GPS_DB_PASSWORD=tu_password_gps
ELIOT_DB_PASSWORD=tu_password_eliot

# Proveedores de Recarga
TAECEL_KEY=tu_taecel_key
TAECEL_NIP=tu_taecel_nip
MST_USER=tu_mst_user
MST_PASSWORD=tu_mst_password
```

### Variables Opcionales

```bash
GPS_MINUTOS_SIN_REPORTAR=10     # Umbral para recargas GPS (default: 10)
LOCK_EXPIRATION_MINUTES=60      # Expiración de locks (default: 60)
NODE_ENV=development            # Entorno de ejecución
TEST_VOZ=true                   # Testing inmediato de VOZ
```

## 🔧 Comandos Disponibles

```bash
npm start          # Inicia el sistema completo
npm test           # Ejecuta tests de integración
npm run setup      # Configuración inicial
npm run monitor    # Sistema de monitoreo
```

## 🏗 Arquitectura

### Componentes Principales

#### 1. RechargeOrchestrator (`index.js`)
Coordinador principal que:
- Inicializa todos los procesadores
- Gestiona scheduling automático
- Maneja recovery ante crashes
- Coordina locks distribuidos

#### 2. Procesadores Especializados

**GPSRechargeProcessor**
- Recargas fijas: $10, 8 días
- Intervalo: Cada 10 minutos (configurable con GPS_MINUTOS_SIN_REPORTAR)
- Filtrado inteligente por tiempo sin reportar

**VozRechargeProcessor** 
- Paquetes variables según código
- Frecuencia: 2 veces al día (1:00 AM, 4:00 AM)
- Soporte TAECEL y MST con reintentos

**IoTRechargeProcessor**
- Recargas para dispositivos IoT
- Intervalo: Cada 30 minutos

#### 3. Sistema de Persistencia por Servicio

```
data/
├── gps_auxiliary_queue.json    # Cola de recovery GPS
├── voz_auxiliary_queue.json    # Cola de recovery VOZ
└── eliot_auxiliary_queue.json  # Cola de recovery ELIOT
```

**Cada servicio maneja su propia cola auxiliar independiente:**
- GPS: Registros de recargas GPS fallidas
- VOZ: Registros de recargas VOZ fallidas  
- ELIOT: Registros de recargas ELIOT fallidas

#### 4. Concurrencia y Locks

**OptimizedLockManager**
- Locks distribuidos con Redis
- Prevención de ejecuciones concurrentes
- Auto-liberación por timeout

**PersistenceQueueSystem**
- Colas separadas por servicio (serviceType: 'gps', 'voz', 'eliot')
- Auto-recovery en caso de crash
- Reintentos configurables

## 🔄 Flujo de Operación

### 1. Proceso Normal por Servicio
```
1. Adquirir lock distribuido (por servicio)
2. Procesar cola auxiliar específica del servicio (si existe)
3. Si recovery falla → DETENER (no webservices para ese servicio)
4. Si recovery exitoso → Continuar con nuevos registros
5. Consultar saldo de proveedores
6. Ejecutar recargas via webservice
7. Guardar en cola auxiliar del servicio
8. Insertar en base de datos correspondiente
9. Actualizar fechas de expiración
10. Limpiar registros exitosos de la cola del servicio
11. Liberar lock
```

### 2. Recovery ante Fallos por Servicio
```
1. Sistema detecta registros pendientes por servicio al inicio
2. Intenta procesar cola auxiliar específica (GPS/VOZ/ELIOT)
3. Si TODOS exitosos → Continúa operación normal para ese servicio
4. Si ALGUNO falla → NO consume webservices nuevos para ese servicio
5. Mantiene registros fallidos en cola específica para siguiente intento
```

## 📊 Scheduling

| Servicio | Frecuencia | Horarios | Variable Control |
|----------|------------|----------|------------------|
| GPS | Cada 10 min | Continuo | GPS_MINUTOS_SIN_REPORTAR |
| VOZ | 2 veces/día | 1:00 AM, 4:00 AM | - |
| IoT | Cada 30 min | :00, :30 | - |

## 🛡 Política de Recovery por Servicio

### Enfoque Estricto por Cola
- **ALL or NOTHING por Servicio**: Todos los registros en cola específica deben procesarse exitosamente
- **Blocking por Servicio**: Si hay fallas en recovery de un servicio, no se procesan registros nuevos de ESE servicio
- **Isolation**: Los fallos de un servicio no afectan a otros servicios
- **Integrity**: Garantiza consistencia entre webservice y base de datos por servicio

### Estados de Cola por Servicio
```javascript
"webservice_success_pending_db"           // Webservice OK, pendiente BD
"db_insertion_failed_pending_recovery"    // Fallo BD, pendiente recovery
```

### Arquitectura de Colas Separadas
```javascript
// GPS usa su propia cola
this.gpsQueue = new PersistenceQueueSystem({
    serviceType: 'gps'
});

// VOZ usa su propia cola
this.vozQueue = new PersistenceQueueSystem({
    serviceType: 'voz'
});

// ELIOT usa su propia cola
this.eliotQueue = new PersistenceQueueSystem({
    serviceType: 'eliot'
});
```

## 📁 Estructura del Proyecto

```
recargas-optimizado/
├── index.js                    # Orchestrator principal
├── lib/
│   ├── processors/             # Procesadores por servicio
│   │   ├── GPSRechargeProcessor.js
│   │   ├── VozRechargeProcessor.js
│   │   ├── IoTRechargeProcessor.js
│   │   └── recovery_methods.js
│   ├── concurrency/            # Sistema de concurrencia
│   │   ├── OptimizedLockManager.js
│   │   └── PersistenceQueueSystem.js
│   ├── database/               # Gestión de BD
│   │   └── index.js
│   └── instrument.js           # Instrumentación
├── config/
│   └── database.js             # Configuración BD
├── data/                       # Colas de persistencia separadas
├── docs/                       # Documentación técnica
└── tests/                      # Tests de integración
```

## 🔍 Monitoreo

### Logs del Sistema
```bash
🚀 Iniciando Sistema de Recargas Optimizado v2.0
📊 Conectando bases de datos...
💾 Inicializando sistema de persistencia...
🔒 Inicializando gestor de locks...
⚙️ Inicializando procesadores...
🔍 Verificando estado anterior...
⚠️ Detectadas X recargas pendientes (GPS: X, VOZ: X, ELIOT: X)
```

### Métricas Automáticas por Servicio
- Registros procesados por servicio
- Tasa de éxito/fallo por cola
- Tiempos de ejecución por procesador
- Estado de colas auxiliares separadas
- Balance de proveedores

## 🚨 Troubleshooting

### Problemas Comunes

**1. Recovery no procesa registros de un servicio**
```bash
# Verificar colas auxiliares específicas
ls -la data/gps_auxiliary_queue.json
ls -la data/voz_auxiliary_queue.json
ls -la data/eliot_auxiliary_queue.json
# Verificar estructura de datos en archivos JSON
```

**2. Lock no se puede adquirir para un servicio**
```bash
# Verificar Redis
redis-cli ping
# Revisar locks activos por servicio
```

**3. Un servicio bloquea a otros**
```bash
# NO DEBE SUCEDER: Cada servicio es independiente
# Verificar que cada servicio use su propia cola
```

## 📋 Variables de Sistema GPS

| Variable | Descripción | Default |
|----------|-------------|---------|
| `GPS_MINUTOS_SIN_REPORTAR` | Umbral y frecuencia | 10 |
| `GPS_DIAS_SIN_REPORTAR` | Límite para query | 14 |
| `IMPORTE` | Monto fijo GPS | $10 |
| `DIAS` | Vigencia GPS | 8 días |
| `CODIGO` | Producto GPS | TEL010 |

## 🎯 Testing

### Testing VOZ Inmediato
```bash
NODE_ENV=development npm start
# o
TEST_VOZ=true npm start
```

### Testing con Breakpoints
Configurar breakpoints en:
- `VozRechargeProcessor.js:51` - Inicio recovery VOZ
- `GPSRechargeProcessor.js:49` - Inicio recovery GPS

## 📈 Roadmap

- [ ] Procesador ELIOT completo
- [ ] Dashboard web de monitoreo por servicio
- [ ] APIs REST para control manual por servicio
- [ ] Métricas avanzadas con MongoDB
- [ ] Alertas automáticas por Telegram/Email

## 🤝 Contribución

1. Fork del proyecto
2. Crear feature branch
3. Commit con formato estándar
4. Push a la rama
5. Abrir Pull Request

## 📄 Licencia

Privado - Mextic (git@github.com:mextic/recargas.git)

---

**Generado con ❤️ por el equipo de Mextic**