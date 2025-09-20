// Test truncated version
const { GPSRechargeProcessor } = require('./lib/processors/GPSRechargeProcessor_truncated');

console.log('🔍 Testing truncated GPSRechargeProcessor...');

const mockDb = {};
const mockLockManager = {};
const mockPersistenceQueue = {};

try {
    const gpsProcessor = new GPSRechargeProcessor(mockDb, mockLockManager, mockPersistenceQueue);
    const prototypeMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(gpsProcessor));

    console.log('✅ Truncated version loaded successfully');
    console.log('📊 Prototype methods count:', prototypeMethods.length);
    console.log('🔧 Methods:', prototypeMethods);

} catch (error) {
    console.error('❌ Error with truncated version:', error.message);
}