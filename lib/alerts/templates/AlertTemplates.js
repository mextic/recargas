/**
 * AlertTemplates - Plantillas para diferentes tipos de alertas
 * Sistema de templates configurables para alertas del sistema de recargas
 */
class AlertTemplates {
    constructor() {
        this.templates = {
            // Alertas del sistema
            system: {
                database_error: {
                    title: '🔴 Error de Base de Datos',
                    slack: '⚠️ *Error de Conexión BD*\n• Servicio: {service}\n• Error: {error}\n• Timestamp: {timestamp}',
                    email: {
                        subject: 'Sistema Recargas: Error BD - {service}',
                        html: '<h3>🔴 Error de Base de Datos</h3><p><strong>Servicio:</strong> {service}</p><p><strong>Error:</strong> {error}</p><p><strong>Timestamp:</strong> {timestamp}</p>'
                    },
                    telegram: '🔴 *Error de Base de Datos*\nServicio: {service}\nError: {error}\nTimestamp: {timestamp}',
                    webhook: {
                        alert_type: 'database_error',
                        service: '{service}',
                        error: '{error}',
                        timestamp: '{timestamp}'
                    }
                },
                
                redis_error: {
                    title: '🔴 Error de Redis',
                    slack: '⚠️ *Error de Redis*\n• Error: {error}\n• Timestamp: {timestamp}',
                    email: {
                        subject: 'Sistema Recargas: Error Redis',
                        html: '<h3>🔴 Error de Redis</h3><p><strong>Error:</strong> {error}</p><p><strong>Timestamp:</strong> {timestamp}</p>'
                    },
                    telegram: '🔴 *Error de Redis*\nError: {error}\nTimestamp: {timestamp}',
                    webhook: {
                        alert_type: 'redis_error',
                        error: '{error}',
                        timestamp: '{timestamp}'
                    }
                },

                system_startup: {
                    title: '🟢 Sistema Iniciado',
                    slack: '✅ *Sistema de Recargas Iniciado*\n• Versión: 2.0\n• Timestamp: {timestamp}',
                    email: {
                        subject: 'Sistema Recargas: Inicio Exitoso',
                        html: '<h3>🟢 Sistema Iniciado</h3><p>El sistema de recargas v2.0 se ha iniciado correctamente.</p><p><strong>Timestamp:</strong> {timestamp}</p>'
                    },
                    telegram: '🟢 *Sistema Iniciado*\nSistema de recargas v2.0 online\nTimestamp: {timestamp}',
                    webhook: {
                        alert_type: 'system_startup',
                        version: '2.0',
                        timestamp: '{timestamp}'
                    }
                }
            },

            // Alertas de procesos
            process: {
                gps_error: {
                    title: '⚠️ Error en Proceso GPS',
                    slack: '⚠️ *Error Proceso GPS*\n• Error: {error}\n• Dispositivos afectados: {devices}\n• Timestamp: {timestamp}',
                    email: {
                        subject: 'Sistema Recargas: Error GPS',
                        html: '<h3>⚠️ Error en Proceso GPS</h3><p><strong>Error:</strong> {error}</p><p><strong>Dispositivos afectados:</strong> {devices}</p><p><strong>Timestamp:</strong> {timestamp}</p>'
                    },
                    telegram: '⚠️ *Error Proceso GPS*\nError: {error}\nDispositivos: {devices}\nTimestamp: {timestamp}',
                    webhook: {
                        alert_type: 'gps_error',
                        error: '{error}',
                        devices: '{devices}',
                        timestamp: '{timestamp}'
                    }
                },

                voz_error: {
                    title: '⚠️ Error en Proceso VOZ',
                    slack: '⚠️ *Error Proceso VOZ*\n• Error: {error}\n• Líneas afectadas: {lines}\n• Timestamp: {timestamp}',
                    email: {
                        subject: 'Sistema Recargas: Error VOZ',
                        html: '<h3>⚠️ Error en Proceso VOZ</h3><p><strong>Error:</strong> {error}</p><p><strong>Líneas afectadas:</strong> {lines}</p><p><strong>Timestamp:</strong> {timestamp}</p>'
                    },
                    telegram: '⚠️ *Error Proceso VOZ*\nError: {error}\nLíneas: {lines}\nTimestamp: {timestamp}',
                    webhook: {
                        alert_type: 'voz_error',
                        error: '{error}',
                        lines: '{lines}',
                        timestamp: '{timestamp}'
                    }
                },

                eliot_error: {
                    title: '⚠️ Error en Proceso ELIoT',
                    slack: '⚠️ *Error Proceso ELIoT*\n• Error: {error}\n• Dispositivos afectados: {devices}\n• Timestamp: {timestamp}',
                    email: {
                        subject: 'Sistema Recargas: Error ELIoT',
                        html: '<h3>⚠️ Error en Proceso ELIoT</h3><p><strong>Error:</strong> {error}</p><p><strong>Dispositivos afectados:</strong> {devices}</p><p><strong>Timestamp:</strong> {timestamp}</p>'
                    },
                    telegram: '⚠️ *Error Proceso ELIoT*\nError: {error}\nDispositivos: {devices}\nTimestamp: {timestamp}',
                    webhook: {
                        alert_type: 'eliot_error',
                        error: '{error}',
                        devices: '{devices}',
                        timestamp: '{timestamp}'
                    }
                }
            },

            // Alertas de negocio
            business: {
                low_success_rate: {
                    title: '📉 Tasa de Éxito Baja',
                    slack: '📉 *Tasa de Éxito Baja*\n• Servicio: {service}\n• Tasa actual: {rate}%\n• Umbral: {threshold}%\n• Timestamp: {timestamp}',
                    email: {
                        subject: 'Sistema Recargas: Tasa Éxito Baja - {service}',
                        html: '<h3>📉 Tasa de Éxito Baja</h3><p><strong>Servicio:</strong> {service}</p><p><strong>Tasa actual:</strong> {rate}%</p><p><strong>Umbral:</strong> {threshold}%</p><p><strong>Timestamp:</strong> {timestamp}</p>'
                    },
                    telegram: '📉 *Tasa de Éxito Baja*\nServicio: {service}\nTasa: {rate}%\nUmbral: {threshold}%\nTimestamp: {timestamp}',
                    webhook: {
                        alert_type: 'low_success_rate',
                        service: '{service}',
                        rate: '{rate}',
                        threshold: '{threshold}',
                        timestamp: '{timestamp}'
                    }
                },

                high_error_rate: {
                    title: '🚨 Tasa de Error Alta',
                    slack: '🚨 *Tasa de Error Alta*\n• Servicio: {service}\n• Errores: {errors}\n• Total: {total}\n• Tasa: {rate}%\n• Timestamp: {timestamp}',
                    email: {
                        subject: 'Sistema Recargas: Tasa Error Alta - {service}',
                        html: '<h3>🚨 Tasa de Error Alta</h3><p><strong>Servicio:</strong> {service}</p><p><strong>Errores:</strong> {errors}</p><p><strong>Total:</strong> {total}</p><p><strong>Tasa:</strong> {rate}%</p><p><strong>Timestamp:</strong> {timestamp}</p>'
                    },
                    telegram: '🚨 *Tasa de Error Alta*\nServicio: {service}\nErrores: {errors}/{total}\nTasa: {rate}%\nTimestamp: {timestamp}',
                    webhook: {
                        alert_type: 'high_error_rate',
                        service: '{service}',
                        errors: '{errors}',
                        total: '{total}',
                        rate: '{rate}',
                        timestamp: '{timestamp}'
                    }
                }
            }
        };
    }

    /**
     * Obtiene template por categoría y tipo
     */
    getTemplate(category, type) {
        return this.templates[category]?.[type] || null;
    }

    /**
     * Renderiza template con variables
     */
    render(category, type, channel, variables = {}) {
        const template = this.getTemplate(category, type);
        if (!template) return null;

        const content = template[channel];
        if (!content) return null;

        return this.replaceVariables(content, variables);
    }

    /**
     * Reemplaza variables en el contenido
     */
    replaceVariables(content, variables) {
        if (typeof content === 'string') {
            let result = content;
            for (const [key, value] of Object.entries(variables)) {
                const regex = new RegExp(`\\{${key}\\}`, 'g');
                result = result.replace(regex, value);
            }
            return result;
        } else if (typeof content === 'object') {
            const result = {};
            for (const [key, value] of Object.entries(content)) {
                result[key] = this.replaceVariables(value, variables);
            }
            return result;
        }
        return content;
    }

    /**
     * Lista todas las categorías disponibles
     */
    getCategories() {
        return Object.keys(this.templates);
    }

    /**
     * Lista todos los tipos de una categoría
     */
    getTypes(category) {
        return Object.keys(this.templates[category] || {});
    }

    /**
     * Valida si existe un template específico
     */
    hasTemplate(category, type) {
        return !!(this.templates[category]?.[type]);
    }
}

module.exports = AlertTemplates;