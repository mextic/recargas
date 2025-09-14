// Ejemplo de integración del nuevo sistema de logging en processors
const { createServiceLogger, logMetrics } = require('../utils/logger');

class ExampleProcessor {
    constructor(serviceName) {
        this.serviceName = serviceName;
        this.logger = createServiceLogger(serviceName);
    }

    async processRecharges() {
        const transactionId = `txn_${Date.now()}`;
        
        this.logger.operation('process_start', 'Iniciando procesamiento de recargas', {
            transactionId,
            timestamp: new Date().toISOString()
        });

        try {
            // Simular procesamiento
            const startTime = Date.now();
            
            this.logger.info('Consultando proveedores de saldo', {
                operation: 'get_providers',
                transactionId
            });

            // Simular trabajo
            await new Promise(resolve => setTimeout(resolve, 100));

            const duration = Date.now() - startTime;
            
            // Log de métrica de negocio
            logMetrics('recharge_batch_completed', {
                service: this.serviceName,
                count: 5,
                totalAmount: 50,
                duration,
                provider: 'TAECEL',
                success: true
            });

            this.logger.operation('process_complete', 'Procesamiento completado exitosamente', {
                transactionId,
                duration,
                rechargesProcessed: 5,
                totalAmount: 50
            });

            return { success: true, processed: 5 };

        } catch (error) {
            this.logger.error('Error durante procesamiento', error, {
                operation: 'process_recharges',
                transactionId,
                duration: Date.now() - startTime
            });

            // Log de métrica de error
            logMetrics('recharge_batch_failed', {
                service: this.serviceName,
                errorType: error.name,
                errorMessage: error.message
            });

            throw error;
        }
    }
}

module.exports = { ExampleProcessor };