/**
 * SlackChannel - FASE 5: Canal de Slack Configurable
 * Envío de alertas a Slack con formato rico y configuración por variables de entorno
 */
const axios = require('axios');

class SlackChannel {
    constructor(config) {
        this.config = config;
        this.name = 'Slack';
        
        if (!config.webhook) {
            throw new Error('Slack webhook URL es requerida');
        }
        
        console.log(`📱 Slack Channel inicializado: ${config.channel}`);
        console.log(`👥 Destinatarios configurados por prioridad:`, config.recipients);
    }

    async send(alert) {
        try {
            const payload = this.buildSlackPayload(alert);
            
            const response = await axios.post(this.config.webhook, payload, {
                timeout: 10000,
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (response.status === 200) {
                return {
                    success: true,
                    messageId: response.headers['x-slack-req-id'] || 'unknown',
                    timestamp: Date.now()
                };
            } else {
                throw new Error(`Slack API error: ${response.status} - ${response.statusText}`);
            }
        } catch (error) {
            if (error.response) {
                throw new Error(`Slack webhook error: ${error.response.status} - ${error.response.data || error.response.statusText}`);
            } else if (error.request) {
                throw new Error('Slack webhook timeout - no response received');
            } else {
                throw new Error(`Slack error: ${error.message}`);
            }
        }
    }

    buildSlackPayload(alert) {
        const color = this.getPriorityColor(alert.priority);
        const icon = this.getPriorityIcon(alert.priority);
        const recipients = this.getRecipientsForPriority(alert.priority);
        
        // Construir mensaje con mentions si hay destinatarios
        let messageText = alert.message;
        if (recipients.length > 0) {
            const mentions = recipients.join(' ');
            messageText = `${mentions}\n${alert.message}`;
        }

        const payload = {
            channel: this.config.channel,
            username: this.config.username,
            icon_emoji: this.config.icon,
            text: `${icon} *${alert.title}*`,
            attachments: [
                {
                    color: color,
                    fallback: `${alert.priority}: ${alert.title} - ${alert.message}`,
                    fields: [
                        {
                            title: 'Servicio',
                            value: alert.service,
                            short: true
                        },
                        {
                            title: 'Prioridad',
                            value: `${this.getPriorityIcon(alert.priority)} ${alert.priority}`,
                            short: true
                        },
                        {
                            title: 'Categoría',
                            value: alert.category,
                            short: true
                        },
                        {
                            title: 'Timestamp',
                            value: alert.timestampFormatted,
                            short: true
                        },
                        {
                            title: 'Mensaje',
                            value: messageText,
                            short: false
                        }
                    ],
                    footer: `Sistema Recargas - ${alert.environment.toUpperCase()}`,
                    footer_icon: 'https://platform.slack-edge.com/img/default_application_icon.png',
                    ts: Math.floor(alert.timestamp / 1000)
                }
            ]
        };

        // Agregar metadata si existe
        if (alert.metadata && Object.keys(alert.metadata).length > 0) {
            payload.attachments[0].fields.push({
                title: 'Detalles Adicionales',
                value: this.formatMetadata(alert.metadata),
                short: false
            });
        }

        // Agregar botones de acción para alertas críticas
        if (alert.priority === 'CRITICAL') {
            payload.attachments[0].actions = [
                {
                    type: 'button',
                    text: '✅ Acknowledge',
                    name: 'acknowledge',
                    value: alert.id,
                    style: 'primary'
                },
                {
                    type: 'button',
                    text: '🔧 Resolve',
                    name: 'resolve',
                    value: alert.id,
                    style: 'good'
                },
                {
                    type: 'button',
                    text: '📊 Dashboard',
                    url: process.env.DASHBOARD_URL || 'http://localhost:3000',
                    style: 'default'
                }
            ];
        }

        return payload;
    }

    getPriorityColor(priority) {
        const colors = {
            CRITICAL: '#ff0000',  // Rojo
            HIGH: '#ff8c00',      // Naranja
            MEDIUM: '#ffd700',    // Amarillo
            LOW: '#36a64f'        // Verde
        };
        return colors[priority] || '#cccccc';
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

    getRecipientsForPriority(priority) {
        return this.config.recipients[priority] || [];
    }

    formatMetadata(metadata) {
        let formatted = '';
        for (const [key, value] of Object.entries(metadata)) {
            if (value !== null && value !== undefined) {
                formatted += `• *${key}*: ${value}\n`;
            }
        }
        return formatted || 'No hay detalles adicionales';
    }

    async testConnection() {
        const testPayload = {
            channel: this.config.channel,
            username: this.config.username,
            icon_emoji: this.config.icon,
            text: '🧪 Test de conexión Slack',
            attachments: [
                {
                    color: '#36a64f',
                    fallback: 'Test de conexión exitoso',
                    fields: [
                        {
                            title: 'Estado',
                            value: '✅ Conexión funcionando correctamente',
                            short: false
                        },
                        {
                            title: 'Timestamp',
                            value: new Date().toISOString(),
                            short: true
                        }
                    ],
                    footer: 'Sistema Recargas - Test',
                    ts: Math.floor(Date.now() / 1000)
                }
            ]
        };

        try {
            const response = await axios.post(this.config.webhook, testPayload, {
                timeout: 10000
            });

            if (response.status === 200) {
                console.log('✅ Slack test connection successful');
                return { success: true, message: 'Test enviado correctamente' };
            } else {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
        } catch (error) {
            console.error('❌ Slack test connection failed:', error.message);
            throw error;
        }
    }

    getChannelInfo() {
        return {
            name: this.name,
            channel: this.config.channel,
            username: this.config.username,
            icon: this.config.icon,
            recipientsByPriority: this.config.recipients,
            webhook: this.config.webhook ? '***configured***' : 'not configured'
        };
    }
}

module.exports = SlackChannel;