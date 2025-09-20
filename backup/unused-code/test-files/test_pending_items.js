// Test para verificar detección de items pendientes
const fs = require('fs');

console.log('🔍 Probando detección de items pendientes...');

// Simular data de colas auxiliares
const eliotQueue = JSON.parse(fs.readFileSync('data/eliot_auxiliary_queue.json', 'utf8'));
const gpsQueue = JSON.parse(fs.readFileSync('data/gps_auxiliary_queue.json', 'utf8'));

console.log('📊 Estado de colas:');
console.log(`   ELIoT: ${eliotQueue.length} items`);
console.log(`   GPS: ${gpsQueue.length} items`);

// Simular función checkPendingItems ANTIGUA (con bug)
function checkPendingItemsOLD(serviceType, auxiliaryQueue) {
    return auxiliaryQueue.filter(item =>
        item.tipo === `${serviceType.toLowerCase()}_recharge` &&
        item.status &&
        item.status.includes('pending')
    );
}

// Simular función checkPendingItems NUEVA (arreglada)
function checkPendingItemsNEW(serviceType, auxiliaryQueue) {
    return auxiliaryQueue.filter(item =>
        item.tipo === `${serviceType}_recharge` &&
        item.status &&
        item.status.includes('pending')
    );
}

console.log('\n🔧 Comparación OLD vs NEW:');

// Test para ELIoT
const eliotOld = checkPendingItemsOLD('ELIoT', eliotQueue);
const eliotNew = checkPendingItemsNEW('ELIoT', eliotQueue);

console.log(`\n📱 ELIoT:`);
console.log(`   OLD (bug): ${eliotOld.length} items encontrados`);
console.log(`   NEW (fix): ${eliotNew.length} items encontrados`);
console.log(`   Primeros tipos en cola: ${eliotQueue.slice(0, 3).map(i => i.tipo).join(', ')}`);

// Test para GPS
const gpsOld = checkPendingItemsOLD('gps', gpsQueue);
const gpsNew = checkPendingItemsNEW('gps', gpsQueue);

console.log(`\n🛰️ GPS:`);
console.log(`   OLD (bug): ${gpsOld.length} items encontrados`);
console.log(`   NEW (fix): ${gpsNew.length} items encontrados`);
console.log(`   Primeros tipos en cola: ${gpsQueue.slice(0, 3).map(i => i.tipo).join(', ')}`);

console.log('\n✅ Test completado');