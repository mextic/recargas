/**
 * Integration Tests for Enhanced Service Architecture
 * Comprehensive testing of service registry, factory, orchestration, and scheduling
 */

const { beforeAll, beforeEach, afterAll, afterEach, describe, test, expect, jest } = require('@jest/globals');

// Service architecture components
const ServiceRegistry = require('../../lib/services/ServiceRegistry');
const ServiceFactory = require('../../lib/services/ServiceFactory');
const EnhancedOrchestrator = require('../../lib/orchestration/EnhancedOrchestrator');
const AdaptiveScheduler = require('../../lib/scheduling/AdaptiveScheduler');
const ServiceHealthMonitor = require('../../lib/monitoring/ServiceHealthMonitor');
const UnifiedServiceAnalytics = require('../../lib/analytics/UnifiedServiceAnalytics');

// Configuration
const architectureConfig = require('../../config/architecture');
const serviceConfig = require('../../config/services');

// Mock dependencies
const mockDb = {
    authenticate: jest.fn().mockResolvedValue(true),
    querySequelize: jest.fn().mockResolvedValue([]),
    getSequelizeClient: jest.fn().mockReturnValue({
        QueryTypes: { SELECT: 'SELECT' }
    })
};

const mockLockManager = {
    acquireLock: jest.fn().mockResolvedValue(true),
    releaseLock: jest.fn().mockResolvedValue(true),
    setDbConnection: jest.fn()
};

const mockPersistenceQueue = {
    add: jest.fn().mockResolvedValue(true),
    initialize: jest.fn().mockResolvedValue(true),
    getQueueStats: jest.fn().mockResolvedValue({
        auxiliaryQueue: { pendingDb: 0 }
    })
};

const mockAlertManager = {
    initialize: jest.fn().mockResolvedValue(true),
    sendAlert: jest.fn().mockResolvedValue(true)
};

const mockSLAMonitor = {
    recordMetric: jest.fn()
};

// Mock service processor
class MockServiceProcessor {
    constructor(dbConnection, lockManager, persistenceQueue) {
        this.dbConnection = dbConnection;
        this.lockManager = lockManager;
        this.persistenceQueue = persistenceQueue;
        this.config = serviceConfig.GPS;
    }

    getServiceType() {
        return 'gps';
    }

    async processRecharges() {
        return {
            totalProcessed: 5,
            successful: 5,
            failed: 0
        };
    }

    async healthCheck() {
        return {
            status: 'healthy',
            responseTime: 100
        };
    }
}

describe('Service Architecture Integration Tests', () => {
    let serviceRegistry;
    let serviceFactory;
    let enhancedOrchestrator;
    let adaptiveScheduler;
    let serviceHealthMonitor;
    let unifiedAnalytics;

    const mockDependencies = {
        dbConnection: mockDb,
        dbConnections: { GPS_DB: mockDb, ELIOT_DB: mockDb },
        lockManager: mockLockManager,
        persistenceQueue: mockPersistenceQueue,
        alertManager: mockAlertManager,
        slaMonitor: mockSLAMonitor
    };

    beforeAll(async () => {
        // Setup test environment
        process.env.NODE_ENV = 'test';
        process.env.USE_ENHANCED_ARCHITECTURE = 'true';
    });

    beforeEach(async () => {
        // Clear all mocks
        jest.clearAllMocks();

        // Initialize components fresh for each test
        serviceRegistry = new ServiceRegistry();
        serviceFactory = new ServiceFactory(serviceRegistry, mockDependencies);
        enhancedOrchestrator = new EnhancedOrchestrator({
            maxConcurrentServices: 3,
            performanceMonitoringEnabled: true
        });
        adaptiveScheduler = new AdaptiveScheduler(serviceRegistry);
        serviceHealthMonitor = new ServiceHealthMonitor(
            serviceRegistry,
            mockAlertManager,
            mockSLAMonitor
        );
        unifiedAnalytics = new UnifiedServiceAnalytics(
            { GPS_DB: mockDb, ELIOT_DB: mockDb },
            serviceRegistry
        );
    });

    afterEach(async () => {
        // Cleanup after each test
        if (adaptiveScheduler) {
            await adaptiveScheduler.shutdown();
        }
        if (enhancedOrchestrator) {
            await enhancedOrchestrator.shutdown();
        }
        if (serviceHealthMonitor) {
            await serviceHealthMonitor.stopMonitoring();
        }
    });

    describe('ServiceRegistry', () => {
        test('should initialize with default services', () => {
            const services = serviceRegistry.getAllServices();

            expect(services.length).toBeGreaterThan(0);
            expect(services.some(s => s.key === 'gps')).toBe(true);
            expect(services.some(s => s.key === 'voz')).toBe(true);
            expect(services.some(s => s.key === 'eliot')).toBe(true);
        });

        test('should register service instances', () => {
            const mockInstance = new MockServiceProcessor(mockDb, mockLockManager, mockPersistenceQueue);

            const instanceId = serviceRegistry.registerServiceInstance('gps', mockInstance);

            expect(instanceId).toBeDefined();
            expect(typeof instanceId).toBe('string');
            expect(instanceId.startsWith('gps_')).toBe(true);
        });

        test('should get optimal service instance', () => {
            const mockInstance = new MockServiceProcessor(mockDb, mockLockManager, mockPersistenceQueue);
            const instanceId = serviceRegistry.registerServiceInstance('gps', mockInstance);

            const optimalService = serviceRegistry.getOptimalService('gps');

            expect(optimalService).toBeDefined();
            expect(optimalService.instanceId).toBe(instanceId);
            expect(optimalService.instance).toBe(mockInstance);
        });

        test('should update service health', () => {
            const healthData = {
                status: 'healthy',
                responseTime: 150,
                details: { test: true }
            };

            serviceRegistry.updateServiceHealth('gps', healthData);

            const health = serviceRegistry.getServiceHealth('gps');
            expect(health.status).toBe('healthy');
            expect(health.lastCheck).toBeDefined();
        });

        test('should provide registry statistics', () => {
            const stats = serviceRegistry.getStats();

            expect(stats).toHaveProperty('serviceTypes');
            expect(stats).toHaveProperty('totalInstances');
            expect(stats).toHaveProperty('healthyServices');
            expect(stats.serviceTypes).toBeGreaterThan(0);
        });
    });

    describe('ServiceFactory', () => {
        test('should create service instances with proper configuration', async () => {
            const serviceInstance = await serviceFactory.createService('gps');

            expect(serviceInstance).toBeDefined();
            expect(serviceInstance.instance).toBeDefined();
            expect(serviceInstance.instanceId).toBeDefined();
            expect(serviceInstance.serviceKey).toBe('gps');
            expect(serviceInstance.configuration).toBeDefined();
        });

        test('should validate service dependencies', async () => {
            // Should not throw for valid dependencies
            await expect(serviceFactory.createService('gps')).resolves.toBeDefined();
        });

        test('should handle custom configuration', async () => {
            const customConfig = {
                SCHEDULE_MINUTES: 5,
                TEST_SETTING: true
            };

            const serviceInstance = await serviceFactory.createService('gps', customConfig);

            expect(serviceInstance.configuration.SCHEDULE_MINUTES).toBe(5);
            expect(serviceInstance.configuration.TEST_SETTING).toBe(true);
        });

        test('should create service clusters', async () => {
            const cluster = await serviceFactory.createServiceCluster('gps', 3);

            expect(cluster).toHaveLength(3);
            cluster.forEach(serviceInstance => {
                expect(serviceInstance.serviceKey).toBe('gps');
                expect(serviceInstance.instance).toBeDefined();
            });
        });

        test('should destroy service instances', async () => {
            const serviceInstance = await serviceFactory.createService('gps');
            const { instanceId } = serviceInstance;

            const destroyed = await serviceFactory.destroyService(instanceId);

            expect(destroyed).toBe(true);
        });

        test('should provide factory statistics', () => {
            const stats = serviceFactory.getStats();

            expect(stats).toHaveProperty('totalInstances');
            expect(stats).toHaveProperty('pooledInstances');
            expect(stats).toHaveProperty('serviceTypes');
        });
    });

    describe('EnhancedOrchestrator', () => {
        beforeEach(async () => {
            await enhancedOrchestrator.initialize(mockDependencies);
        });

        test('should initialize successfully', () => {
            expect(enhancedOrchestrator.isInitialized).toBe(true);
        });

        test('should start and execute services', async () => {
            // Mock a successful service execution
            const mockServiceInstance = {
                instance: new MockServiceProcessor(mockDb, mockLockManager, mockPersistenceQueue),
                instanceId: 'test_instance',
                serviceKey: 'gps'
            };

            serviceRegistry.registerServiceInstance('gps', mockServiceInstance.instance);

            const execution = await enhancedOrchestrator.startService('gps');

            expect(execution).toBeDefined();
            expect(execution.status).toBe('completed');
        });

        test('should handle concurrent service execution', async () => {
            const mockServiceInstance = {
                instance: new MockServiceProcessor(mockDb, mockLockManager, mockPersistenceQueue),
                instanceId: 'test_instance',
                serviceKey: 'gps'
            };

            serviceRegistry.registerServiceInstance('gps', mockServiceInstance.instance);

            const executions = await Promise.allSettled([
                enhancedOrchestrator.startService('gps'),
                enhancedOrchestrator.startService('gps'),
                enhancedOrchestrator.startService('gps')
            ]);

            expect(executions.every(e => e.status === 'fulfilled')).toBe(true);
        });

        test('should provide orchestrator statistics', () => {
            const stats = enhancedOrchestrator.getStats();

            expect(stats).toHaveProperty('initialized');
            expect(stats).toHaveProperty('uptime');
            expect(stats).toHaveProperty('activeServices');
            expect(stats).toHaveProperty('serviceRegistry');
        });
    });

    describe('AdaptiveScheduler', () => {
        beforeEach(async () => {
            // Add a mock service instance for scheduling tests
            const mockInstance = new MockServiceProcessor(mockDb, mockLockManager, mockPersistenceQueue);
            serviceRegistry.registerServiceInstance('gps', mockInstance);
        });

        test('should schedule services with different configurations', async () => {
            const scheduleId = await adaptiveScheduler.scheduleService('gps', {
                type: 'interval',
                minutes: 10
            });

            expect(scheduleId).toBeDefined();
            expect(typeof scheduleId).toBe('string');
        });

        test('should handle multiple scheduled services', async () => {
            const gpsScheduleId = await adaptiveScheduler.scheduleService('gps', {
                type: 'interval',
                minutes: 10
            });

            // Add mock instances for other services
            const vozInstance = new MockServiceProcessor(mockDb, mockLockManager, mockPersistenceQueue);
            vozInstance.getServiceType = () => 'voz';
            serviceRegistry.registerServiceInstance('voz', vozInstance);

            const vozScheduleId = await adaptiveScheduler.scheduleService('voz', {
                type: 'fixed_times',
                hours: [1, 4]
            });

            expect(gpsScheduleId).toBeDefined();
            expect(vozScheduleId).toBeDefined();
            expect(gpsScheduleId).not.toBe(vozScheduleId);
        });

        test('should cancel schedules', async () => {
            const scheduleId = await adaptiveScheduler.scheduleService('gps', {
                type: 'interval',
                minutes: 10
            });

            const cancelled = adaptiveScheduler.cancelSchedule(scheduleId);

            expect(cancelled).toBe(true);
        });

        test('should provide scheduler statistics', () => {
            const stats = adaptiveScheduler.getSchedulerStats();

            expect(stats).toHaveProperty('activeSchedules');
            expect(stats).toHaveProperty('recentPerformance');
            expect(stats).toHaveProperty('adaptiveAdjustments');
        });
    });

    describe('ServiceHealthMonitor', () => {
        beforeEach(async () => {
            // Add mock service instances
            const mockInstance = new MockServiceProcessor(mockDb, mockLockManager, mockPersistenceQueue);
            serviceRegistry.registerServiceInstance('gps', mockInstance);
        });

        test('should start and stop monitoring', async () => {
            await serviceHealthMonitor.startMonitoring();
            expect(serviceHealthMonitor.isMonitoring).toBe(true);

            await serviceHealthMonitor.stopMonitoring();
            expect(serviceHealthMonitor.isMonitoring).toBe(false);
        });

        test('should perform health checks', async () => {
            await serviceHealthMonitor.startMonitoring();

            // Wait a bit for health checks to run
            await new Promise(resolve => setTimeout(resolve, 100));

            const healthReport = serviceHealthMonitor.getHealthReport();

            expect(healthReport).toBeDefined();
            expect(healthReport.overall).toBeDefined();
            expect(healthReport.services).toBeDefined();
        });

        test('should detect and track incidents', async () => {
            await serviceHealthMonitor.startMonitoring();

            // Simulate unhealthy service
            serviceRegistry.updateServiceHealth('gps', {
                status: 'unhealthy',
                error: 'Test error'
            });

            // Wait for incident detection
            await new Promise(resolve => setTimeout(resolve, 100));

            const healthReport = serviceHealthMonitor.getHealthReport();
            expect(healthReport.incidents).toBeDefined();
        });

        test('should provide monitoring statistics', () => {
            const stats = serviceHealthMonitor.getMonitoringStats();

            expect(stats).toHaveProperty('isMonitoring');
            expect(stats).toHaveProperty('servicesMonitored');
            expect(stats).toHaveProperty('totalIncidents');
        });
    });

    describe('UnifiedServiceAnalytics', () => {
        test('should generate unified reports', async () => {
            const report = await unifiedAnalytics.generateUnifiedReport('monthly');

            expect(report).toBeDefined();
            expect(report.metadata).toBeDefined();
            expect(report.cross_service_metrics).toBeDefined();
            expect(report.service_comparison).toBeDefined();
            expect(report.business_insights).toBeDefined();
        });

        test('should provide real-time dashboard data', async () => {
            const dashboard = await unifiedAnalytics.getRealTimeDashboard();

            expect(dashboard).toBeDefined();
            expect(dashboard.timestamp).toBeDefined();
            expect(dashboard.services).toBeDefined();
            expect(dashboard.kpis).toBeDefined();
        });

        test('should export analytics in different formats', async () => {
            const jsonExport = await unifiedAnalytics.exportAnalytics('json', 'weekly');

            expect(jsonExport).toBeDefined();
            expect(typeof jsonExport).toBe('string');

            // Should be valid JSON
            expect(() => JSON.parse(jsonExport)).not.toThrow();
        });
    });

    describe('Integration Scenarios', () => {
        test('should handle complete service lifecycle', async () => {
            // Initialize orchestrator
            await enhancedOrchestrator.initialize(mockDependencies);

            // Create and register service
            const serviceInstance = await serviceFactory.createService('gps');

            // Start monitoring
            await serviceHealthMonitor.startMonitoring();

            // Schedule service
            const scheduleId = await adaptiveScheduler.scheduleService('gps', {
                type: 'interval',
                minutes: 5
            });

            // Execute service
            const execution = await enhancedOrchestrator.startService('gps');

            // Verify everything worked
            expect(serviceInstance).toBeDefined();
            expect(scheduleId).toBeDefined();
            expect(execution.status).toBe('completed');
            expect(serviceHealthMonitor.isMonitoring).toBe(true);

            // Cleanup
            adaptiveScheduler.cancelSchedule(scheduleId);
            await serviceFactory.destroyService(serviceInstance.instanceId);
        });

        test('should handle service failures gracefully', async () => {
            await enhancedOrchestrator.initialize(mockDependencies);

            // Create failing service
            const failingInstance = {
                processRecharges: jest.fn().mockRejectedValue(new Error('Test failure')),
                getServiceType: () => 'gps',
                healthCheck: jest.fn().mockResolvedValue({ status: 'unhealthy' })
            };

            const instanceId = serviceRegistry.registerServiceInstance('gps', failingInstance);

            // Start monitoring to detect failures
            await serviceHealthMonitor.startMonitoring();

            // Try to execute failing service
            await expect(enhancedOrchestrator.startService('gps')).rejects.toThrow('Test failure');

            // Verify failure was recorded
            const healthReport = serviceHealthMonitor.getHealthReport();
            expect(healthReport.services.gps).toBeDefined();
        });

        test('should scale services under load', async () => {
            await enhancedOrchestrator.initialize(mockDependencies);

            // Create initial service
            await serviceFactory.createService('gps');

            // Create service cluster to simulate scaling
            const cluster = await serviceFactory.createServiceCluster('gps', 3);

            // Verify cluster was created
            expect(cluster).toHaveLength(3);

            // Verify registry shows multiple instances
            const gpsService = serviceRegistry.services.get('gps');
            expect(gpsService.instances.size).toBeGreaterThan(1);
        });

        test('should provide comprehensive system statistics', async () => {
            // Initialize all components
            await enhancedOrchestrator.initialize(mockDependencies);
            await serviceHealthMonitor.startMonitoring();

            // Create some services
            await serviceFactory.createService('gps');
            await serviceFactory.createService('voz');

            // Get statistics from all components
            const registryStats = serviceRegistry.getStats();
            const factoryStats = serviceFactory.getStats();
            const orchestratorStats = enhancedOrchestrator.getStats();
            const schedulerStats = adaptiveScheduler.getSchedulerStats();
            const monitoringStats = serviceHealthMonitor.getMonitoringStats();

            // Verify all stats are available
            expect(registryStats).toBeDefined();
            expect(factoryStats).toBeDefined();
            expect(orchestratorStats).toBeDefined();
            expect(schedulerStats).toBeDefined();
            expect(monitoringStats).toBeDefined();
        });
    });

    describe('Configuration Validation', () => {
        test('should validate architecture configuration', () => {
            const validation = architectureConfig.helpers.validateConfiguration();

            expect(validation).toHaveProperty('isValid');
            expect(validation).toHaveProperty('errors');

            if (!validation.isValid) {
                console.warn('Configuration validation errors:', validation.errors);
            }
        });

        test('should get current environment configuration', () => {
            const envConfig = architectureConfig.helpers.getCurrentEnvironmentConfig();

            expect(envConfig).toBeDefined();
            expect(envConfig.environment).toBeDefined();
            expect(envConfig.strategy).toBeDefined();
        });

        test('should get service architecture configuration', () => {
            const gpsArch = architectureConfig.helpers.getServiceArchitecture('gps');

            expect(gpsArch).toBeDefined();
            expect(gpsArch.pattern).toBeDefined();
            expect(gpsArch.resources).toBeDefined();
        });
    });

    describe('Error Handling and Resilience', () => {
        test('should handle database connection failures', async () => {
            // Mock database failure
            const failingDb = {
                authenticate: jest.fn().mockRejectedValue(new Error('Database connection failed'))
            };

            const failingDependencies = {
                ...mockDependencies,
                dbConnection: failingDb
            };

            // Should handle gracefully
            await expect(serviceFactory.createService('gps', {}, { dependencies: failingDependencies }))
                .rejects.toThrow();
        });

        test('should handle service registry failures', async () => {
            // Try to get service that doesn\'t exist
            expect(() => serviceRegistry.getOptimalService('nonexistent'))
                .toThrow('Service not found');
        });

        test('should handle scheduling conflicts', async () => {
            const mockInstance = new MockServiceProcessor(mockDb, mockLockManager, mockPersistenceQueue);
            serviceRegistry.registerServiceInstance('gps', mockInstance);

            // Schedule same service multiple times
            const schedule1 = await adaptiveScheduler.scheduleService('gps', { type: 'interval', minutes: 5 });
            const schedule2 = await adaptiveScheduler.scheduleService('gps', { type: 'interval', minutes: 10 });

            // Both should succeed (different schedule IDs)
            expect(schedule1).toBeDefined();
            expect(schedule2).toBeDefined();
            expect(schedule1).not.toBe(schedule2);
        });
    });
});

// Helper functions for test setup
function createMockService(serviceType = 'gps') {
    return {
        getServiceType: () => serviceType,
        processRecharges: jest.fn().mockResolvedValue({
            totalProcessed: 1,
            successful: 1,
            failed: 0
        }),
        healthCheck: jest.fn().mockResolvedValue({
            status: 'healthy',
            responseTime: 100
        })
    };
}

function createMockDependencies() {
    return {
        dbConnection: mockDb,
        dbConnections: { GPS_DB: mockDb, ELIOT_DB: mockDb },
        lockManager: mockLockManager,
        persistenceQueue: mockPersistenceQueue,
        alertManager: mockAlertManager,
        slaMonitor: mockSLAMonitor
    };
}

module.exports = {
    createMockService,
    createMockDependencies
};