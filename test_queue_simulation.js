#!/usr/bin/env node

// Script de simulación para probar la cola auxiliar sin modificar la BD
const path = require('path');

// Mock de la base de datos para simulación
class MockDatabase {
    constructor() {
        this.queries = [];
        this.inserts = [];
        this.updates = [];
    }

    async querySequelize(sql, options) {
        const operation = {
            sql: sql.trim(),
            replacements: options.replacements || [],
            type: options.type,
            timestamp: Date.now()
        };

        this.queries.push(operation);

        // Simular respuestas según el tipo de query
        if (sql.includes('SELECT') && sql.includes('dispositivos') && sql.includes('vehiculos')) {
            // Mock de datos del dispositivo
            return [{
                descripcion: 'SIMULACION VEHICULO',
                empresa: 'EMPRESA TEST',
                dispositivo: 'DEVICE_001',
                sim: options.replacements[0]
            }];
        }

        if (sql.includes('INSERT INTO recargas')) {
            // Mock del ID de la recarga insertada
            const mockId = Math.floor(Math.random() * 100000);
            this.inserts.push({
                type: 'recargas',
                id: mockId,
                data: operation
            });
            return [mockId];
        }

        if (sql.includes('INSERT INTO detalle_recargas')) {
            const mockDetailId = Math.floor(Math.random() * 100000);
            this.inserts.push({
                type: 'detalle_recargas', 
                id: mockDetailId,
                data: operation
            });
            return [mockDetailId];
        }

        if (sql.includes('UPDATE dispositivos') || sql.includes('UPDATE prepagos_automaticos') || sql.includes('UPDATE agentes')) {
            this.updates.push({
                type: sql.includes('dispositivos') ? 'dispositivos' : 
                      sql.includes('prepagos_automaticos') ? 'prepagos_automaticos' : 'agentes',
                data: operation
            });
            return [1]; // Affected rows
        }

        return [];
    }

    getSequelizeClient() {
        return {
            transaction: async () => new MockTransaction(),
            QueryTypes: {
                SELECT: 'SELECT',
                INSERT: 'INSERT',
                UPDATE: 'UPDATE'
            }
        };
    }

    // Reportes de simulación
    getSimulationReport() {
        return {
            totalQueries: this.queries.length,
            totalInserts: this.inserts.length,
            totalUpdates: this.updates.length,
            recargas: this.inserts.filter(i => i.type === 'recargas').length,
            detalles: this.inserts.filter(i => i.type === 'detalle_recargas').length,
            deviceUpdates: this.updates.length
        };
    }

    printSimulationLog() {
        console.log('\n📋 === REPORTE DE SIMULACIÓN ===');
        console.log(`📊 Total queries ejecutadas: ${this.queries.length}`);
        console.log(`➕ Total inserts: ${this.inserts.length}`);
        console.log(`🔄 Total updates: ${this.updates.length}`);
        
        console.log('\n📝 Inserts realizados:');
        this.inserts.forEach((insert, i) => {
            console.log(`   ${i + 1}. ${insert.type} - ID: ${insert.id}`);
            if (insert.type === 'recargas') {
                const replacements = insert.data.replacements;
                console.log(`      → Total: $${replacements[0]}, Proveedor: ${replacements[4]}`);
            }
            if (insert.type === 'detalle_recargas') {
                const replacements = insert.data.replacements;
                console.log(`      → SIM: ${replacements[1]}, Monto: $${replacements[2]}, Folio: ${replacements[6]}`);
            }
        });

        console.log('\n🔄 Updates realizados:');
        this.updates.forEach((update, i) => {
            const replacements = update.data.replacements;
            console.log(`   ${i + 1}. ${update.type}`);
            console.log(`      → SIM: ${replacements[1]}, Nueva fecha/unix: ${replacements[0]}`);
        });
    }
}

class MockTransaction {
    async commit() {
        console.log('     💾 SIMULACIÓN: Transaction.commit()');
    }
    
    async rollback() {
        console.log('     ❌ SIMULACIÓN: Transaction.rollback()');
    }
}

async function runQueueSimulation() {
    console.log('🧪 === SIMULACIÓN DE COLA AUXILIAR UNIVERSAL ===');
    console.log('📋 Esta simulación NO modifica la base de datos real');
    console.log('✅ Simula todo el flujo de recuperación universal (GPS/VOZ/ELIOT)');
    
    try {
        // Crear mock database
        const mockDb = new MockDatabase();
        
        // Crear una versión de recovery methods para simulación
        const originalRecoveryMethods = require('./lib/processors/recovery_methods.js');
        
        // Crear copia para simulación que no modifique archivos
        const simulationRecoveryMethods = {
            ...originalRecoveryMethods,
            db: mockDb,
            
            // Override para NO modificar la cola auxiliar durante simulación
            async processAuxiliaryQueueRecharges() {
                const stats = { processed: 0, failed: 0 };
                
                try {
                    const fs = require('fs').promises;
                    const path = require('path');
                    const queuePath = path.join(__dirname, 'data/auxiliary_queue.json');
                    
                    console.log('   📂 Leyendo cola auxiliar...');
                    const data = await fs.readFile(queuePath, 'utf8');
                    const auxiliaryQueue = JSON.parse(data);
                    
                    // Filtrar solo recargas GPS pendientes (ya que tenemos GPS en cola)
                    const pendingRecharges = auxiliaryQueue.filter(item => 
                        item.tipo === 'gps_recharge' && 
                        item.status === 'webservice_success_pending_db'
                    );
                    
                    console.log(`   🔄 SIMULACIÓN: Procesando ${pendingRecharges.length} recargas GPS pendientes...`);
                    
                    if (pendingRecharges.length === 0) {
                        console.log('   📋 No hay recargas pendientes para procesar');
                        return stats;
                    }
                    
                    // Verificar estructura universal
                    console.log('\n   🔍 Verificando estructura universal de la cola:');
                    const firstItem = pendingRecharges[0];
                    console.log(`   ✓ tipoServicio: ${firstItem.tipoServicio || 'NO DEFINIDO'}`);
                    console.log(`   ✓ diasVigencia: ${firstItem.diasVigencia || 'NO DEFINIDO'}`);
                    console.log(`   ✓ tipo: ${firstItem.tipo || 'NO DEFINIDO'}`);
                    
                    const processedSims = new Set();
                    
                    // Procesar según cantidad (individual vs lote)
                    if (pendingRecharges.length === 1) {
                        console.log('   🔄 SIMULACIÓN: Procesamiento individual...');
                        try {
                            await this.processIndividualRecovery(pendingRecharges[0]);
                            stats.processed++;
                            processedSims.add(pendingRecharges[0].sim);
                            console.log(`   ✅ SIMULACIÓN: Recarga individual ${pendingRecharges[0].sim} procesada`);
                        } catch (error) {
                            stats.failed++;
                            console.error(`   ❌ SIMULACIÓN: Error individual:`, error.message);
                        }
                    } else {
                        console.log(`   🔄 SIMULACIÓN: Procesamiento en lote (${pendingRecharges.length} recargas)...`);
                        try {
                            const batchResult = await this.processBatchRecovery(pendingRecharges);
                            stats.processed = batchResult.processed;
                            stats.failed = batchResult.failed;
                            batchResult.processedSims.forEach(sim => processedSims.add(sim));
                            console.log(`   ✅ SIMULACIÓN: Lote procesado - ${batchResult.processed} exitosas, ${batchResult.failed} fallidas`);
                        } catch (error) {
                            stats.failed = pendingRecharges.length;
                            console.error(`   ❌ SIMULACIÓN: Error en lote:`, error.message);
                        }
                    }
                    
                    // EN SIMULACIÓN: NO modificamos la cola auxiliar
                    console.log(`   🧪 SIMULACIÓN: En producción se eliminarían ${processedSims.size} elementos de la cola`);
                    
                } catch (error) {
                    console.error('   ❌ SIMULACIÓN: Error procesando cola auxiliar:', error.message);
                    stats.failed++;
                }
                
                return stats;
            }
        };
        
        console.log('\n🔄 Iniciando procesamiento de cola auxiliar...');
        
        // Ejecutar el procesamiento (simulado)
        const result = await simulationRecoveryMethods.processAuxiliaryQueueRecharges();
        
        console.log('\n✅ === RESULTADOS DE SIMULACIÓN ===');
        console.log(`📈 Procesadas: ${result.processed}`);
        console.log(`❌ Fallidas: ${result.failed}`);
        
        // Mostrar reporte detallado
        mockDb.printSimulationLog();
        
        // Para simulación, NO removemos elementos de la cola
        console.log('\n🔍 En simulación: La cola auxiliar NO es modificada');
        console.log('📋 En producción, los elementos exitosos serían removidos automáticamente');
        
        console.log('\n🎯 === SIMULACIÓN COMPLETADA ===');
        console.log('💡 La simulación muestra el comportamiento sin afectar datos reales');
        
        return {
            simulationSuccessful: true,
            processedCount: result.processed,
            failedCount: result.failed,
            queuePreserved: true // En simulación siempre se preserva
        };
        
    } catch (error) {
        console.error('❌ Error en simulación:', error.message);
        console.error('🔍 Stack trace:', error.stack);
        return {
            simulationSuccessful: false,
            error: error.message
        };
    }
}

// Ejecutar simulación si se llama directamente
if (require.main === module) {
    runQueueSimulation()
        .then(result => {
            console.log('\n🏁 Simulación terminada');
            process.exit(result.simulationSuccessful ? 0 : 1);
        })
        .catch(error => {
            console.error('💥 Error fatal en simulación:', error);
            process.exit(1);
        });
}

module.exports = { runQueueSimulation, MockDatabase };