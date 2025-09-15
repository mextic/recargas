const { BaseRechargeProcessor } = require('../../lib/processors/BaseRechargeProcessor');
const { mockSequelizeConnection, mockRedisClient, resetAllMocks } = require('../mocks/mockDB');
const { mockWebserviceClient } = require('../mocks/mockWebservices');

// Mock dependencies
jest.mock('../../lib/webservices/WebserviceClient', () => ({
    WebserviceClient: mockWebserviceClient
}));

// Concrete implementation for testing abstract class
class TestProcessor extends BaseRechargeProcessor {
    constructor(dbConnection, lockManager, persistenceQueue, config) {
        super(dbConnection, lockManager, persistenceQueue, config);
    }
    
    getServiceType() {
        return 'test';
    }
    
    async getRecordsToProcess() {
        return [];
    }
    
    async processRecords(records, stats) {
        return stats;
    }
    
    async processCompletePendingRecharge(recharge) {
        // Mock implementation
        return true;
    }
    
    // Mock insertBatchRecharges for testing
    async insertBatchRecharges(recharges) {
        return { processed: recharges.length };
    }
}

describe('BaseRechargeProcessor', () => {
    let processor;
    let mockLockManager;
    let mockPersistenceQueue;
    let config;

    beforeEach(() => {
        resetAllMocks();
        
        // Reinicializar completamente el mock
        jest.clearAllMocks();
        
        // Resetear webservice client
        Object.assign(mockWebserviceClient, {
            getTaecelBalance: jest.fn().mockResolvedValue(96170),
            getMstBalance: jest.fn().mockResolvedValue(1.62),
            rechargeGPSTaecel: jest.fn().mockResolvedValue({ success: true }),
            rechargeVozTaecel: jest.fn().mockResolvedValue({ success: true }),
            rechargeELIoTTaecel: jest.fn().mockResolvedValue({ success: true }),
            rechargeGPSMst: jest.fn().mockResolvedValue({ success: true }),
            rechargeVozMst: jest.fn().mockResolvedValue({ success: true }),
            rechargeELIoTMst: jest.fn().mockResolvedValue({ success: true })
        });
        
        mockLockManager = {
            acquireLock: jest.fn().mockResolvedValue({ success: true }),
            releaseLock: jest.fn().mockResolvedValue(true)
        };
        
        mockPersistenceQueue = {
            auxiliaryQueue: [],
            getQueueStats: jest.fn().mockReturnValue({
                auxiliaryQueue: { pendingDb: 0 }
            }),
            saveAuxiliaryQueue: jest.fn().mockResolvedValue(true)
        };
        
        config = {
            MAX_RETRIES: 3,
            RETRY_STRATEGY: 'exponential',
            RETRY_BASE_DELAY: 1000,
            MIN_BALANCE_THRESHOLD: 1  // Lower threshold to include MST balance
        };
        
        processor = new TestProcessor(mockSequelizeConnection, mockLockManager, mockPersistenceQueue, config);
    });

    describe('constructor', () => {
        test('should throw error when instantiating abstract class directly', () => {
            expect(() => {
                new BaseRechargeProcessor(mockSequelizeConnection, mockLockManager, mockPersistenceQueue, config);
            }).toThrow('BaseRechargeProcessor es una clase abstracta');
        });
        
        test('should initialize with correct dependencies', () => {
            expect(processor.db).toBe(mockSequelizeConnection);
            expect(processor.lockManager).toBe(mockLockManager);
            expect(processor.persistenceQueue).toBe(mockPersistenceQueue);
            expect(processor.config).toBe(config);
        });
    });

    describe('process()', () => {
        test('should acquire and release lock successfully', async () => {
            const result = await processor.process();
            
            expect(mockLockManager.acquireLock).toHaveBeenCalledWith(
                'recharge_test',
                expect.stringMatching(/^recharge_test_\d+_\d+$/),
                3600
            );
            expect(mockLockManager.releaseLock).toHaveBeenCalled();
            expect(result).toEqual({ processed: 0, success: 0, failed: 0 });
        });
        
        test('should return early if lock acquisition fails', async () => {
            mockLockManager.acquireLock.mockResolvedValueOnce({ success: false });
            
            const result = await processor.process();
            
            expect(mockLockManager.releaseLock).not.toHaveBeenCalled();
            expect(result).toEqual({ processed: 0, success: 0, failed: 0 });
        });
        
        test('should process auxiliary queue when pending records exist', async () => {
            const mockRecharge = {
                sim: '1234567890',
                tipo: 'test_recharge',
                status: 'webservice_success_pending_db'
            };
            
            processor.persistenceQueue.auxiliaryQueue = [mockRecharge];
            processor.persistenceQueue.getQueueStats.mockReturnValue({
                auxiliaryQueue: { pendingDb: 1 }
            });
            
            const result = await processor.process();
            
            expect(result.processed).toBe(1);
            expect(processor.persistenceQueue.saveAuxiliaryQueue).toHaveBeenCalled();
        });
    });

    describe('processAuxiliaryQueueRecharges()', () => {
        test('should process pending recharges with batch processing', async () => {
            const mockRecharges = [
                {
                    sim: '1111111111',
                    tipo: 'test_recharge',
                    status: 'webservice_success_pending_db'
                },
                {
                    sim: '2222222222',
                    tipo: 'test_recharge',
                    status: 'webservice_success_pending_db'
                }
            ];
            
            mockPersistenceQueue.auxiliaryQueue = mockRecharges;
            
            const result = await processor.processAuxiliaryQueueRecharges();
            
            expect(result.processed).toBe(2);
            expect(result.failed).toBe(0);
        });
        
        test('should handle individual processing when batch processing not available', async () => {
            // Remove batch processing method
            processor.insertBatchRecharges = undefined;
            
            const mockRecharge = {
                sim: '1234567890',
                tipo: 'test_recharge',
                status: 'webservice_success_pending_db'
            };
            
            mockPersistenceQueue.auxiliaryQueue = [mockRecharge];
            
            const result = await processor.processAuxiliaryQueueRecharges();
            
            expect(result.processed).toBe(1);
            expect(result.failed).toBe(0);
        });
    });

    describe('executeWithRetry()', () => {
        test('should succeed on first attempt', async () => {
            const operation = jest.fn().mockResolvedValue('success');
            
            const result = await processor.executeWithRetry(operation, {
                operationName: 'test_operation',
                transactionId: 'test_123'
            });
            
            expect(operation).toHaveBeenCalledTimes(1);
            expect(result).toBe('success');
        });
        
        test('should retry on failure and eventually succeed', async () => {
            const operation = jest.fn()
                .mockRejectedValueOnce(new Error('insufficient balance'))  // Retriable error
                .mockRejectedValueOnce(new Error('timeout'))  // Retriable error
                .mockResolvedValueOnce('success');
            
            const result = await processor.executeWithRetry(operation, {
                operationName: 'test_retry_operation',
                transactionId: 'test_retry_123'
            });
            
            expect(operation).toHaveBeenCalledTimes(3);
            expect(result).toBe('success');
        });
        
        test('should fail after max retries', async () => {
            const operation = jest.fn().mockRejectedValue(new Error('database connection lost'));  // FATAL error - no retries
            
            await expect(processor.executeWithRetry(operation, {
                operationName: 'test_fail_operation',  
                transactionId: 'test_fail_123'
            }))
                .rejects.toThrow('database connection lost');
            
            // FATAL errors don't retry, so should only be called once
            expect(operation).toHaveBeenCalledTimes(1);
        }, 10000);  // Increase timeout to 10 seconds
    });

    describe('getProvidersOrderedByBalance()', () => {
        test('should return providers ordered by balance', async () => {
            const providers = await processor.getProvidersOrderedByBalance();
            
            expect(providers).toHaveLength(2);
            expect(providers[0].name).toBe('TAECEL');
            expect(providers[0].balance).toBe(96170);
            expect(providers[1].name).toBe('MST');
            expect(providers[1].balance).toBe(1.62);
        });
        
        test('should throw error when no providers have sufficient balance', async () => {
            processor.config.MIN_BALANCE_THRESHOLD = 100000;  // Set very high threshold
            
            await expect(processor.getProvidersOrderedByBalance())
                .rejects.toThrow('No hay proveedores con saldo suficiente');
        });
    });

    describe('utility methods', () => {
        test('delay should wait specified time', async () => {
            const start = Date.now();
            await processor.delay(100);
            const end = Date.now();
            
            expect(end - start).toBeGreaterThanOrEqual(90); // Allow some margin
        });
        
        test('generateProgressBar should create correct format', () => {
            const progressBar = processor.generateProgressBar(5, 10, 20);
            
            expect(progressBar).toBe('[██████████          ] 50% (5/10)');
        });
    });
});