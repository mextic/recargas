#!/usr/bin/env node

// Modo de prueba para recuperación sin insertar en BD
const path = require('path');
const fs = require('fs').promises;

async function testRecovery() {
    console.log('🧪 MODO DE PRUEBA - Sin insertar en BD');
    console.log('=====================================');
    
    try {
        // Leer cola auxiliar
        const queuePath = path.join(__dirname, 'data/auxiliary_queue.json');
        const data = await fs.readFile(queuePath, 'utf8');
        let auxiliaryQueue = JSON.parse(data);
        
        // Agregar campos requeridos simulados
        auxiliaryQueue = auxiliaryQueue.map(item => ({
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
        
        console.log(`📋 Elementos en cola auxiliar: ${auxiliaryQueue.length}`);
        
        const pendingRecharges = auxiliaryQueue.filter(item => 
            item.tipo === 'gps_recharge' && 
            item.status === 'webservice_success_pending_db'
        );
        
        console.log(`🔄 Recargas pendientes: ${pendingRecharges.length}`);
        
        if (pendingRecharges.length === 0) {
            console.log('✅ No hay recargas pendientes');
            return;
        }
        
        // Simular procesamiento
        if (pendingRecharges.length === 1) {
            console.log('🔄 Simulando recuperación individual...');
            await simulateIndividualRecovery(pendingRecharges[0]);
        } else {
            console.log('🔄 Simulando recuperación en lote...');
            await simulateBatchRecovery(pendingRecharges);
        }
        
        console.log('✅ Simulación completada');
        
    } catch (error) {
        console.error('❌ Error en simulación:', error.message);
    }
}

async function simulateIndividualRecovery(recharge) {
    console.log('   📝 Datos para recuperación individual:');
    console.log(`   - SIM: ${recharge.sim}`);
    console.log(`   - Vehículo: ${recharge.vehiculo}`);
    console.log(`   - Empresa: ${recharge.empresa}`);
    console.log(`   - TransID: ${recharge.transID}`);
    console.log(`   - Monto: $${recharge.monto}`);
    
    // Simular nota de recuperación
    const recoveryNote = `< RECUPERACIÓN > [ 001 / 001 ] ${recharge.vehiculo} [${recharge.empresa}] - Recarga Automática **** 000 Pendientes al Finalizar el Día **** [ 0 Reportando en Tiempo y Forma ] (1 procesados de 1 total)`;
    
    console.log('   📄 Nota que se insertaría:');
    console.log(`   "${recoveryNote}"`);
    
    // Simular detalle
    console.log('   💾 Detalle que se insertaría:');
    console.log(`   - ID Recarga: [SIMULADO]`);
    console.log(`   - SIM: ${recharge.sim}`);
    console.log(`   - Importe: $${recharge.monto}`);
    console.log(`   - Vehículo: ${recharge.vehiculo}`);
    console.log(`   - Folio: ${recharge.transID}`);
    
    console.log('   ✅ Recuperación individual simulada');
}

async function simulateBatchRecovery(recharges) {
    const totalAmount = recharges.reduce((sum, r) => sum + r.monto, 0);
    const successCount = recharges.length;
    const paddedSuccess = String(successCount).padStart(3, '0');
    const paddedTotal = String(successCount).padStart(3, '0');
    
    console.log('   📝 Datos para recuperación en lote:');
    console.log(`   - Total recargas: ${successCount}`);
    console.log(`   - Monto total: $${totalAmount}`);
    console.log(`   - Proveedor: ${recharges[0].proveedor}`);
    
    const batchNote = `< RECUPERACIÓN > [ ${paddedSuccess} / ${paddedTotal} ] Recarga Automática **** 000 Pendientes al Finalizar el Día **** [ 0 Reportando en Tiempo y Forma ] (${successCount} procesados de ${successCount} total)`;
    
    console.log('   📄 Nota maestra que se insertaría:');
    console.log(`   "${batchNote}"`);
    
    console.log('   💾 Detalles que se insertarían:');
    recharges.forEach((recharge, index) => {
        console.log(`   ${index + 1}. SIM: ${recharge.sim} - ${recharge.vehiculo} - $${recharge.monto} - Folio: ${recharge.transID}`);
    });
    
    console.log('   ✅ Recuperación en lote simulada');
}

// Ejecutar si se llama directamente
if (require.main === module) {
    testRecovery();
}

module.exports = { testRecovery };