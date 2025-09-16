/**
 * MSTHealthCheck - FASE 5: Health Check para MST SOAP Service
 * Monitoreo automático del servicio MST con validación SOAP
 */
const soapRequest = require('easy-soap-request');
const xml2js = require('xml2js');
const config = require('../../../config/database');

class MSTHealthCheck {
    constructor() {
        this.name = 'MST';
        this.config = config.MST;
        this.consecutiveFailures = 0;
        this.lastSuccess = null;
        this.responseTimeHistory = [];
        
        console.log(`🧼 MST SOAP Health Check inicializado: ${this.config.url}`);
    }

    async check() {
        const startTime = Date.now();
        const timestamp = startTime;
        
        try {
            console.log('🔍 Verificando salud de MST SOAP...');
            
            // Preparar SOAP request para verificar conectividad
            const soapBody = this.buildTestSoapRequest();
            
            const soapOptions = {
                url: this.config.url,
                headers: {
                    'Content-Type': 'text/xml; charset=utf-8',
                    'SOAPAction': 'consultarSaldo',
                    'User-Agent': 'Recargas-System/1.0'
                },
                xml: soapBody,
                timeout: 15000 // MST puede ser más lento que TAECEL
            };

            const response = await soapRequest(soapOptions);
            const responseTime = Date.now() - startTime;
            this.updateResponseTimeHistory(responseTime);

            // Verificar respuesta SOAP válida
            const soapValidation = await this.validateSoapResponse(response.response.body);
            
            if (soapValidation.valid) {
                this.consecutiveFailures = 0;
                this.lastSuccess = timestamp;
                
                console.log(`✅ MST: Respuesta SOAP exitosa (${responseTime}ms)`);
                
                return {
                    status: responseTime > 10000 ? 'degraded' : 'healthy',
                    responseTime,
                    timestamp,
                    consecutiveFailures: this.consecutiveFailures,
                    lastSuccess: this.lastSuccess,
                    details: {
                        httpStatus: response.response.statusCode,
                        soapValid: true,
                        soapFault: soapValidation.fault,
                        serviceAvailable: soapValidation.serviceAvailable,
                        avgResponseTime: this.getAverageResponseTime(),
                        contentType: response.response.headers['content-type']
                    }
                };
            } else {
                throw new Error(`Respuesta SOAP inválida: ${soapValidation.error}`);
            }

        } catch (error) {
            this.consecutiveFailures++;
            const responseTime = Date.now() - startTime;
            
            console.error(`❌ MST Health Check falló:`, error.message);
            
            let errorDetails = {
                error: error.message,
                consecutiveFailures: this.consecutiveFailures,
                lastSuccess: this.lastSuccess,
                responseTime,
                timestamp
            };

            if (error.response) {
                errorDetails.httpStatus = error.response.statusCode;
                errorDetails.responseBody = error.response.body?.substring(0, 500); // Truncar para logs
            } else if (error.code) {
                errorDetails.type = 'connection_error';
                errorDetails.code = error.code;
            } else {
                errorDetails.type = 'soap_error';
            }

            return {
                status: 'unhealthy',
                ...errorDetails
            };
        }
    }

    buildTestSoapRequest() {
        // SOAP request básico para verificar que el servicio responde
        return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" 
               xmlns:tns="http://tempuri.org/">
    <soap:Header/>
    <soap:Body>
        <tns:consultarSaldo>
            <tns:usuario>${this.config.usuario}</tns:usuario>
            <tns:clave>${this.config.clave}</tns:clave>
        </tns:consultarSaldo>
    </soap:Body>
</soap:Envelope>`;
    }

    async validateSoapResponse(responseBody) {
        try {
            if (!responseBody || typeof responseBody !== 'string') {
                return { valid: false, error: 'Empty or invalid response body' };
            }

            // Verificar que es XML válido
            const parser = new xml2js.Parser({ explicitArray: false });
            const parsed = await parser.parseStringPromise(responseBody);

            // Verificar estructura SOAP básica
            if (!parsed['soap:Envelope'] && !parsed.Envelope) {
                return { valid: false, error: 'Not a valid SOAP envelope' };
            }

            const envelope = parsed['soap:Envelope'] || parsed.Envelope;
            const body = envelope['soap:Body'] || envelope.Body;

            if (!body) {
                return { valid: false, error: 'Missing SOAP body' };
            }

            // Verificar si hay SOAP Fault
            const fault = body['soap:Fault'] || body.Fault;
            if (fault) {
                const faultString = fault.faultstring || fault.detail || 'Unknown SOAP fault';
                
                // Algunos faults pueden ser esperados (ej: credenciales de test)
                if (this.isExpectedFault(faultString)) {
                    return {
                        valid: true,
                        fault: faultString,
                        serviceAvailable: true
                    };
                } else {
                    return { 
                        valid: false, 
                        error: `SOAP Fault: ${faultString}`,
                        fault: faultString
                    };
                }
            }

            // Verificar respuesta exitosa
            const response = body.consultarSaldoResponse || body.consultarSaldoResult;
            if (response) {
                return {
                    valid: true,
                    serviceAvailable: true,
                    fault: null
                };
            }

            // Si llegamos aquí, el SOAP es válido pero no reconocemos la estructura
            return {
                valid: true,
                serviceAvailable: true,
                fault: null,
                note: 'Valid SOAP but unexpected structure'
            };

        } catch (error) {
            return { 
                valid: false, 
                error: `XML parsing error: ${error.message}` 
            };
        }
    }

    isExpectedFault(faultString) {
        const expectedFaults = [
            'credenciales inválidas',
            'usuario no encontrado',
            'invalid credentials',
            'authentication failed',
            'usuario o clave incorrectos'
        ];

        return expectedFaults.some(expected => 
            faultString.toLowerCase().includes(expected.toLowerCase())
        );
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
        console.log('🧪 Probando conexión MST SOAP...');
        
        try {
            const result = await this.check();
            
            if (result.status === 'healthy' || result.status === 'degraded') {
                console.log('✅ Conexión MST SOAP exitosa');
                console.log(`   • Response Time: ${result.responseTime}ms`);
                console.log(`   • Status: ${result.status}`);
                console.log(`   • Service Available: ${result.details?.serviceAvailable}`);
                if (result.details?.soapFault) {
                    console.log(`   • SOAP Fault (expected): ${result.details.soapFault}`);
                }
                return true;
            } else {
                console.error('❌ Conexión MST SOAP falló:', result.error);
                if (result.responseBody) {
                    console.error('   • Response Body:', result.responseBody);
                }
                return false;
            }
        } catch (error) {
            console.error('❌ Error probando conexión MST:', error.message);
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
                    this.consecutiveFailures < 3 ? 'degraded' : 'unhealthy',
            serviceType: 'SOAP'
        };
    }

    reset() {
        this.consecutiveFailures = 0;
        this.lastSuccess = null;
        this.responseTimeHistory = [];
        console.log('🔄 MST Health Check reseteado');
    }
}

module.exports = MSTHealthCheck;