/**
 * AlertManager - FASE 5: Sistema de Alertas Configurables
 * Orquestador central con configuración completa por variables de entorno
 */
const moment = require('moment-timezone');
const SlackChannel = require('./channels/SlackChannel');
const EmailChannel = require('./channels/EmailChannel');
const TelegramChannel = require('./channels/TelegramChannel');
const WebhookChannel = require('./channels/WebhookChannel');
const AlertTemplates = require('./templates/AlertTemplates');

class AlertManager {
    constructor() {
        this.channels = new Map();
        this.alertHistory = [];
        this.activeAlerts = new Map();
        this.config = this.loadConfiguration();
        this.initializeChannels();
        
        // Estadísticas de alertas
        this.stats = {
            totalSent: 0,
            totalFailed: 0,
            byPriority: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
            byChannel: {}
        };
        
        console.log('🚨 AlertManager inicializado');
        console.log(`📊 Canales activos: ${Array.from(this.channels.keys()).join(', ')}`);
    }

    /**
     * Carga configuración completa desde variables de entorno
     */
    loadConfiguration() {
        const config = {
            // ===== CONFIGURACIÓN DE CANALES =====
            channels: {
                slack: {
                    enabled: process.env.ALERT_SLACK_ENABLED === 'true',
                    webhook: process.env.ALERT_SLACK_WEBHOOK,
                    channel: process.env.ALERT_SLACK_CHANNEL || '#alerts',
                    username: process.env.ALERT_SLACK_USERNAME || 'Recargas Bot',
                    icon: process.env.ALERT_SLACK_ICON || ':warning:',
                    // Configurar destinatarios por tipo de alerta
                    recipients: {
                        CRITICAL: process.env.ALERT_SLACK_CRITICAL_USERS?.split(',') || ['@channel'],
                        HIGH: process.env.ALERT_SLACK_HIGH_USERS?.split(',') || ['@here'],
                        MEDIUM: process.env.ALERT_SLACK_MEDIUM_USERS?.split(',') || [],
                        LOW: process.env.ALERT_SLACK_LOW_USERS?.split(',') || []
                    }
                },
                
                email: {
                    enabled: process.env.ALERT_EMAIL_ENABLED === 'true',
                    smtp: {
                        host: process.env.ALERT_EMAIL_SMTP_HOST || 'smtp.gmail.com',
                        port: parseInt(process.env.ALERT_EMAIL_SMTP_PORT) || 587,
                        secure: process.env.ALERT_EMAIL_SMTP_SECURE === 'true',
                        auth: {
                            user: process.env.ALERT_EMAIL_USER,
                            pass: process.env.ALERT_EMAIL_PASS
                        }
                    },
                    from: process.env.ALERT_EMAIL_FROM || 'Sistema Recargas <noreply@company.com>',
                    // Destinatarios por prioridad
                    recipients: {
                        CRITICAL: process.env.ALERT_EMAIL_CRITICAL?.split(',') || [],
                        HIGH: process.env.ALERT_EMAIL_HIGH?.split(',') || [],
                        MEDIUM: process.env.ALERT_EMAIL_MEDIUM?.split(',') || [],
                        LOW: process.env.ALERT_EMAIL_LOW?.split(',') || []
                    }
                },
                
                telegram: {
                    enabled: process.env.ALERT_TELEGRAM_ENABLED === 'true',
                    botToken: process.env.ALERT_TELEGRAM_BOT_TOKEN,
                    // Múltiples chats por prioridad
                    chats: {
                        CRITICAL: process.env.ALERT_TELEGRAM_CRITICAL_CHATS?.split(',') || [],
                        HIGH: process.env.ALERT_TELEGRAM_HIGH_CHATS?.split(',') || [],
                        MEDIUM: process.env.ALERT_TELEGRAM_MEDIUM_CHATS?.split(',') || [],
                        LOW: process.env.ALERT_TELEGRAM_LOW_CHATS?.split(',') || []
                    }
                },
                
                webhook: {
                    enabled: process.env.ALERT_WEBHOOK_ENABLED === 'true',
                    // Múltiples webhooks con configuración por prioridad
                    endpoints: {
                        CRITICAL: process.env.ALERT_WEBHOOK_CRITICAL_URLS?.split(',') || [],
                        HIGH: process.env.ALERT_WEBHOOK_HIGH_URLS?.split(',') || [],
                        MEDIUM: process.env.ALERT_WEBHOOK_MEDIUM_URLS?.split(',') || [],
                        LOW: process.env.ALERT_WEBHOOK_LOW_URLS?.split(',') || []
                    },
                    headers: {
                        'Authorization': process.env.ALERT_WEBHOOK_AUTH_HEADER,
                        'X-API-Key': process.env.ALERT_WEBHOOK_API_KEY,
                        'Content-Type': 'application/json'
                    },
                    timeout: parseInt(process.env.ALERT_WEBHOOK_TIMEOUT) || 5000
                }
            },
            
            // ===== CONFIGURACIÓN GENERAL =====
            general: {
                timezone: process.env.TIMEZONE || 'America/Mazatlan',
                
                // Control de spam - throttling por tipo de alerta
                throttling: {
                    CRITICAL: parseInt(process.env.ALERT_THROTTLE_CRITICAL) || 60000,  // 1 min
                    HIGH: parseInt(process.env.ALERT_THROTTLE_HIGH) || 300000,        // 5 min
                    MEDIUM: parseInt(process.env.ALERT_THROTTLE_MEDIUM) || 900000,    // 15 min
                    LOW: parseInt(process.env.ALERT_THROTTLE_LOW) || 3600000          // 1 hora
                },
                
                // Escalación automática
                escalation: {
                    enabled: process.env.ALERT_ESCALATION_ENABLED === 'true',
                    timeouts: {
                        CRITICAL: parseInt(process.env.ALERT_ESCALATION_CRITICAL) || 300000, // 5 min
                        HIGH: parseInt(process.env.ALERT_ESCALATION_HIGH) || 900000,         // 15 min
                        MEDIUM: parseInt(process.env.ALERT_ESCALATION_MEDIUM) || 1800000     // 30 min
                    }
                },
                
                // Configuración de retry para canales fallidos
                retry: {
                    maxAttempts: parseInt(process.env.ALERT_RETRY_MAX) || 3,
                    delayMs: parseInt(process.env.ALERT_RETRY_DELAY) || 5000,
                    backoffMultiplier: parseFloat(process.env.ALERT_RETRY_BACKOFF) || 1.5
                }
            }
        };

        // Validar configuración
        this.validateConfiguration(config);
        return config;
    }

    validateConfiguration(config) {
        const enabledChannels = [];
        
        if (config.channels.slack.enabled) {
            if (!config.channels.slack.webhook) {
                console.warn('⚠️ Slack habilitado pero falta ALERT_SLACK_WEBHOOK');
            } else {
                enabledChannels.push('Slack');
            }
        }
        
        if (config.channels.email.enabled) {
            if (!config.channels.email.smtp.auth.user || !config.channels.email.smtp.auth.pass) {
                console.warn('⚠️ Email habilitado pero faltan credenciales SMTP');
            } else {
                enabledChannels.push('Email');
            }
        }
        
        if (config.channels.telegram.enabled) {
            if (!config.channels.telegram.botToken) {
                console.warn('⚠️ Telegram habilitado pero falta ALERT_TELEGRAM_BOT_TOKEN');
            } else {
                enabledChannels.push('Telegram');
            }
        }
        
        if (config.channels.webhook.enabled) {
            const hasEndpoints = Object.values(config.channels.webhook.endpoints).some(urls => urls.length > 0);
            if (!hasEndpoints) {
                console.warn('⚠️ Webhook habilitado pero no hay URLs configuradas');
            } else {
                enabledChannels.push('Webhook');
            }
        }

        if (enabledChannels.length === 0) {
            console.warn('🚨 ADVERTENCIA: No hay canales de alerta configurados!');
            console.log('💡 Configura variables de entorno para habilitar alertas:');
            console.log('   ALERT_SLACK_ENABLED=true + ALERT_SLACK_WEBHOOK=...');
            console.log('   ALERT_EMAIL_ENABLED=true + ALERT_EMAIL_USER=... + ALERT_EMAIL_PASS=...');
            console.log('   ALERT_TELEGRAM_ENABLED=true + ALERT_TELEGRAM_BOT_TOKEN=...');
        } else {
            console.log(`✅ Canales configurados correctamente: ${enabledChannels.join(', ')}`);
        }
    }

    initializeChannels() {
        // Inicializar canales según configuración
        if (this.config.channels.slack.enabled) {
            this.channels.set('slack', new SlackChannel(this.config.channels.slack));
            this.stats.byChannel.slack = { sent: 0, failed: 0 };
        }
        
        if (this.config.channels.email.enabled) {
            this.channels.set('email', new EmailChannel(this.config.channels.email));
            this.stats.byChannel.email = { sent: 0, failed: 0 };
        }
        
        if (this.config.channels.telegram.enabled) {
            this.channels.set('telegram', new TelegramChannel(this.config.channels.telegram));
            this.stats.byChannel.telegram = { sent: 0, failed: 0 };
        }
        
        if (this.config.channels.webhook.enabled) {
            this.channels.set('webhook', new WebhookChannel(this.config.channels.webhook));
            this.stats.byChannel.webhook = { sent: 0, failed: 0 };
        }
    }

    /**
     * Enviar alerta con configuración avanzada
     */
    async sendAlert(alertData) {
        const alert = this.enrichAlert(alertData);
        
        // Verificar throttling
        if (this.isThrottled(alert)) {
            console.log(`🔇 Alerta throttled: ${alert.title} (${alert.priority})`);
            return { success: false, reason: 'throttled' };
        }

        // Registrar alerta activa
        this.registerActiveAlert(alert);

        console.log(`🚨 Enviando alerta: ${alert.title} [${alert.priority}]`);

        const results = [];
        const channelPromises = [];

        // Enviar a todos los canales habilitados en paralelo
        for (const [channelName, channel] of this.channels) {
            const channelPromise = this.sendToChannel(channel, channelName, alert)
                .then(result => ({ channel: channelName, ...result }))
                .catch(error => ({ 
                    channel: channelName, 
                    success: false, 
                    error: error.message 
                }));
            
            channelPromises.push(channelPromise);
        }

        // Esperar todos los envíos
        const channelResults = await Promise.allSettled(channelPromises);
        
        channelResults.forEach(result => {
            if (result.status === 'fulfilled') {
                results.push(result.value);
                this.updateStats(result.value);
            } else {
                console.error(`❌ Error en canal:`, result.reason);
                results.push({ success: false, error: result.reason.message });
            }
        });

        // Guardar en historial
        this.alertHistory.unshift({
            ...alert,
            sentAt: Date.now(),
            results
        });

        // Mantener solo últimas 1000 alertas
        if (this.alertHistory.length > 1000) {
            this.alertHistory = this.alertHistory.slice(0, 1000);
        }

        const successCount = results.filter(r => r.success).length;
        const totalChannels = results.length;

        console.log(`📊 Alerta enviada a ${successCount}/${totalChannels} canales`);

        return {
            success: successCount > 0,
            alert,
            results,
            summary: `${successCount}/${totalChannels} canales exitosos`
        };
    }

    async sendToChannel(channel, channelName, alert) {
        try {
            const result = await channel.send(alert);
            console.log(`✅ ${channelName}: Enviado exitosamente`);
            return { success: true, channel: channelName, ...result };
        } catch (error) {
            console.error(`❌ ${channelName}: Error - ${error.message}`);
            
            // Intentar retry si está configurado
            if (this.config.general.retry.maxAttempts > 1) {
                return await this.retryChannelSend(channel, channelName, alert, 1);
            }
            
            return { success: false, channel: channelName, error: error.message };
        }
    }

    async retryChannelSend(channel, channelName, alert, attempt) {
        if (attempt >= this.config.general.retry.maxAttempts) {
            return { success: false, channel: channelName, error: 'Max retries exceeded' };
        }

        const delay = this.config.general.retry.delayMs * Math.pow(this.config.general.retry.backoffMultiplier, attempt - 1);
        
        console.log(`🔄 ${channelName}: Retry ${attempt}/${this.config.general.retry.maxAttempts} en ${delay}ms`);
        
        await new Promise(resolve => setTimeout(resolve, delay));

        try {
            const result = await channel.send(alert);
            console.log(`✅ ${channelName}: Exitoso en retry ${attempt}`);
            return { success: true, channel: channelName, ...result, retryAttempt: attempt };
        } catch (error) {
            console.error(`❌ ${channelName}: Retry ${attempt} falló - ${error.message}`);
            return await this.retryChannelSend(channel, channelName, alert, attempt + 1);
        }
    }

    enrichAlert(alertData) {
        return {
            id: `alert_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            timestamp: Date.now(),
            timestampFormatted: moment().tz(this.config.general.timezone).format('YYYY-MM-DD HH:mm:ss Z'),
            priority: alertData.priority || 'MEDIUM',
            title: alertData.title,
            message: alertData.message,
            service: alertData.service || 'SISTEMA',
            category: alertData.category || 'GENERAL',
            metadata: alertData.metadata || {},
            source: alertData.source || 'AlertManager',
            environment: process.env.NODE_ENV || 'production',
            ...alertData
        };
    }

    isThrottled(alert) {
        const throttleKey = `${alert.service}_${alert.category}_${alert.priority}`;
        const lastAlert = this.activeAlerts.get(throttleKey);
        
        if (!lastAlert) return false;
        
        const throttleTime = this.config.general.throttling[alert.priority];
        const timeSinceLastAlert = Date.now() - lastAlert.timestamp;
        
        return timeSinceLastAlert < throttleTime;
    }

    registerActiveAlert(alert) {
        const throttleKey = `${alert.service}_${alert.category}_${alert.priority}`;
        this.activeAlerts.set(throttleKey, alert);
        
        // Limpiar alertas antiguas
        const cutoff = Date.now() - Math.max(...Object.values(this.config.general.throttling));
        for (const [key, alertData] of this.activeAlerts) {
            if (alertData.timestamp < cutoff) {
                this.activeAlerts.delete(key);
            }
        }
    }

    updateStats(result) {
        if (result.success) {
            this.stats.totalSent++;
            this.stats.byChannel[result.channel].sent++;
        } else {
            this.stats.totalFailed++;
            this.stats.byChannel[result.channel].failed++;
        }
    }

    // ===== MÉTODOS DE UTILIDAD =====

    async testAllChannels() {
        const testAlert = {
            priority: 'LOW',
            title: 'Test de Alertas',
            message: 'Este es un mensaje de prueba para verificar que todos los canales funcionan correctamente.',
            service: 'TEST',
            category: 'SYSTEM_TEST'
        };

        console.log('🧪 Iniciando test de todos los canales...');
        const result = await this.sendAlert(testAlert);
        
        console.log('📊 Resultado del test:');
        result.results.forEach(r => {
            console.log(`   ${r.channel}: ${r.success ? '✅ OK' : '❌ FAIL'} ${r.error ? `(${r.error})` : ''}`);
        });

        return result;
    }

    getStats() {
        return {
            ...this.stats,
            activeAlerts: this.activeAlerts.size,
            historyCount: this.alertHistory.length,
            enabledChannels: Array.from(this.channels.keys()),
            configuration: {
                throttling: this.config.general.throttling,
                escalation: this.config.general.escalation.enabled
            }
        };
    }

    getActiveAlerts() {
        return Array.from(this.activeAlerts.values());
    }

    getAlertHistory(limit = 50) {
        return this.alertHistory.slice(0, limit);
    }

    // Método para uso desde línea de comandos o testing
    static async sendQuickAlert(priority, title, message, metadata = {}) {
        const manager = new AlertManager();
        return await manager.sendAlert({
            priority,
            title,
            message,
            metadata
        });
    }
}

module.exports = AlertManager;