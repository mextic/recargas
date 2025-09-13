# Criterios de Filtrado GPS - Sistema de Recargas

## Criterio Principal: Separación Días vs Minutos

### Problema Resuelto
El sistema debe distinguir entre dispositivos antiguos sin reporte y dispositivos que necesitan recarga inmediata, evitando consumo innecesario de créditos de webservice.

### Implementación de Dos Niveles de Filtrado

#### 1. **Query Principal** (Filtro por DÍAS)
- **Propósito**: Limitar el universo de dispositivos a evaluar
- **Criterio**: Solo incluir dispositivos con ≤ 14 **días** sin reportar
- **Configuración**: Variable de entorno `GPS_DIAS_SIN_REPORTAR=14` (default: 14)
- **Implementación**: `HAVING dias_sin_reportar <= ${dias_limite}`
- **Beneficio**: Evita dispositivos muy antiguos sin reporte (posiblemente dados de baja)

#### 2. **Decisión de Recarga** (Filtro por MINUTOS)
- **Propósito**: Decidir si consumir webservice/crédito para recargar
- **Criterio**: Solo recargar si tiene ≥ 14 **minutos** sin reportar
- **Implementación**: Usa `dias_sin_reportar` como fracción (14/1440 = 0.009722...)
- **Configuración**: Fijo en 14 minutos (`MINUTOS_SIN_REPORTAR_PARA_RECARGA`)
- **Beneficio**: Solo consume créditos cuando realmente se necesita

### Flujo de Trabajo

```
1. Query SQL → Obtiene dispositivos con ≤ 14 días sin reportar
2. Filtrado → De esos, identifica los que tienen ≥ 14 minutos sin reportar  
3. Recarga → Solo consume webservice para los del paso 2
```

### Ejemplos de Comportamiento

| Tiempo sin reportar | Incluido en Query | Se Recarga | Razón |
|-------------------|------------------|------------|--------|
| 10 minutos | ✅ Sí | ❌ No | Reportando recientemente |
| 20 minutos | ✅ Sí | ✅ Sí | Necesita recarga |
| 5 días | ✅ Sí | ✅ Sí | Dentro del límite |
| 20 días | ❌ No | ❌ No | Fuera del límite de días |

### Configuración

```env
# .env
GPS_DIAS_SIN_REPORTAR=14  # Días máximos para incluir en query principal
```

### Logs del Sistema

```
🔍 Buscando dispositivos con <= 14 días sin reportar
📊 ESTADÍSTICAS DEL SISTEMA:
   • Total registros: 236
   • Para recargar (sin reportar 14+ min): 88
   • Pendientes al finalizar día: 88  
   • Reportando en tiempo y forma: 147
```

### Lógica del Negocio

- **Eficiencia**: Solo evalúa dispositivos activos recientes
- **Optimización**: Solo consume créditos cuando es necesario
- **Flexibilidad**: El límite de días es configurable por ambiente
- **Precisión**: Distingue entre "sin conexión antigua" vs "necesita recarga ahora"

---

*Documentado: 2025-09-11*  
*Criterio crítico para el funcionamiento eficiente del sistema GPS*