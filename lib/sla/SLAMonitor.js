/**
 * SLAMonitor - FASE 5: Sistema de Monitoreo de SLA
 * Monitoreo automático de Service Level Agreements con alertas
 */
const fs = require('fs').promises;
const path = require('path');
const moment = require('moment-timezone');

class SLAMonitor {
    constructor(alertManager = null) {
        this.alertManager = alertManager;
        this.name = 'SLA_MONITOR';
        
        // Configuración de SLAs
        this.slaConfig = {
            uptime: {
                target: parseFloat(process.env.SLA_UPTIME_TARGET) || 99.9,     // 99.9% uptime
                measurement: 'monthly',
                alertThreshold: 99.5  // Alert when below 99.5%
            },
            responseTime: {
                target: parseInt(process.env.SLA_RESPONSE_TIME_TARGET) || 2000, // 2 seconds
                measurement: 'average',
                alertThreshold: 3000  // Alert when above 3 seconds
            },
            availability: {
                target: parseFloat(process.env.SLA_AVAILABILITY_TARGET) || 99.95, // 99.95%
                measurement: 'monthly',
                alertThreshold: 99.8  // Alert when below 99.8%
            },
            errorRate: {
                target: parseFloat(process.env.SLA_ERROR_RATE_TARGET) || 0.1,    // 0.1% error rate
                measurement: 'hourly',
                alertThreshold: 0.5   // Alert when above 0.5%
            }
        };
        
        // Estado del SLA
        this.slaState = {
            uptime: {
                current: 100,
                violations: [],
                lastCalculation: null
            },
            responseTime: {
                current: 0,
                samples: [],
                violations: [],
                lastCalculation: null
            },
            availability: {
                current: 100,
                downtime: [],
                violations: [],
                lastCalculation: null
            },
            errorRate: {
                current: 0,
                errors: [],
                violations: [],
                lastCalculation: null
            }
        };
        
        // Historial de métricas
        this.metricsHistory = [];
        this.violationHistory = [];
        
        // Archivos de persistencia
        this.dataDir = path.join(process.cwd(), 'data', 'sla');
        this.stateFile = path.join(this.dataDir, 'sla-state.json');
        this.historyFile = path.join(this.dataDir, 'sla-history.json');
        
        this.initializeDataDirectory();
        this.loadPersistedData();
        
        console.log('📊 SLA Monitor inicializado');
        console.log(`🎯 Targets: Uptime ${this.slaConfig.uptime.target}%, Response Time ${this.slaConfig.responseTime.target}ms`);
        console.log(`🎯 Availability ${this.slaConfig.availability.target}%, Error Rate ${this.slaConfig.errorRate.target}%`);
    }

    async initializeDataDirectory() {
        try {
            await fs.mkdir(this.dataDir, { recursive: true });
        } catch (error) {
            console.error('❌ Error creando directorio SLA data:', error.message);
        }
    }

    async loadPersistedData() {
        try {
            // Cargar estado persistido
            try {
                const stateData = await fs.readFile(this.stateFile, 'utf8');
                const persistedState = JSON.parse(stateData);
                this.slaState = { ...this.slaState, ...persistedState };
                console.log('✅ Estado SLA cargado desde archivo');
            } catch (error) {
                console.log('📝 No hay estado SLA persistido, iniciando limpio');
            }

            // Cargar historial
            try {
                const historyData = await fs.readFile(this.historyFile, 'utf8');
                const persistedHistory = JSON.parse(historyData);
                this.metricsHistory = persistedHistory.metrics || [];
                this.violationHistory = persistedHistory.violations || [];
                console.log(`✅ Historial SLA cargado: ${this.metricsHistory.length} métricas, ${this.violationHistory.length} violaciones`);
            } catch (error) {
                console.log('📝 No hay historial SLA, iniciando limpio');
            }

        } catch (error) {
            console.error('❌ Error cargando datos SLA persistidos:', error.message);
        }
    }

    async persistData() {
        try {
            // Persistir estado actual
            await fs.writeFile(this.stateFile, JSON.stringify(this.slaState, null, 2));
            
            // Persistir historial (mantener solo últimos 1000 registros)
            const historyData = {
                metrics: this.metricsHistory.slice(-1000),
                violations: this.violationHistory.slice(-1000),
                lastUpdate: Date.now()
            };
            await fs.writeFile(this.historyFile, JSON.stringify(historyData, null, 2));
            
        } catch (error) {
            console.error('❌ Error persistiendo datos SLA:', error.message);
        }
    }

    recordMetric(type, value, metadata = {}) {
        const timestamp = Date.now();
        const metric = {
            type,
            value,
            timestamp,
            metadata,
            timestampFormatted: moment(timestamp).tz('America/Mazatlan').format('YYYY-MM-DD HH:mm:ss')
        };

        // Agregar a historial
        this.metricsHistory.push(metric);

        // Procesar según tipo de métrica
        switch(type) {
            case 'uptime':
                this.processUptimeMetric(value, metadata);
                break;
            case 'responseTime':
                this.processResponseTimeMetric(value, metadata);
                break;
            case 'availability':
                this.processAvailabilityMetric(value, metadata);
                break;
            case 'error':
                this.processErrorMetric(value, metadata);
                break;
        }

        // Evaluar SLAs después de procesar
        this.evaluateSLAs();

        // Persistir datos cada 10 métricas
        if (this.metricsHistory.length % 10 === 0) {
            this.persistData();
        }
    }

    processUptimeMetric(isUp, metadata) {
        const timestamp = Date.now();
        
        if (!isUp) {
            // Registrar downtime
            this.slaState.availability.downtime.push({
                start: timestamp,
                service: metadata.service || 'unknown',
                reason: metadata.reason || 'unknown'
            });
        } else {
            // Cerrar último downtime si existe
            const lastDowntime = this.slaState.availability.downtime.slice(-1)[0];
            if (lastDowntime && !lastDowntime.end) {
                lastDowntime.end = timestamp;
                lastDowntime.duration = timestamp - lastDowntime.start;
            }
        }

        this.calculateCurrentUptime();
    }

    processResponseTimeMetric(responseTime, metadata) {
        this.slaState.responseTime.samples.push({
            value: responseTime,
            timestamp: Date.now(),
            service: metadata.service || 'unknown'
        });

        // Mantener solo últimas 1000 muestras
        if (this.slaState.responseTime.samples.length > 1000) {
            this.slaState.responseTime.samples = this.slaState.responseTime.samples.slice(-1000);
        }

        this.calculateCurrentResponseTime();
    }

    processAvailabilityMetric(isAvailable, metadata) {
        // Similar a uptime pero más específico por servicio
        this.processUptimeMetric(isAvailable, metadata);
        this.calculateCurrentAvailability();
    }

    processErrorMetric(isError, metadata) {
        if (isError) {
            this.slaState.errorRate.errors.push({
                timestamp: Date.now(),
                service: metadata.service || 'unknown',
                error: metadata.error || 'unknown',
                type: metadata.type || 'unknown'
            });
        }

        // Mantener solo errores de las últimas 24 horas
        const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
        this.slaState.errorRate.errors = this.slaState.errorRate.errors.filter(
            error => error.timestamp > oneDayAgo
        );

        this.calculateCurrentErrorRate();
    }

    calculateCurrentUptime() {
        const now = Date.now();
        const monthStart = moment().startOf('month').valueOf();
        
        // Calcular tiempo total del mes hasta ahora
        const totalTime = now - monthStart;
        
        // Calcular tiempo de downtime en el mes
        let downtimeTotal = 0;
        this.slaState.availability.downtime.forEach(downtime => {
            if (downtime.start >= monthStart) {
                const end = downtime.end || now;
                downtimeTotal += end - downtime.start;
            }
        });

        // Calcular uptime como porcentaje
        const uptime = ((totalTime - downtimeTotal) / totalTime) * 100;
        this.slaState.uptime.current = uptime;
        this.slaState.uptime.lastCalculation = now;
    }

    calculateCurrentResponseTime() {
        if (this.slaState.responseTime.samples.length === 0) {
            this.slaState.responseTime.current = 0;
            return;
        }

        // Calcular promedio de las últimas 100 muestras
        const recentSamples = this.slaState.responseTime.samples.slice(-100);
        const average = recentSamples.reduce((sum, sample) => sum + sample.value, 0) / recentSamples.length;
        
        this.slaState.responseTime.current = Math.round(average);
        this.slaState.responseTime.lastCalculation = Date.now();
    }

    calculateCurrentAvailability() {
        // Usar el mismo cálculo que uptime por ahora
        this.calculateCurrentUptime();
        this.slaState.availability.current = this.slaState.uptime.current;
        this.slaState.availability.lastCalculation = Date.now();
    }

    calculateCurrentErrorRate() {
        const oneHourAgo = Date.now() - (60 * 60 * 1000);
        
        // Contar errores en la última hora
        const recentErrors = this.slaState.errorRate.errors.filter(
            error => error.timestamp > oneHourAgo
        );

        // Estimar total de requests (esto debería venir de métricas reales)
        const estimatedRequests = this.metricsHistory.filter(
            m => m.timestamp > oneHourAgo && m.type === 'responseTime'
        ).length;

        // Calcular tasa de error
        const errorRate = estimatedRequests > 0 ? 
            (recentErrors.length / estimatedRequests) * 100 : 0;

        this.slaState.errorRate.current = errorRate;
        this.slaState.errorRate.lastCalculation = Date.now();
    }

    evaluateSLAs() {
        const timestamp = Date.now();
        
        // Evaluar cada SLA
        Object.entries(this.slaConfig).forEach(([metric, config]) => {
            const currentValue = this.slaState[metric].current;
            const isViolation = this.checkSLAViolation(metric, currentValue, config);
            
            if (isViolation) {
                this.recordSLAViolation(metric, currentValue, config, timestamp);
            }
        });
    }

    checkSLAViolation(metric, currentValue, config) {
        switch(metric) {
            case 'uptime':
            case 'availability':
                return currentValue < config.alertThreshold;
            case 'responseTime':
                return currentValue > config.alertThreshold;
            case 'errorRate':
                return currentValue > config.alertThreshold;
            default:
                return false;
        }
    }

    recordSLAViolation(metric, currentValue, config, timestamp) {
        // Verificar si ya hay una violación activa para evitar spam
        const recentViolations = this.violationHistory.filter(
            v => v.metric === metric && 
            v.timestamp > (timestamp - 15 * 60 * 1000) && // Últimos 15 minutos
            !v.resolved
        );

        if (recentViolations.length > 0) {
            console.log(`⚠️ SLA violation ya registrada para ${metric}, saltando duplicado`);
            return;
        }

        const violation = {
            id: `sla_${metric}_${timestamp}`,
            metric,
            currentValue,
            target: config.target,
            threshold: config.alertThreshold,
            timestamp,
            timestampFormatted: moment(timestamp).tz('America/Mazatlan').format('YYYY-MM-DD HH:mm:ss'),
            severity: this.calculateViolationSeverity(metric, currentValue, config),
            resolved: false
        };

        this.violationHistory.push(violation);
        this.slaState[metric].violations.push(violation);

        console.warn(`🚨 SLA Violation: ${metric} = ${currentValue} (threshold: ${config.alertThreshold})`);

        // Enviar alerta si hay AlertManager
        if (this.alertManager) {
            this.sendSLAAlert(violation);
        }
    }

    calculateViolationSeverity(metric, currentValue, config) {
        const threshold = config.alertThreshold;
        const target = config.target;
        
        let severity = 'MEDIUM';
        
        switch(metric) {
            case 'uptime':
            case 'availability':
                if (currentValue < target * 0.9) severity = 'CRITICAL';
                else if (currentValue < target * 0.95) severity = 'HIGH';
                break;
            case 'responseTime':
                if (currentValue > threshold * 2) severity = 'CRITICAL';
                else if (currentValue > threshold * 1.5) severity = 'HIGH';
                break;
            case 'errorRate':
                if (currentValue > threshold * 3) severity = 'CRITICAL';
                else if (currentValue > threshold * 2) severity = 'HIGH';
                break;
        }
        
        return severity;
    }

    async sendSLAAlert(violation) {
        try {
            const alert = {
                title: `SLA Violation: ${violation.metric.toUpperCase()}`,
                message: this.buildSLAAlertMessage(violation),
                priority: violation.severity,
                service: 'SLA_MONITOR',
                category: 'SLA_VIOLATION',
                metadata: {
                    metric: violation.metric,
                    currentValue: violation.currentValue,
                    target: violation.target,
                    threshold: violation.threshold,
                    violationId: violation.id
                }
            };

            await this.alertManager.sendAlert(alert);
            console.log(`📨 SLA alert enviada para violación de ${violation.metric}`);
            
        } catch (error) {
            console.error('❌ Error enviando SLA alert:', error.message);
        }
    }

    buildSLAAlertMessage(violation) {
        const metricNames = {
            uptime: 'Tiempo de Actividad',
            responseTime: 'Tiempo de Respuesta',
            availability: 'Disponibilidad',
            errorRate: 'Tasa de Error'
        };

        const metricUnits = {
            uptime: '%',
            responseTime: 'ms',
            availability: '%',
            errorRate: '%'
        };

        const metricName = metricNames[violation.metric] || violation.metric;
        const unit = metricUnits[violation.metric] || '';
        
        return `🚨 **Violación de SLA Detectada**

**Métrica:** ${metricName}
**Valor Actual:** ${violation.currentValue}${unit}
**Objetivo SLA:** ${violation.target}${unit}
**Umbral de Alerta:** ${violation.threshold}${unit}
**Severidad:** ${violation.severity}
**Timestamp:** ${violation.timestampFormatted}

Este incidente requiere atención inmediata para mantener los niveles de servicio acordados.`;
    }

    getSLAReport(period = 'current') {
        const report = {
            timestamp: Date.now(),
            timestampFormatted: moment().tz('America/Mazatlan').format('YYYY-MM-DD HH:mm:ss'),
            period,
            slaConfig: this.slaConfig,
            currentState: this.slaState,
            summary: {}
        };

        // Generar resumen
        Object.entries(this.slaConfig).forEach(([metric, config]) => {
            const currentValue = this.slaState[metric].current;
            const target = config.target;
            const violations = this.slaState[metric].violations.filter(v => !v.resolved);
            
            report.summary[metric] = {
                status: this.checkSLAViolation(metric, currentValue, config) ? 'VIOLATION' : 'COMPLIANT',
                currentValue,
                target,
                compliance: this.calculateCompliance(metric, currentValue, target),
                activeViolations: violations.length,
                lastViolation: violations.length > 0 ? violations[violations.length - 1] : null
            };
        });

        return report;
    }

    calculateCompliance(metric, currentValue, target) {
        switch(metric) {
            case 'uptime':
            case 'availability':
                return Math.min(100, (currentValue / target) * 100);
            case 'responseTime':
                return Math.max(0, 100 - ((currentValue - target) / target) * 100);
            case 'errorRate':
                return Math.max(0, 100 - (currentValue / target) * 100);
            default:
                return 0;
        }
    }

    getViolationHistory(limit = 50) {
        return this.violationHistory
            .slice(-limit)
            .sort((a, b) => b.timestamp - a.timestamp);
    }

    getMetricsHistory(type = null, limit = 100) {
        let metrics = this.metricsHistory;
        
        if (type) {
            metrics = metrics.filter(m => m.type === type);
        }
        
        return metrics
            .slice(-limit)
            .sort((a, b) => b.timestamp - a.timestamp);
    }

    resolveViolation(violationId, resolution = 'Manual resolution') {
        // Buscar y resolver violación
        const violation = this.violationHistory.find(v => v.id === violationId);
        
        if (violation && !violation.resolved) {
            violation.resolved = true;
            violation.resolvedAt = Date.now();
            violation.resolution = resolution;
            
            console.log(`✅ SLA violation resuelta: ${violationId}`);
            this.persistData();
            
            return true;
        }
        
        return false;
    }

    getStats() {
        const now = Date.now();
        const oneHour = 60 * 60 * 1000;
        const oneDay = 24 * oneHour;

        return {
            name: this.name,
            currentSLAs: Object.fromEntries(
                Object.entries(this.slaState).map(([key, value]) => [
                    key, 
                    {
                        current: value.current,
                        lastCalculation: value.lastCalculation,
                        violationCount: value.violations?.length || 0
                    }
                ])
            ),
            recentActivity: {
                metricsLast24h: this.metricsHistory.filter(m => m.timestamp > now - oneDay).length,
                violationsLast24h: this.violationHistory.filter(v => v.timestamp > now - oneDay).length,
                activeViolations: this.violationHistory.filter(v => !v.resolved).length
            },
            compliance: Object.fromEntries(
                Object.entries(this.slaConfig).map(([metric, config]) => [
                    metric,
                    this.calculateCompliance(metric, this.slaState[metric].current, config.target)
                ])
            )
        };
    }

    reset() {
        this.slaState = {
            uptime: { current: 100, violations: [], lastCalculation: null },
            responseTime: { current: 0, samples: [], violations: [], lastCalculation: null },
            availability: { current: 100, downtime: [], violations: [], lastCalculation: null },
            errorRate: { current: 0, errors: [], violations: [], lastCalculation: null }
        };
        this.metricsHistory = [];
        this.violationHistory = [];
        
        console.log('🔄 SLA Monitor reseteado');
        this.persistData();
    }
}

module.exports = SLAMonitor;