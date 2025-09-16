/**
 * EmailChannel - FASE 5: Canal de Email Configurable
 * Envío de alertas por email con plantillas HTML y configuración por variables de entorno
 */
const nodemailer = require('nodemailer');

class EmailChannel {
    constructor(config) {
        this.config = config;
        this.name = 'Email';
        this.transporter = null;
        
        this.initializeTransporter();
        console.log(`📧 Email Channel inicializado: ${config.smtp.host}:${config.smtp.port}`);
        console.log(`👥 Destinatarios configurados por prioridad:`, config.recipients);
    }

    initializeTransporter() {
        try {
            this.transporter = nodemailer.createTransporter({
                host: this.config.smtp.host,
                port: this.config.smtp.port,
                secure: this.config.smtp.secure, // true para 465, false para otros puertos
                auth: {
                    user: this.config.smtp.auth.user,
                    pass: this.config.smtp.auth.pass
                },
                // Configuración adicional para diferentes proveedores
                ...(this.config.smtp.host.includes('gmail') && {
                    service: 'gmail'
                }),
                ...(this.config.smtp.host.includes('outlook') && {
                    service: 'hotmail'
                })
            });

            console.log('✅ Email transporter configurado correctamente');
        } catch (error) {
            console.error('❌ Error configurando email transporter:', error.message);
            throw error;
        }
    }

    async send(alert) {
        try {
            const recipients = this.getRecipientsForPriority(alert.priority);
            
            if (recipients.length === 0) {
                console.log(`📧 No hay destinatarios configurados para prioridad ${alert.priority}`);
                return {
                    success: true,
                    skipped: true,
                    reason: `No recipients for priority ${alert.priority}`
                };
            }

            const mailOptions = {
                from: this.config.from,
                to: recipients.join(', '),
                subject: this.buildSubject(alert),
                html: this.buildHtmlBody(alert),
                text: this.buildTextBody(alert)
            };

            // Enviar email
            const info = await this.transporter.sendMail(mailOptions);

            console.log(`✅ Email enviado a ${recipients.length} destinatario(s): ${info.messageId}`);

            return {
                success: true,
                messageId: info.messageId,
                recipients: recipients,
                timestamp: Date.now()
            };

        } catch (error) {
            console.error('❌ Error enviando email:', error.message);
            throw new Error(`Email sending failed: ${error.message}`);
        }
    }

    buildSubject(alert) {
        const priorityIcon = this.getPriorityIcon(alert.priority);
        const env = alert.environment.toUpperCase();
        return `${priorityIcon} [${alert.priority}] ${alert.title} - ${alert.service} (${env})`;
    }

    buildHtmlBody(alert) {
        const priorityColor = this.getPriorityColor(alert.priority);
        const priorityIcon = this.getPriorityIcon(alert.priority);

        return `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Alerta del Sistema</title>
            <style>
                body { font-family: Arial, sans-serif; margin: 0; padding: 20px; background-color: #f5f5f5; }
                .container { max-width: 600px; margin: 0 auto; background-color: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
                .header { background-color: ${priorityColor}; color: white; padding: 20px; text-align: center; }
                .header h1 { margin: 0; font-size: 24px; }
                .priority-badge { background-color: rgba(255,255,255,0.2); padding: 4px 12px; border-radius: 15px; display: inline-block; margin-top: 10px; }
                .content { padding: 30px; }
                .alert-details { background-color: #f8f9fa; border-left: 4px solid ${priorityColor}; padding: 15px; margin: 20px 0; }
                .detail-row { margin: 10px 0; }
                .detail-label { font-weight: bold; color: #333; display: inline-block; width: 120px; }
                .detail-value { color: #666; }
                .message-box { background-color: #e9ecef; padding: 20px; border-radius: 6px; margin: 20px 0; }
                .metadata-table { width: 100%; border-collapse: collapse; margin: 15px 0; }
                .metadata-table th, .metadata-table td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #ddd; }
                .metadata-table th { background-color: #f8f9fa; font-weight: bold; }
                .footer { background-color: #f8f9fa; padding: 20px; text-align: center; color: #666; font-size: 12px; }
                .button { display: inline-block; padding: 10px 20px; background-color: ${priorityColor}; color: white; text-decoration: none; border-radius: 4px; margin: 5px; }
                .button:hover { opacity: 0.8; }
                @media (max-width: 600px) { .container { margin: 10px; } .content { padding: 20px; } }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>${priorityIcon} ${alert.title}</h1>
                    <div class="priority-badge">Prioridad: ${alert.priority}</div>
                </div>
                
                <div class="content">
                    <div class="alert-details">
                        <div class="detail-row">
                            <span class="detail-label">Servicio:</span>
                            <span class="detail-value">${alert.service}</span>
                        </div>
                        <div class="detail-row">
                            <span class="detail-label">Categoría:</span>
                            <span class="detail-value">${alert.category}</span>
                        </div>
                        <div class="detail-row">
                            <span class="detail-label">Timestamp:</span>
                            <span class="detail-value">${alert.timestampFormatted}</span>
                        </div>
                        <div class="detail-row">
                            <span class="detail-label">Ambiente:</span>
                            <span class="detail-value">${alert.environment.toUpperCase()}</span>
                        </div>
                        <div class="detail-row">
                            <span class="detail-label">ID de Alerta:</span>
                            <span class="detail-value">${alert.id}</span>
                        </div>
                    </div>

                    <div class="message-box">
                        <h3>Mensaje de la Alerta:</h3>
                        <p>${alert.message}</p>
                    </div>

                    ${this.buildMetadataSection(alert.metadata)}

                    ${this.buildActionButtons(alert)}
                </div>

                <div class="footer">
                    <p>Sistema de Recargas Prepago - Alertas Automáticas</p>
                    <p>Generado el ${new Date().toLocaleString('es-MX', { timeZone: 'America/Mazatlan' })}</p>
                    <p style="font-size: 10px; color: #999;">
                        Este es un mensaje automático. No responder a este email.
                    </p>
                </div>
            </div>
        </body>
        </html>
        `;
    }

    buildMetadataSection(metadata) {
        if (!metadata || Object.keys(metadata).length === 0) {
            return '';
        }

        let metadataRows = '';
        for (const [key, value] of Object.entries(metadata)) {
            if (value !== null && value !== undefined) {
                metadataRows += `
                    <tr>
                        <th>${key}</th>
                        <td>${value}</td>
                    </tr>
                `;
            }
        }

        return `
            <h3>Detalles Adicionales:</h3>
            <table class="metadata-table">
                ${metadataRows}
            </table>
        `;
    }

    buildActionButtons(alert) {
        const dashboardUrl = process.env.DASHBOARD_URL || 'http://localhost:3000';
        
        return `
            <div style="text-align: center; margin: 30px 0;">
                <a href="${dashboardUrl}" class="button">📊 Ver Dashboard</a>
                <a href="${dashboardUrl}/alerts/${alert.id}" class="button">🔍 Ver Detalles</a>
            </div>
        `;
    }

    buildTextBody(alert) {
        let textBody = `
🚨 ALERTA DEL SISTEMA

Título: ${alert.title}
Prioridad: ${alert.priority}
Servicio: ${alert.service}
Categoría: ${alert.category}
Timestamp: ${alert.timestampFormatted}
Ambiente: ${alert.environment.toUpperCase()}

Mensaje:
${alert.message}

ID de Alerta: ${alert.id}
        `;

        if (alert.metadata && Object.keys(alert.metadata).length > 0) {
            textBody += '\n\nDetalles Adicionales:\n';
            for (const [key, value] of Object.entries(alert.metadata)) {
                if (value !== null && value !== undefined) {
                    textBody += `- ${key}: ${value}\n`;
                }
            }
        }

        textBody += `\n\nDashboard: ${process.env.DASHBOARD_URL || 'http://localhost:3000'}`;
        textBody += '\n\n---\nSistema de Recargas Prepago - Alertas Automáticas';
        textBody += '\nEste es un mensaje automático. No responder a este email.';

        return textBody;
    }

    getPriorityColor(priority) {
        const colors = {
            CRITICAL: '#dc3545',  // Rojo Bootstrap
            HIGH: '#fd7e14',      // Naranja Bootstrap
            MEDIUM: '#ffc107',    // Amarillo Bootstrap
            LOW: '#28a745'        // Verde Bootstrap
        };
        return colors[priority] || '#6c757d';
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

    async testConnection() {
        try {
            // Verificar conexión SMTP
            await this.transporter.verify();
            console.log('✅ Email SMTP connection verified');

            // Enviar email de prueba
            const testAlert = {
                id: 'test_' + Date.now(),
                timestamp: Date.now(),
                timestampFormatted: new Date().toLocaleString('es-MX', { timeZone: 'America/Mazatlan' }),
                priority: 'LOW',
                title: 'Test de Email',
                message: 'Este es un mensaje de prueba para verificar que el canal de email funciona correctamente.',
                service: 'TEST',
                category: 'EMAIL_TEST',
                environment: 'test',
                metadata: {
                    testType: 'Connection Test',
                    timestamp: new Date().toISOString()
                }
            };

            // Usar destinatarios de LOW priority para el test
            const testRecipients = this.getRecipientsForPriority('LOW');
            if (testRecipients.length === 0) {
                throw new Error('No test recipients configured for LOW priority');
            }

            const result = await this.send(testAlert);
            console.log('✅ Email test message sent successfully');
            return result;

        } catch (error) {
            console.error('❌ Email test failed:', error.message);
            throw error;
        }
    }

    getChannelInfo() {
        return {
            name: this.name,
            smtpHost: this.config.smtp.host,
            smtpPort: this.config.smtp.port,
            smtpSecure: this.config.smtp.secure,
            from: this.config.from,
            recipientsByPriority: this.config.recipients,
            username: this.config.smtp.auth.user ? '***configured***' : 'not configured'
        };
    }
}

module.exports = EmailChannel;