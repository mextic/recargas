/**
 * TelegramChannel - FASE 5: Canal de Telegram Configurable
 * Envío de alertas por Telegram con formato rico y configuración por variables de entorno
 */
const TelegramBot = require('node-telegram-bot-api');

class TelegramChannel {
    constructor(config) {
        this.config = config;
        this.name = 'Telegram';
        this.bot = null;
        
        if (!config.botToken) {
            throw new Error('Telegram bot token es requerido');
        }
        
        this.initializeBot();
        console.log(`📱 Telegram Channel inicializado`);
        console.log(`👥 Chats configurados por prioridad:`, config.chats);
    }

    initializeBot() {
        try {
            // Crear bot sin polling para evitar conflictos
            this.bot = new TelegramBot(this.config.botToken, { polling: false });
            console.log('✅ Telegram bot inicializado correctamente');
        } catch (error) {
            console.error('❌ Error inicializando Telegram bot:', error.message);
            throw error;
        }
    }

    async send(alert) {
        try {
            const chatIds = this.getChatsForPriority(alert.priority);
            
            if (chatIds.length === 0) {
                console.log(`📱 No hay chats configurados para prioridad ${alert.priority}`);
                return {
                    success: true,
                    skipped: true,
                    reason: `No chats for priority ${alert.priority}`
                };
            }

            const message = this.buildTelegramMessage(alert);
            const keyboard = this.buildInlineKeyboard(alert);
            
            const sendPromises = chatIds.map(chatId => 
                this.sendToChat(chatId, message, keyboard, alert)
            );

            const results = await Promise.allSettled(sendPromises);
            
            const successCount = results.filter(r => r.status === 'fulfilled').length;
            const failedCount = results.length - successCount;

            if (failedCount > 0) {
                console.warn(`⚠️ Telegram: ${successCount}/${results.length} mensajes enviados exitosamente`);
            } else {
                console.log(`✅ Telegram: Mensaje enviado a ${successCount} chat(s)`);
            }

            return {
                success: successCount > 0,
                sentTo: successCount,
                failed: failedCount,
                total: results.length,
                results: results.map((result, index) => ({
                    chatId: chatIds[index],
                    success: result.status === 'fulfilled',
                    messageId: result.status === 'fulfilled' ? result.value.messageId : null,
                    error: result.status === 'rejected' ? result.reason.message : null
                })),
                timestamp: Date.now()
            };

        } catch (error) {
            console.error('❌ Error general en Telegram:', error.message);
            throw new Error(`Telegram sending failed: ${error.message}`);
        }
    }

    async sendToChat(chatId, message, keyboard, alert) {
        try {
            const options = {
                parse_mode: 'Markdown',
                disable_web_page_preview: true
            };

            if (keyboard && keyboard.inline_keyboard.length > 0) {
                options.reply_markup = keyboard;
            }

            const result = await this.bot.sendMessage(chatId, message, options);
            
            return {
                messageId: result.message_id,
                chatId: chatId,
                timestamp: Date.now()
            };
        } catch (error) {
            console.error(`❌ Error enviando a chat ${chatId}:`, error.message);
            throw error;
        }
    }

    buildTelegramMessage(alert) {
        const priorityIcon = this.getPriorityIcon(alert.priority);
        const statusEmoji = this.getStatusEmoji(alert.category);
        
        let message = `${priorityIcon} *${alert.title}*\n\n`;
        
        // Información principal
        message += `🔹 *Servicio:* ${alert.service}\n`;
        message += `🔹 *Prioridad:* ${alert.priority}\n`;
        message += `🔹 *Categoría:* ${alert.category}\n`;
        message += `🔹 *Ambiente:* ${alert.environment.toUpperCase()}\n`;
        message += `🔹 *Timestamp:* ${alert.timestampFormatted}\n\n`;
        
        // Mensaje principal
        message += `💬 *Mensaje:*\n${alert.message}\n\n`;
        
        // Metadata si existe
        if (alert.metadata && Object.keys(alert.metadata).length > 0) {
            message += `📋 *Detalles adicionales:*\n`;
            for (const [key, value] of Object.entries(alert.metadata)) {
                if (value !== null && value !== undefined) {
                    message += `• *${key}:* ${value}\n`;
                }
            }
            message += '\n';
        }
        
        // ID de alerta (en formato code para fácil copia)
        message += `🔗 \`${alert.id}\`\n\n`;
        
        // Footer
        message += `_Sistema de Recargas - Alerta automática_`;
        
        return message;
    }

    buildInlineKeyboard(alert) {
        const keyboard = {
            inline_keyboard: []
        };

        // Botones para alertas críticas y altas
        if (alert.priority === 'CRITICAL' || alert.priority === 'HIGH') {
            keyboard.inline_keyboard.push([
                {
                    text: '✅ Acknowledge',
                    callback_data: `ack_${alert.id}`
                },
                {
                    text: '🔧 Resolve',
                    callback_data: `resolve_${alert.id}`
                }
            ]);
        }

        // Botón de dashboard (siempre presente)
        if (process.env.DASHBOARD_URL) {
            keyboard.inline_keyboard.push([
                {
                    text: '📊 Ver Dashboard',
                    url: process.env.DASHBOARD_URL
                }
            ]);
        }

        // Botones de información
        keyboard.inline_keyboard.push([
            {
                text: '🔍 Detalles',
                callback_data: `details_${alert.id}`
            },
            {
                text: '📈 Métricas',
                callback_data: `metrics_${alert.service}`
            }
        ]);

        return keyboard;
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

    getStatusEmoji(category) {
        const emojis = {
            'DATABASE': '🗄️',
            'WEBSERVICE': '🌐',
            'SYSTEM': '⚙️',
            'NETWORK': '🔗',
            'SECURITY': '🔒',
            'PERFORMANCE': '⚡',
            'BUSINESS': '💼',
            'MONITORING': '📊'
        };
        return emojis[category.toUpperCase()] || '🔧';
    }

    getChatsForPriority(priority) {
        return this.config.chats[priority] || [];
    }

    async testConnection() {
        try {
            // Verificar que el bot está configurado correctamente
            const botInfo = await this.bot.getMe();
            console.log(`✅ Telegram bot conectado: @${botInfo.username} (${botInfo.first_name})`);

            // Enviar mensaje de prueba a todos los chats configurados
            const testAlert = {
                id: 'test_' + Date.now(),
                timestamp: Date.now(),
                timestampFormatted: new Date().toLocaleString('es-MX', { timeZone: 'America/Mazatlan' }),
                priority: 'LOW',
                title: 'Test de Telegram',
                message: 'Este es un mensaje de prueba para verificar que el canal de Telegram funciona correctamente.',
                service: 'TEST',
                category: 'TELEGRAM_TEST',
                environment: 'test',
                metadata: {
                    testType: 'Connection Test',
                    botUsername: botInfo.username,
                    timestamp: new Date().toISOString()
                }
            };

            // Usar chats de LOW priority para el test
            const testChats = this.getChatsForPriority('LOW');
            if (testChats.length === 0) {
                throw new Error('No test chats configured for LOW priority');
            }

            const result = await this.send(testAlert);
            console.log('✅ Telegram test message sent successfully');
            return {
                ...result,
                botInfo: {
                    username: botInfo.username,
                    name: botInfo.first_name,
                    id: botInfo.id
                }
            };

        } catch (error) {
            console.error('❌ Telegram test failed:', error.message);
            throw error;
        }
    }

    // Método para obtener información del bot
    async getBotInfo() {
        try {
            return await this.bot.getMe();
        } catch (error) {
            console.error('❌ Error obteniendo info del bot:', error.message);
            throw error;
        }
    }

    // Método para obtener información de un chat específico
    async getChatInfo(chatId) {
        try {
            const chat = await this.bot.getChat(chatId);
            return {
                id: chat.id,
                type: chat.type,
                title: chat.title || chat.first_name || 'Unknown',
                username: chat.username,
                memberCount: chat.all_members_are_administrators !== undefined ? 'Group' : 'Private'
            };
        } catch (error) {
            console.warn(`⚠️ No se pudo obtener info del chat ${chatId}:`, error.message);
            return {
                id: chatId,
                type: 'unknown',
                error: error.message
            };
        }
    }

    // Método para validar todos los chats configurados
    async validateChats() {
        const allChats = new Set();
        
        // Recopilar todos los chat IDs únicos
        Object.values(this.config.chats).forEach(chats => {
            chats.forEach(chatId => allChats.add(chatId));
        });

        const validationResults = {};
        
        for (const chatId of allChats) {
            try {
                validationResults[chatId] = await this.getChatInfo(chatId);
                validationResults[chatId].valid = true;
            } catch (error) {
                validationResults[chatId] = {
                    id: chatId,
                    valid: false,
                    error: error.message
                };
            }
        }

        return validationResults;
    }

    getChannelInfo() {
        return {
            name: this.name,
            botToken: this.config.botToken ? '***configured***' : 'not configured',
            chatsByPriority: this.config.chats,
            totalChats: Object.values(this.config.chats).flat().length,
            uniqueChats: [...new Set(Object.values(this.config.chats).flat())].length
        };
    }
}

module.exports = TelegramChannel;