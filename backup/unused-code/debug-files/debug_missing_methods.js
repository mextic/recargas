const { GPSRechargeProcessor } = require('./lib/processors/GPSRechargeProcessor');

console.log('🔍 Verificando métodos GPS específicos...');

// Mock dependencies
const mockDb = {};
const mockLockManager = {};
const mockPersistenceQueue = {};

try {
    const gpsProcessor = new GPSRechargeProcessor(mockDb, mockLockManager, mockPersistenceQueue);
    const prototypeMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(gpsProcessor));

    // Lista de métodos que deberían existir según grep
    const expectedMethods = [
        'insertNormalRecharge',
        'processCompletePendingRecharge',
        'getRecordDataForRecovery',
        'insertBatchRechargesWithDuplicateHandling',
        'handleProcessingError',
        'sendHighErrorRateAlert',
        'sendCriticalErrorAlert',
        'recordSLAMetrics',
        'sendProcessingSummaryAlert',
        'saveGPSAnalytics'
    ];

    console.log('\n📊 Verificación de métodos:');
    expectedMethods.forEach(method => {
        const exists = prototypeMethods.includes(method);
        console.log(`   ${exists ? '✅' : '❌'} ${method}: ${exists ? 'FOUND' : 'MISSING'}`);
    });

    console.log('\n🔍 Métodos que faltan:');
    const missing = expectedMethods.filter(method => !prototypeMethods.includes(method));
    missing.forEach(method => console.log(`   - ${method}`));

} catch (error) {
    console.error('❌ Error:', error.message);
}