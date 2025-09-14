const { mockSequelizeConnection, mockRedisClient, resetAllMocks } = require('../mocks/mockDB');
const { mockWebserviceClient } = require('../mocks/mockWebservices');

// Mock dependencies completamente
jest.mock('../../lib/webservices/WebserviceClient', () => ({
    WebserviceClient: mockWebserviceClient
}));

const { GPSRechargeProcessor } = require('../../lib/processors/GPSRechargeProcessor');

jest.mock('../../config/services', () => ({
    GPS: {
        IMPORTE: 10,
        DIAS: 8,
        DELAY_BETWEEN_CALLS: 500,
        MAX_RETRIES: 3,
        MIN_BALANCE_THRESHOLD: 50,
        DIAS_SIN_REPORTAR_LIMITE: 14,
        MINUTOS_SIN_REPORTAR_PARA_RECARGA: 10
    }
}));

describe('GPSRechargeProcessor Integration Tests', () => {
    let processor;
    let mockLockManager;
    let mockPersistenceQueue;

    beforeEach(() => {
        resetAllMocks();
        mockWebserviceClient.resetMocks();
        
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
        
        const dbConnections = {
            GPS_DB: mockSequelizeConnection
        };
        
        processor = new GPSRechargeProcessor(dbConnections, mockLockManager, mockPersistenceQueue);
    });

    describe('Complete GPS Recharge Flow', () => {
        test('should process GPS records end-to-end successfully', async () => {
            // Setup mock data
            const mockRecords = [
                {
                    sim: '6682276907',
                    descripcion: 'R637',
                    empresa: 'EMPRESA TEST',
                    dispositivo: '863940058426845',
                    importe: 10,
                    dias_saldo: -1,
                    ultimo_registro: Date.now() - (15 * 60 * 1000) // 15 minutos atrás
                }
            ];

            // Mock database query para getRecordsToProcess
            mockSequelizeConnection.querySequelize.mockResolvedValueOnce(mockRecords);
            
            // Mock successful webservice call
            const webserviceResponse = {
                transId: '250900894447',
                monto: 10,
                folio: '572524',
                saldoFinal: '$96,170.00',
                carrier: 'Telcel',
                fecha: '2025-09-13 15:04:46',
                response: {
                    Timeout: '1.86',
                    IP: '187.137.101.185'
                }
            };
            
            mockWebserviceClient.rechargeGPSTaecel.mockResolvedValueOnce(webserviceResponse);

            // Mock insertBatchRecharges success
            mockSequelizeConnection.querySequelize
                .mockResolvedValueOnce([12345]) // Insert master record
                .mockResolvedValue(true); // Insert detail records and updates

            // Execute
            const result = await processor.process();

            // Verify results
            expect(result.processed).toBe(1);
            expect(result.success).toBe(1);
            expect(result.failed).toBe(0);

            // Verify webservice was called
            expect(mockWebserviceClient.rechargeGPSTaecel).toHaveBeenCalledWith({
                sim: '6682276907',
                monto: 10,
                codigo: 'TEL010'
            });

            // Verify database operations
            expect(mockSequelizeConnection.querySequelize).toHaveBeenCalledTimes(4); // getRecords + insertBatch (master + detail + update)
        });

        test('should handle webservice errors gracefully', async () => {
            const mockRecords = [{
                sim: '6682276907',
                descripcion: 'R637',
                empresa: 'EMPRESA TEST',
                dispositivo: '863940058426845',
                importe: 10,
                dias_saldo: -1,
                ultimo_registro: Date.now() - (15 * 60 * 1000)
            }];

            mockSequelizeConnection.querySequelize.mockResolvedValueOnce(mockRecords);
            
            // Simulate webservice error
            mockWebserviceClient.rechargeGPSTaecel.mockRejectedValueOnce(
                new Error('Saldo insuficiente')
            );

            const result = await processor.process();

            expect(result.processed).toBe(0);
            expect(result.success).toBe(0);
            expect(result.failed).toBe(0); // Error handling prevents failed count
        });

        test('should process auxiliary queue with batch processing', async () => {
            const mockAuxiliaryRecharges = [
                {
                    sim: '6682276907',
                    tipo: 'gps_recharge',
                    status: 'webservice_success_pending_db',
                    webserviceResponse: {
                        transId: '250900894447',
                        folio: '572524',
                        saldoFinal: '$96,170.00'
                    },
                    record: {
                        descripcion: 'R637',
                        empresa: 'EMPRESA TEST',
                        dispositivo: '863940058426845'
                    },
                    importe: 10
                },
                {
                    sim: '6683205808',
                    tipo: 'gps_recharge',
                    status: 'webservice_success_pending_db',
                    webserviceResponse: {
                        transId: '250900894450',
                        folio: '562981',
                        saldoFinal: '$96,160.00'
                    },
                    record: {
                        descripcion: 'RANGER',
                        empresa: 'EMPRESA TEST 2',
                        dispositivo: '354017110842206'
                    },
                    importe: 10
                }
            ];

            mockPersistenceQueue.auxiliaryQueue = mockAuxiliaryRecharges;
            mockPersistenceQueue.getQueueStats.mockReturnValue({
                auxiliaryQueue: { pendingDb: 2 }
            });

            // Mock successful batch insert
            mockSequelizeConnection.querySequelize
                .mockResolvedValueOnce([12346]) // Master record
                .mockResolvedValue(true); // Detail records and updates

            // Mock empty getRecordsToProcess since we're testing recovery
            mockSequelizeConnection.querySequelize.mockResolvedValueOnce([]);

            const result = await processor.process();

            expect(result.processed).toBe(2); // Both auxiliary records processed
            expect(mockPersistenceQueue.saveAuxiliaryQueue).toHaveBeenCalled();
        });
    });

    describe('Error Scenarios', () => {
        test('should handle lock acquisition failure', async () => {
            mockLockManager.acquireLock.mockResolvedValueOnce({ success: false });

            const result = await processor.process();

            expect(result).toEqual({ processed: 0, success: 0, failed: 0 });
            expect(mockLockManager.releaseLock).not.toHaveBeenCalled();
        });

        test('should handle database connection errors', async () => {
            mockSequelizeConnection.querySequelize.mockRejectedValueOnce(
                new Error('Database connection failed')
            );

            const result = await processor.process();

            expect(result.processed).toBe(0);
            expect(mockLockManager.releaseLock).toHaveBeenCalled(); // Lock should still be released
        });
    });

    describe('Performance Tests', () => {
        test('should process multiple records efficiently', async () => {
            const recordCount = 50;
            const mockRecords = Array.from({ length: recordCount }, (_, i) => ({
                sim: `668227690${i}`,
                descripcion: `DEVICE_${i}`,
                empresa: `EMPRESA_${i}`,
                dispositivo: `86394005842684${i}`,
                importe: 10,
                dias_saldo: -1,
                ultimo_registro: Date.now() - (15 * 60 * 1000)
            }));

            mockSequelizeConnection.querySequelize.mockResolvedValueOnce(mockRecords);
            
            // Mock webservice responses
            for (let i = 0; i < recordCount; i++) {
                mockWebserviceClient.rechargeGPSTaecel.mockResolvedValueOnce({
                    transId: `25090089444${i}`,
                    folio: `57252${i}`,
                    saldoFinal: '$96,170.00'
                });
            }

            const startTime = Date.now();
            const result = await processor.process();
            const duration = Date.now() - startTime;

            expect(result.processed).toBe(recordCount);
            expect(duration).toBeLessThan(30000); // Should complete within 30 seconds
        }, 35000); // Set test timeout to 35 seconds
    });
});