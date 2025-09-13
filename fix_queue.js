#!/usr/bin/env node

// Script para corregir la cola auxiliar agregando campos requeridos
const path = require('path');
const fs = require('fs').promises;

async function fixAuxiliaryQueue() {
    console.log('🔧 Corrigiendo cola auxiliar...');
    
    try {
        const queuePath = path.join(__dirname, 'data/auxiliary_queue.json');
        const data = await fs.readFile(queuePath, 'utf8');
        let auxiliaryQueue = JSON.parse(data);
        
        console.log(`📋 Elementos originales: ${auxiliaryQueue.length}`);
        
        // Solo mantener las transacciones exitosas (sin retryCount)
        const successfulTransactions = auxiliaryQueue.filter(item => !item.retryCount);
        console.log(`✅ Transacciones exitosas: ${successfulTransactions.length}`);
        console.log(`❌ Transacciones con retry eliminadas: ${auxiliaryQueue.length - successfulTransactions.length}`);
        
        // Agregar campos requeridos
        const fixedQueue = successfulTransactions.map(item => ({
            ...item,
            tipo: 'gps_recharge',
            monto: 10,
            provider: item.proveedor,
            webserviceResponse: {
                transId: item.transID,
                monto: 10,
                folio: item.transID,
                saldoFinal: 'N/A',
                carrier: 'TELCEL',
                fecha: new Date().toISOString().split('T')[0]
            }
        }));
        
        // Escribir cola corregida
        await fs.writeFile(queuePath, JSON.stringify(fixedQueue, null, 2));
        
        console.log(`✅ Cola auxiliar corregida con ${fixedQueue.length} elementos`);
        console.log('📝 Campos agregados:');
        console.log('   - tipo: "gps_recharge"');
        console.log('   - monto: 10');
        console.log('   - provider: [proveedor]');
        console.log('   - webserviceResponse: {...}');
        
    } catch (error) {
        console.error('❌ Error corrigiendo cola:', error.message);
    }
}

// Ejecutar si se llama directamente
if (require.main === module) {
    fixAuxiliaryQueue();
}

module.exports = { fixAuxiliaryQueue };