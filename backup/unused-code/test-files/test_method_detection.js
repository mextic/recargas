const { GPSRechargeProcessor } = require('./lib/processors/GPSRechargeProcessor');
const { ELIoTRechargeProcessor } = require('./lib/processors/ELIoTRechargeProcessor');

console.log('🔍 Testing method detection...');

// Mock dependencies
const mockDb = {};
const mockLockManager = {};
const mockPersistenceQueue = {};

try {
    const gpsProcessor = new GPSRechargeProcessor(mockDb, mockLockManager, mockPersistenceQueue);
    const eliotProcessor = new ELIoTRechargeProcessor(mockDb, mockLockManager, mockPersistenceQueue);

    console.log('\n📊 GPS Processor:');
    console.log('Has method:', !!gpsProcessor.insertBatchRechargesWithDuplicateHandling);
    console.log('Method type:', typeof gpsProcessor.insertBatchRechargesWithDuplicateHandling);
    console.log('Prototype keys:', Object.getOwnPropertyNames(Object.getPrototypeOf(gpsProcessor)));

    console.log('\n📊 ELIoT Processor:');
    console.log('Has method:', !!eliotProcessor.insertBatchRechargesWithDuplicateHandling);
    console.log('Method type:', typeof eliotProcessor.insertBatchRechargesWithDuplicateHandling);
    console.log('Prototype keys:', Object.getOwnPropertyNames(Object.getPrototypeOf(eliotProcessor)));

} catch (error) {
    console.error('❌ Error:', error.message);
}