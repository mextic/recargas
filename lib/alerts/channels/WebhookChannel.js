/**
 * WebhookChannel - FASE 5: Canal de Webhook Configurable
 * Envío de alertas por webhooks HTTP con configuración flexible por variables de entorno
 */
const axios = require('axios');

class WebhookChannel {
    constructor(config) {
        this.config = config;
        this.name = 'Webhook';
        
        console.log(`🔗 Webhook Channel inicializado`);
        console.log(`🎯 Endpoints configurados por prioridad:`, this.getEndpointSummary());
    }

    async send(alert) {
        try {
            const endpoints = this.getEndpointsForPriority(alert.priority);
            
            if (endpoints.length === 0) {
                console.log(`🔗 No hay webhooks configurados para prioridad ${alert.priority}`);
                return {
                    success: true,
                    skipped: true,
                    reason: `No webhooks for priority ${alert.priority}`
                };
            }

            const payload = this.buildWebhookPayload(alert);
            
            const sendPromises = endpoints.map(endpoint => 
                this.sendToEndpoint(endpoint, payload, alert)
            );

            const results = await Promise.allSettled(sendPromises);
            
            const successCount = results.filter(r => r.status === 'fulfilled').length;
            const failedCount = results.length - successCount;

            if (failedCount > 0) {
                console.warn(`⚠️ Webhook: ${successCount}/${results.length} endpoints respondieron exitosamente`);
            } else {
                console.log(`✅ Webhook: Enviado a ${successCount} endpoint(s)`);
            }

            return {
                success: successCount > 0,
                sentTo: successCount,
                failed: failedCount,
                total: results.length,
                results: results.map((result, index) => ({
                    endpoint: this.maskUrl(endpoints[index]),
                    success: result.status === 'fulfilled',
                    response: result.status === 'fulfilled' ? result.value : null,
                    error: result.status === 'rejected' ? result.reason.message : null
                })),
                timestamp: Date.now()
            };

        } catch (error) {
            console.error('❌ Error general en Webhook:', error.message);
            throw new Error(`Webhook sending failed: ${error.message}`);
        }
    }

    async sendToEndpoint(endpoint, payload, alert) {
        try {
            const cleanHeaders = this.cleanHeaders();
            
            const response = await axios.post(endpoint, payload, {
                headers: cleanHeaders,
                timeout: this.config.timeout,
                validateStatus: (status) => status >= 200 && status < 300
            });

            return {
                endpoint: this.maskUrl(endpoint),
                status: response.status,
                statusText: response.statusText,
                responseTime: Date.now() - alert.timestamp,
                headers: response.headers['content-type'] || 'unknown',
                timestamp: Date.now()
            };

        } catch (error) {
            console.error(`❌ Error enviando a webhook ${this.maskUrl(endpoint)}:`, error.message);
            
            if (error.response) {
                throw new Error(`HTTP ${error.response.status}: ${error.response.statusText}`);
            } else if (error.request) {
                throw new Error('No response received (timeout or network error)');
            } else {
                throw error;
            }
        }
    }

    buildWebhookPayload(alert) {
        // Formato estándar de webhook compatible con múltiples sistemas
        return {
            // Campos principales
            id: alert.id,
            timestamp: alert.timestamp,
            timestampISO: new Date(alert.timestamp).toISOString(),
            timestampFormatted: alert.timestampFormatted,
            
            // Información de la alerta
            alert: {
                priority: alert.priority,
                title: alert.title,
                message: alert.message,
                service: alert.service,
                category: alert.category,
                source: alert.source
            },
            
            // Contexto del sistema
            system: {
                environment: alert.environment,
                hostname: process.env.HOSTNAME || 'unknown',
                version: process.env.npm_package_version || '1.0.0',
                timezone: process.env.TIMEZONE || 'America/Mazatlan'
            },
            
            // Metadata adicional
            metadata: alert.metadata || {},
            
            // Enlaces útiles
            links: {
                dashboard: process.env.DASHBOARD_URL,
                alertDetail: process.env.DASHBOARD_URL ? `${process.env.DASHBOARD_URL}/alerts/${alert.id}` : null,
                metrics: process.env.DASHBOARD_URL ? `${process.env.DASHBOARD_URL}/metrics/${alert.service}` : null
            },
            
            // Información de prioridad para routing
            routing: {
                priority: alert.priority,
                urgency: this.mapPriorityToUrgency(alert.priority),
                category: alert.category,
                service: alert.service
            },
            
            // Formato específico para integración con PagerDuty
            pagerduty: {
                incident_key: `${alert.service}_${alert.category}_${alert.priority}`,
                event_type: 'trigger',
                description: `${alert.title} - ${alert.service}`,
                details: {
                    message: alert.message,
                    timestamp: alert.timestampFormatted,
                    environment: alert.environment,
                    metadata: alert.metadata
                }
            },
            
            // Formato específico para integración con OpsGenie
            opsgenie: {
                alias: `${alert.service}_${alert.category}`,
                message: alert.title,
                description: alert.message,
                priority: this.mapPriorityToOpsGenie(alert.priority),
                source: 'Sistema Recargas',
                tags: [alert.service, alert.category, alert.environment, alert.priority],
                details: alert.metadata
            },
            
            // Formato específico para Microsoft Teams
            teams: {
                '@type': 'MessageCard',
                '@context': 'http://schema.org/extensions',
                themeColor: this.getPriorityColor(alert.priority),
                summary: alert.title,
                sections: [{
                    activityTitle: alert.title,
                    activitySubtitle: `${alert.service} - ${alert.priority}`,
                    activityImage: this.getPriorityIcon(alert.priority),
                    facts: [
                        { name: 'Servicio', value: alert.service },
                        { name: 'Categoría', value: alert.category },
                        { name: 'Prioridad', value: alert.priority },
                        { name: 'Timestamp', value: alert.timestampFormatted },
                        { name: 'Ambiente', value: alert.environment.toUpperCase() }
                    ],
                    markdown: true,
                    text: alert.message
                }],
                potentialAction: process.env.DASHBOARD_URL ? [{
                    '@type': 'OpenUri',
                    name: 'Ver Dashboard',
                    targets: [{
                        os: 'default',
                        uri: process.env.DASHBOARD_URL
                    }]
                }] : []
            }
        };
    }

    cleanHeaders() {
        const headers = { ...this.config.headers };
        
        // Remover headers vacíos o undefined
        Object.keys(headers).forEach(key => {
            if (!headers[key] || headers[key] === 'undefined') {
                delete headers[key];
            }
        });
        
        return headers;
    }

    mapPriorityToUrgency(priority) {
        const mapping = {
            CRITICAL: 'high',
            HIGH: 'high',
            MEDIUM: 'normal',
            LOW: 'low'
        };
        return mapping[priority] || 'normal';
    }

    mapPriorityToOpsGenie(priority) {
        const mapping = {
            CRITICAL: 'P1',
            HIGH: 'P2',
            MEDIUM: 'P3',
            LOW: 'P4'
        };
        return mapping[priority] || 'P3';
    }

    getPriorityColor(priority) {
        const colors = {
            CRITICAL: '#FF0000',  // Rojo
            HIGH: '#FF8C00',      // Naranja
            MEDIUM: '#FFD700',    // Amarillo
            LOW: '#32CD32'        // Verde
        };
        return colors[priority] || '#808080';
    }

    getPriorityIcon(priority) {
        const icons = {
            CRITICAL: '🚨',
            HIGH: '⚠️',
            MEDIUM: '⚡',
            LOW: 'ℹ️'
        };
        return icons[priority] || '📢';
    }

    getEndpointsForPriority(priority) {
        return this.config.endpoints[priority] || [];
    }

    getEndpointSummary() {
        const summary = {};
        Object.entries(this.config.endpoints).forEach(([priority, endpoints]) => {
            summary[priority] = {
                count: endpoints.length,
                endpoints: endpoints.map(url => this.maskUrl(url))
            };
        });
        return summary;
    }

    maskUrl(url) {
        if (!url) return 'undefined';
        
        try {
            const urlObj = new URL(url);
            return `${urlObj.protocol}//${urlObj.hostname}${urlObj.pathname}`;
        } catch (error) {
            // Si no es una URL válida, enmascarar manualmente
            return url.replace(/\/\/[^\/]+/, '//***masked***');
        }
    }

    async testConnection() {
        try {
            // Crear alerta de prueba
            const testAlert = {
                id: 'test_' + Date.now(),
                timestamp: Date.now(),
                timestampFormatted: new Date().toLocaleString('es-MX', { timeZone: 'America/Mazatlan' }),
                priority: 'LOW',
                title: 'Test de Webhook',
                message: 'Este es un mensaje de prueba para verificar que los webhooks funcionan correctamente.',
                service: 'TEST',
                category: 'WEBHOOK_TEST',
                environment: 'test',
                source: 'WebhookChannel',
                metadata: {
                    testType: 'Connection Test',
                    timestamp: new Date().toISOString(),
                    userAgent: 'Recargas-System/1.0'
                }
            };

            // Probar con endpoints de LOW priority
            const testEndpoints = this.getEndpointsForPriority('LOW');
            if (testEndpoints.length === 0) {
                throw new Error('No test endpoints configured for LOW priority');
            }

            const result = await this.send(testAlert);
            console.log('✅ Webhook test completed');
            return result;

        } catch (error) {
            console.error('❌ Webhook test failed:', error.message);
            throw error;
        }
    }

    // Método para validar todos los endpoints configurados
    async validateEndpoints() {
        const allEndpoints = new Set();
        
        // Recopilar todos los endpoints únicos
        Object.values(this.config.endpoints).forEach(endpoints => {
            endpoints.forEach(endpoint => allEndpoints.add(endpoint));
        });

        const validationResults = {};
        
        for (const endpoint of allEndpoints) {
            try {
                // Hacer una petición HEAD para verificar conectividad
                const response = await axios.head(endpoint, {
                    headers: this.cleanHeaders(),
                    timeout: this.config.timeout
                });

                validationResults[this.maskUrl(endpoint)] = {
                    url: this.maskUrl(endpoint),
                    valid: true,
                    status: response.status,
                    statusText: response.statusText,
                    responseTime: Date.now()
                };
            } catch (error) {
                validationResults[this.maskUrl(endpoint)] = {
                    url: this.maskUrl(endpoint),
                    valid: false,
                    error: error.response ? 
                        `HTTP ${error.response.status}: ${error.response.statusText}` : 
                        error.message
                };
            }
        }

        return validationResults;
    }

    getChannelInfo() {
        const totalEndpoints = Object.values(this.config.endpoints).reduce(
            (total, endpoints) => total + endpoints.length, 0
        );
        
        const uniqueEndpoints = new Set(Object.values(this.config.endpoints).flat()).size;

        return {
            name: this.name,
            endpointsByPriority: this.getEndpointSummary(),
            totalEndpoints,
            uniqueEndpoints,
            timeout: this.config.timeout,
            headers: Object.keys(this.cleanHeaders())
        };
    }
}

module.exports = WebhookChannel;