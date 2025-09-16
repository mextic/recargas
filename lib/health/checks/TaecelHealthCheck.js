/**
 * TaecelHealthCheck - FASE 5: Health Check para API TAECEL
 * Monitoreo automático del servicio TAECEL con métricas detalladas
 */
const axios = require('axios');
const config = require('../../../config/database');

class TaecelHealthCheck {
    constructor() {
        this.name = 'TAECEL';
        this.config = config.TAECEL;
        this.consecutiveFailures = 0;
        this.lastSuccess = null;
        this.responseTimeHistory = [];
        
        console.log(`🌐 TAECEL Health Check inicializado: ${this.config.url}`);
    }

    async check() {
        const startTime = Date.now();
        const timestamp = startTime;
        
        try {
            console.log('🔍 Verificando salud de TAECEL API...');
            
            // Preparar datos de prueba para verificar conectividad
            const testData = {
                key: this.config.key,
                nip: this.config.nip,
                action: 'balance' // Verificar saldo para confirmar conectividad
            };

            const response = await axios.post(this.config.url, testData, {
                timeout: 10000,
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': 'Recargas-System/1.0'
                }
            });

            const responseTime = Date.now() - startTime;
            this.updateResponseTimeHistory(responseTime);

            // Verificar respuesta válida
            const isValidResponse = this.validateTaecelResponse(response.data);
            
            if (isValidResponse.valid) {
                this.consecutiveFailures = 0;
                this.lastSuccess = timestamp;
                
                console.log(`✅ TAECEL: Respuesta exitosa (${responseTime}ms)`);
                
                return {
                    status: responseTime > 5000 ? 'degraded' : 'healthy',
                    responseTime,
                    timestamp,
                    consecutiveFailures: this.consecutiveFailures,
                    lastSuccess: this.lastSuccess,
                    details: {
                        httpStatus: response.status,
                        responseValid: true,
                        balance: isValidResponse.balance,
                        apiVersion: response.headers['x-api-version'] || 'unknown',
                        avgResponseTime: this.getAverageResponseTime()
                    }
                };
            } else {
                throw new Error(`Respuesta inválida de TAECEL: ${isValidResponse.error}`);
            }

        } catch (error) {
            this.consecutiveFailures++;
            const responseTime = Date.now() - startTime;
            
            console.error(`❌ TAECEL Health Check falló:`, error.message);
            
            let errorDetails = {
                error: error.message,
                consecutiveFailures: this.consecutiveFailures,
                lastSuccess: this.lastSuccess,
                responseTime,
                timestamp
            };

            if (error.response) {
                errorDetails.httpStatus = error.response.status;
                errorDetails.httpStatusText = error.response.statusText;
                errorDetails.responseData = error.response.data;
            } else if (error.request) {
                errorDetails.type = 'network_error';
                errorDetails.details = 'No response received from TAECEL';
            } else {
                errorDetails.type = 'request_error';
                errorDetails.details = error.message;
            }

            return {
                status: 'unhealthy',
                ...errorDetails
            };
        }
    }

    validateTaecelResponse(responseData) {
        try {
            // TAECEL puede devolver diferentes formatos
            if (typeof responseData === 'string') {
                // Intentar parsear como JSON si es string
                try {
                    responseData = JSON.parse(responseData);
                } catch (e) {
                    // Si no es JSON, verificar si contiene indicadores de éxito
                    if (responseData.includes('balance') || responseData.includes('saldo')) {
                        return { valid: true, balance: 'unknown' };
                    }
                    return { valid: false, error: 'Invalid response format' };
                }
            }

            if (typeof responseData === 'object') {
                // Verificar estructura esperada
                if (responseData.error) {
                    return { valid: false, error: responseData.error };
                }
                
                if (responseData.balance !== undefined || responseData.saldo !== undefined) {
                    return { 
                        valid: true, 
                        balance: responseData.balance || responseData.saldo 
                    };
                }
                
                // Si tiene status exitoso
                if (responseData.status === 'success' || responseData.status === 'ok') {
                    return { valid: true, balance: responseData.balance || 'unknown' };
                }
            }

            return { valid: false, error: 'Unexpected response structure' };
            
        } catch (error) {
            return { valid: false, error: `Response validation error: ${error.message}` };
        }
    }

    updateResponseTimeHistory(responseTime) {
        this.responseTimeHistory.unshift(responseTime);
        
        // Mantener solo las últimas 10 mediciones
        if (this.responseTimeHistory.length > 10) {
            this.responseTimeHistory = this.responseTimeHistory.slice(0, 10);
        }
    }

    getAverageResponseTime() {
        if (this.responseTimeHistory.length === 0) return 0;
        
        const sum = this.responseTimeHistory.reduce((a, b) => a + b, 0);
        return Math.round(sum / this.responseTimeHistory.length);
    }

    async testConnection() {
        console.log('🧪 Probando conexión TAECEL...');
        
        try {
            const result = await this.check();
            
            if (result.status === 'healthy' || result.status === 'degraded') {
                console.log('✅ Conexión TAECEL exitosa');
                console.log(`   • Response Time: ${result.responseTime}ms`);
                console.log(`   • Status: ${result.status}`);
                if (result.details?.balance) {
                    console.log(`   • Balance: ${result.details.balance}`);
                }
                return true;
            } else {
                console.error('❌ Conexión TAECEL falló:', result.error);
                return false;
            }
        } catch (error) {
            console.error('❌ Error probando conexión TAECEL:', error.message);
            return false;
        }
    }

    getStats() {
        return {
            name: this.name,
            url: this.config.url,
            consecutiveFailures: this.consecutiveFailures,
            lastSuccess: this.lastSuccess,
            lastSuccessFormatted: this.lastSuccess ? 
                new Date(this.lastSuccess).toLocaleString('es-MX', { 
                    timeZone: 'America/Mazatlan' 
                }) : 'Never',
            averageResponseTime: this.getAverageResponseTime(),
            responseTimeHistory: this.responseTimeHistory.slice(0, 5), // Últimas 5
            status: this.consecutiveFailures === 0 ? 'healthy' : 
                    this.consecutiveFailures < 3 ? 'degraded' : 'unhealthy'
        };
    }

    reset() {
        this.consecutiveFailures = 0;
        this.lastSuccess = null;
        this.responseTimeHistory = [];
        console.log('🔄 TAECEL Health Check reseteado');
    }
}

module.exports = TaecelHealthCheck;