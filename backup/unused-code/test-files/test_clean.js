// Test clean truncated version
const { GPSRechargeProcessor } = require('./lib/processors/GPSRechargeProcessor_clean');

console.log('🔍 Testing clean truncated GPSRechargeProcessor...');

const mockDb = {};
const mockLockManager = {};
const mockPersistenceQueue = {};

try {
    const gpsProcessor = new GPSRechargeProcessor(mockDb, mockLockManager, mockPersistenceQueue);
    const prototypeMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(gpsProcessor));

    console.log('✅ Clean truncated version loaded successfully');
    console.log('📊 Prototype methods count:', prototypeMethods.length);

    // Verificar específicamente el último método que funciona
    const hasInsertBatchRecharges = prototypeMethods.includes('insertBatchRecharges');
    console.log('🎯 insertBatchRecharges found:', hasInsertBatchRecharges);

    if (hasInsertBatchRecharges) {
        console.log('✅ insertBatchRecharges method exists in clean version!');
    }

} catch (error) {
    console.error('❌ Error with clean truncated version:', error.message);
}