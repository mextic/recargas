#!/usr/bin/env node

/**
 * Script de recuperación para elementos pendientes en cola auxiliar ELIOT
 *
 * Este script procesa manualmente los elementos pendientes en eliot_auxiliary_queue.json
 * que representan recargas ya cobradas por TAECEL pero no insertadas en BD.
 *
 * CRÍTICO: Estos elementos contienen dinero real ($20 USD) que ya fue gastado
 * y deben ser insertados en BD para actualizar fechas de agentes.
 *
 * Uso: node scripts/recover-eliot-queue.js
 */

const fs = require('fs');
const path = require('path');

// Importar procesador ELIOT y dependencias
const { ELIoTRechargeProcessor } = require('../lib/processors/ELIoTRechargeProcessor');
const { createLogger } = require('../lib/utils/logger');

class ELIoTQueueRecovery {
    constructor() {
        this.logger = createLogger('eliot-recovery');
        this.queuePath = path.join(__dirname, '..', 'data', 'eliot_auxiliary_queue.json');
        this.processor = new ELIoTRechargeProcessor();
    }

    /**
     * Función principal de recuperación
     */
    async run() {
        try {
            this.logger.info('🔧 Iniciando recuperación de cola auxiliar ELIOT');

            // 1. Verificar que existe la cola auxiliar
            if (!fs.existsSync(this.queuePath)) {
                this.logger.warn('❌ No se encontró cola auxiliar ELIOT', {
                    path: this.queuePath
                });
                return;
            }

            // 2. Leer elementos pendientes
            const queueData = JSON.parse(fs.readFileSync(this.queuePath, 'utf8'));

            if (!Array.isArray(queueData) || queueData.length === 0) {
                this.logger.info('✅ Cola auxiliar ELIOT está vacía - no hay nada que recuperar');
                return;
            }

            this.logger.info('📊 Elementos encontrados en cola auxiliar ELIOT', {
                total: queueData.length,
                elementos: queueData.map(item => ({
                    sim: item.sim,
                    folio: item.webserviceResponse?.folio,
                    monto: item.webserviceResponse?.monto,
                    status: item.status
                }))
            });

            // 3. Validar que los elementos tienen la estructura esperada
            const validItems = queueData.filter(item => {
                return item.tipo === 'ELIoT_recharge' &&
                       item.status === 'pending' &&
                       item.webserviceResponse &&
                       item.webserviceResponse.folio &&
                       item.sim;
            });

            if (validItems.length === 0) {
                this.logger.warn('❌ No se encontraron elementos válidos para recuperar');
                return;
            }

            this.logger.info('✅ Elementos válidos para recuperación', {
                validos: validItems.length,
                total: queueData.length
            });

            // 4. Procesar elementos usando el método de recovery del procesador
            this.logger.info('🔄 Iniciando procesamiento de recovery...');

            await this.processor.processRecovery();

            this.logger.info('✅ Recuperación completada exitosamente');

            // 5. Verificar estado final de la cola
            const finalQueueData = JSON.parse(fs.readFileSync(this.queuePath, 'utf8'));
            this.logger.info('📊 Estado final de cola auxiliar ELIOT', {
                elementosRestantes: finalQueueData.length,
                elementsOriginales: queueData.length,
                elementosProcesados: queueData.length - finalQueueData.length
            });

            if (finalQueueData.length === 0) {
                this.logger.info('🎉 ÉXITO: Cola auxiliar ELIOT completamente procesada');
            } else {
                this.logger.warn('⚠️  Elementos aún pendientes en cola auxiliar ELIOT', {
                    pendientes: finalQueueData.length
                });
            }

        } catch (error) {
            this.logger.error('❌ Error durante recuperación de cola ELIOT', error);
            throw error;
        }
    }

    /**
     * Método alternativo: procesar manualmente sin usar BaseRechargeProcessor
     */
    async runManual() {
        try {
            this.logger.info('🔧 Iniciando recuperación MANUAL de cola auxiliar ELIOT');

            // Leer cola auxiliar
            const queueData = JSON.parse(fs.readFileSync(this.queuePath, 'utf8'));

            if (queueData.length === 0) {
                this.logger.info('✅ Cola auxiliar ELIOT está vacía');
                return;
            }

            // Procesar cada elemento manualmente
            const results = await this.processor.insertBatchRechargesWithDuplicateHandling(
                queueData,
                'ELIoT',
                true // isRecovery = true
            );

            this.logger.info('✅ Procesamiento manual completado', {
                insertados: results.inserted.length,
                duplicados: results.duplicates.length,
                errores: results.errors.length
            });

        } catch (error) {
            this.logger.error('❌ Error durante recuperación manual', error);
            throw error;
        }
    }
}

// Ejecutar script si es llamado directamente
if (require.main === module) {
    const recovery = new ELIoTQueueRecovery();

    // Determinar método a usar basado en argumentos
    const useManual = process.argv.includes('--manual');

    if (useManual) {
        recovery.runManual()
            .then(() => {
                console.log('✅ Recuperación manual completada');
                process.exit(0);
            })
            .catch(error => {
                console.error('❌ Error en recuperación manual:', error.message);
                process.exit(1);
            });
    } else {
        recovery.run()
            .then(() => {
                console.log('✅ Recuperación completada');
                process.exit(0);
            })
            .catch(error => {
                console.error('❌ Error en recuperación:', error.message);
                process.exit(1);
            });
    }
}

module.exports = { ELIoTQueueRecovery };