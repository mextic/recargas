// ============== SISTEMA DE RECARGAS OPTIMIZADO v3.0 - ENHANCED ARCHITECTURE ==============
require("./lib/instrument.js");

// Core infrastructure
const { initDatabases, dbGps, dbEliot, getRedisClient, shutdownDatabases, getPoolStats } = require('./lib/database');
const { PersistenceQueueSystem } = require('./lib/concurrency/PersistenceQueueSystem');
const { OptimizedLockManager } = require('./lib/concurrency/OptimizedLockManager');

// Enhanced service architecture
const ServiceRegistry = require('./lib/services/ServiceRegistry');
const ServiceFactory = require('./lib/services/ServiceFactory');
const EnhancedOrchestrator = require('./lib/orchestration/EnhancedOrchestrator');
const AdaptiveScheduler = require('./lib/scheduling/AdaptiveScheduler');
const ServiceHealthMonitor = require('./lib/monitoring/ServiceHealthMonitor');
const UnifiedServiceAnalytics = require('./lib/analytics/UnifiedServiceAnalytics');

// Legacy processors (for backward compatibility)
const { GPSRechargeProcessor } = require('./lib/processors/GPSRechargeProcessor');
const { VozRechargeProcessor } = require('./lib/processors/VozRechargeProcessor');
const { ELIoTRechargeProcessor } = require('./lib/processors/ELIoTRechargeProcessor');
const OptimizedGPSProcessor = require('./lib/processors/OptimizedGPSProcessor');

// Monitoring and alerting
const AlertManager = require('./lib/alerts/AlertManager');
const HealthCheckManager = require('./lib/health/HealthCheckManager');
const SLAMonitor = require('./lib/sla/SLAMonitor');

// Configuration
const architectureConfig = require('./config/architecture');
const serviceConfig = require('./config/services');

const schedule = require('node-schedule');
const moment = require('moment-timezone');
const logger = require('./lib/utils/logger');

class RechargeOrchestrator {
    constructor() {
        // Enhanced architecture components
        this.enhancedOrchestrator = null;
        this.serviceRegistry = null;
        this.serviceFactory = null;
        this.adaptiveScheduler = null;
        this.serviceHealthMonitor = null;
        this.unifiedAnalytics = null;

        // Legacy components (for backward compatibility)
        this.processors = {
            GPS: null,
            VOZ: null,
            ELIOT: null
        };
        this.persistenceQueues = new Map();
        this.lockManager = null;
        this.schedules = new Map();

        // Infrastructure
        this.alertManager = null;
        this.healthCheckManager = null;
        this.slaMonitor = null;

        // State management
        this.isInitialized = false;
        this.useEnhancedArchitecture = process.env.USE_ENHANCED_ARCHITECTURE !== 'false';
        this.startTime = new Date();

        // Architecture configuration
        this.config = architectureConfig.helpers.getCurrentEnvironmentConfig();

        logger.info('RechargeOrchestrator v3.0 initialized', {
            enhancedArchitecture: this.useEnhancedArchitecture,
            environment: this.config.environment,
            strategy: this.config.strategy
        });
    }

    async initialize() {
        const initStartTime = Date.now();

        console.log('🚀 Iniciando Sistema de Recargas Optimizado v3.0 - Enhanced Architecture');
        console.log('=========================================================================\n');

        logger.info('Starting enhanced recharge system initialization', {
            version: '3.0',
            enhancedArchitecture: this.useEnhancedArchitecture,
            environment: process.env.NODE_ENV || 'development'
        });

        try {
            // Validate architecture configuration
            const configValidation = architectureConfig.helpers.validateConfiguration();
            if (!configValidation.isValid) {
                throw new Error(`Configuration validation failed: ${configValidation.errors.join(', ')}`);
            }

            logger.info('Architecture configuration validated successfully');

            // 1. Initialize core infrastructure
            console.log('📊 Initializing core infrastructure...');
            await this.initializeCoreInfrastructure();

            // 2. Initialize enhanced service architecture
            if (this.useEnhancedArchitecture) {
                console.log('🏗️ Initializing enhanced service architecture...');
                await this.initializeEnhancedArchitecture();
            } else {
                console.log('⚙️ Initializing legacy architecture...');
                await this.initializeLegacyArchitecture();
            }

            // 3. Initialize monitoring and alerting
            console.log('📊 Initializing monitoring and alerting systems...');
            await this.initializeMonitoringAndAlerting();

            // 4. Start services and monitoring
            console.log('🚀 Starting services and monitoring...');
            await this.startServicesAndMonitoring();

            // 5. Handle crash recovery
            console.log('🔍 Checking for crash recovery...');
            await this.handleCrashRecovery();

            // 6. Setup scheduling
            console.log('⏰ Setting up service scheduling...');
            await this.setupServiceScheduling();

            // 7. Development testing
            await this.setupDevelopmentTesting();

            this.isInitialized = true;
            const initDuration = Date.now() - initStartTime;

            console.log('\n✅ Sistema de Recargas v3.0 inicializado exitosamente');
            console.log(`⏱️ Tiempo de inicialización: ${initDuration}ms`);
            console.log('=========================================================================\n');

            // Display system status
            await this.displaySystemStatus();

            logger.info('Enhanced recharge system initialized successfully', {
                version: '3.0',
                initDurationMs: initDuration,
                enhancedArchitecture: this.useEnhancedArchitecture,
                servicesInitialized: this.getActiveServicesCount()
            });

            return true;

        } catch (error) {
            logger.error('Failed to initialize enhanced recharge system', {
                error: error.message,
                stack: error.stack
            });
            console.error('❌ Error inicializando sistema:', error);
            throw error;
        }
    }

    /**
     * Initialize core infrastructure (databases, connections, etc.)
     */
    async initializeCoreInfrastructure() {
        // Initialize databases
        await initDatabases();
        this.dbGps = dbGps;
        this.dbEliot = dbEliot;

        logger.info('Core infrastructure initialized', {
            databases: ['GPS', 'ELIOT'],
            redis: !!getRedisClient()
        });
    }

    /**
     * Initialize enhanced service architecture
     */
    async initializeEnhancedArchitecture() {
        try {
            // 1. Initialize service registry
            this.serviceRegistry = new ServiceRegistry();

            // 2. Create persistence queues for each service
            await this.createServicePersistenceQueues();

            // 3. Initialize lock manager
            this.lockManager = new OptimizedLockManager({
                useRedis: true,
                getRedisClient: getRedisClient
            });
            this.lockManager.setDbConnection(this.dbGps);

            // 4. Initialize service factory with dependencies
            const dependencies = {
                dbConnection: this.dbGps,
                dbConnections: { GPS_DB: this.dbGps, ELIOT_DB: this.dbEliot },
                lockManager: this.lockManager,
                persistenceQueue: null, // Will be set per service
                redisClient: getRedisClient()
            };

            this.serviceFactory = new ServiceFactory(this.serviceRegistry, dependencies);

            // 5. Initialize enhanced orchestrator
            this.enhancedOrchestrator = new EnhancedOrchestrator({
                maxConcurrentServices: architectureConfig.resourceAllocation.globalLimits.maxConcurrentServices,
                performanceMonitoringEnabled: true,
                autoScalingEnabled: architectureConfig.resourceAllocation.allocationStrategy.autoScaling.enabled,
                circuitBreakerEnabled: true
            });

            await this.enhancedOrchestrator.initialize(dependencies);

            // 6. Initialize adaptive scheduler
            this.adaptiveScheduler = new AdaptiveScheduler(this.serviceRegistry, {
                adaptiveAdjustment: architectureConfig.runtime.featureFlags.adaptive_scheduling,
                loadBalancingEnabled: true,
                maxConcurrentServices: architectureConfig.resourceAllocation.globalLimits.maxConcurrentServices
            });

            logger.info('Enhanced service architecture initialized successfully');

        } catch (error) {
            logger.error('Failed to initialize enhanced architecture', {
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Initialize legacy architecture for backward compatibility
     */
    async initializeLegacyArchitecture() {
        // Create persistence queues
        await this.createServicePersistenceQueues();

        // Initialize lock manager
        this.lockManager = new OptimizedLockManager({
            useRedis: true,
            getRedisClient: getRedisClient
        });
        this.lockManager.setDbConnection(this.dbGps);

        logger.info('Legacy architecture initialized');
    }

    /**
     * Create service-specific persistence queues
     */
    async createServicePersistenceQueues() {
        const serviceTypes = ['gps', 'voz', 'eliot'];

        for (const serviceType of serviceTypes) {
            const queue = new PersistenceQueueSystem({
                serviceType,
                enableAutoRecovery: true,
                maxRetries: 3
            });

            await queue.initialize();
            this.persistenceQueues.set(serviceType, queue);
        }

        logger.info('Service persistence queues created', {
            services: serviceTypes
        });
    }

    /**
     * Initialize monitoring and alerting systems
     */
    async initializeMonitoringAndAlerting() {
        try {
            // Initialize alert manager
            this.alertManager = new AlertManager();
            await this.alertManager.initialize();

            // Initialize SLA monitor
            this.slaMonitor = new SLAMonitor(this.alertManager);

            // Initialize health check manager
            this.healthCheckManager = new HealthCheckManager(this.alertManager);

            // Initialize service health monitor (enhanced architecture)
            if (this.useEnhancedArchitecture && this.serviceRegistry) {
                this.serviceHealthMonitor = new ServiceHealthMonitor(
                    this.serviceRegistry,
                    this.alertManager,
                    this.slaMonitor
                );
            }

            // Initialize unified analytics
            if (this.useEnhancedArchitecture) {
                this.unifiedAnalytics = new UnifiedServiceAnalytics(
                    { GPS_DB: this.dbGps, ELIOT_DB: this.dbEliot },
                    this.serviceRegistry
                );
            }

            logger.info('Monitoring and alerting systems initialized', {
                alertManager: !!this.alertManager,
                slaMonitor: !!this.slaMonitor,
                healthCheckManager: !!this.healthCheckManager,
                serviceHealthMonitor: !!this.serviceHealthMonitor,
                unifiedAnalytics: !!this.unifiedAnalytics
            });

        } catch (error) {
            logger.warn('Some monitoring components failed to initialize', {
                error: error.message
            });
            // Continue with partial monitoring functionality
        }
    }

    /**
     * Start services and monitoring
     */
    async startServicesAndMonitoring() {
        if (this.useEnhancedArchitecture) {
            // Start service health monitoring
            if (this.serviceHealthMonitor) {
                await this.serviceHealthMonitor.startMonitoring();
            }
        } else {
            // Initialize legacy processors
            this.processors.GPS = new GPSRechargeProcessor(
                this.dbGps,
                this.lockManager,
                this.persistenceQueues.get('gps'),
                this.alertManager,
                this.slaMonitor
            );

            this.processors.VOZ = new VozRechargeProcessor(
                this.dbGps,
                this.lockManager,
                this.persistenceQueues.get('voz'),
                this.alertManager,
                this.slaMonitor
            );

            this.processors.ELIOT = new ELIoTRechargeProcessor(
                { GPS_DB: this.dbGps, ELIOT_DB: this.dbEliot },
                this.lockManager,
                this.persistenceQueues.get('eliot'),
                this.alertManager,
                this.slaMonitor
            );
        }

        // Start health checks
        if (this.healthCheckManager && typeof this.healthCheckManager.start === 'function') {
            await this.healthCheckManager.start();
        }

        logger.info('Services and monitoring started successfully');
    }

    /**
     * Handle crash recovery
     */
    async handleCrashRecovery() {
        try {
            let totalPending = 0;
            const recoveryStats = {};

            for (const [serviceType, queue] of this.persistenceQueues.entries()) {
                const stats = await queue.getQueueStats();
                const pending = stats.auxiliaryQueue.pendingDb;
                totalPending += pending;
                recoveryStats[serviceType] = pending;
            }

            if (totalPending > 0) {
                console.log(`⚠️ Detectadas ${totalPending} recargas pendientes:`, recoveryStats);
                logger.warn('Pending recharges detected', {
                    totalPending,
                    byService: recoveryStats
                });

                if (this.useEnhancedArchitecture) {
                    // Enhanced recovery logic could be implemented here
                } else {
                    await this.processPendingQueues();
                }
            }
        } catch (error) {
            logger.error('Error during crash recovery', {
                error: error.message
            });
        }
    }

    /**
     * Setup service scheduling
     */
    async setupServiceScheduling() {
        if (this.useEnhancedArchitecture && this.adaptiveScheduler) {
            // Schedule services using adaptive scheduler
            await this.setupEnhancedScheduling();
        } else {
            // Use legacy scheduling
            this.setupSchedules();
        }

        logger.info('Service scheduling configured', {
            enhanced: this.useEnhancedArchitecture
        });
    }

    /**
     * Setup enhanced scheduling with adaptive scheduler
     */
    async setupEnhancedScheduling() {
        try {
            // Schedule GPS service
            const gpsConfig = serviceConfig.GPS;
            await this.adaptiveScheduler.scheduleService('gps', {
                type: gpsConfig.SCHEDULE_TYPE,
                minutes: gpsConfig.SCHEDULE_MINUTES
            });

            // Schedule VOZ service
            const vozConfig = serviceConfig.VOZ;
            await this.adaptiveScheduler.scheduleService('voz', {
                type: vozConfig.SCHEDULE_TYPE,
                hours: vozConfig.SCHEDULE_HOURS
            });

            // Schedule ELIoT service
            const eliotConfig = serviceConfig.ELIOT;
            await this.adaptiveScheduler.scheduleService('eliot', {
                type: eliotConfig.SCHEDULE_TYPE,
                minutes: eliotConfig.SCHEDULE_MINUTES
            });

            logger.info('Enhanced scheduling configured for all services');

        } catch (error) {
            logger.error('Failed to setup enhanced scheduling', {
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Setup development testing
     */
    async setupDevelopmentTesting() {
        if (process.env.NODE_ENV !== 'development') {
            return;
        }

        const testServices = [];

        if (process.env.TEST_VOZ === 'true') {
            testServices.push({ service: 'VOZ', delay: 2000 });
        }

        if (process.env.TEST_ELIOT === 'true') {
            testServices.push({ service: 'ELIOT', delay: 3000 });
        }

        if (process.env.TEST_GPS === 'true') {
            testServices.push({ service: 'GPS', delay: 4000 });
        }

        for (const test of testServices) {
            setTimeout(() => {
                console.log(`\n🧪 TESTING: Ejecutando ${test.service} inmediatamente...`);
                this.runProcess(test.service).catch(error => {
                    console.error(`❌ Error en test ${test.service}:`, error);
                });
            }, test.delay);
        }

        if (testServices.length > 0) {
            logger.info('Development testing scheduled', {
                services: testServices.map(t => t.service)
            });
        }
    }

    /**
     * Display system status
     */
    async displaySystemStatus() {
        try {
            // Display pool stats
            const poolStats = getPoolStats();
            if (poolStats) {
                console.log('📊 Pool Stats:', JSON.stringify(poolStats, null, 2));
            }

            // Display service registry stats
            if (this.serviceRegistry) {
                const registryStats = this.serviceRegistry.getStats();
                console.log('🎯 Service Registry:', JSON.stringify(registryStats, null, 2));
            }

            // Display enhanced orchestrator stats
            if (this.enhancedOrchestrator) {
                const orchestratorStats = this.enhancedOrchestrator.getStats();
                console.log('🎼 Enhanced Orchestrator:', JSON.stringify(orchestratorStats, null, 2));
            }

        } catch (error) {
            logger.warn('Error displaying system status', {
                error: error.message
            });
        }
    }

    /**
     * Get count of active services
     */
    getActiveServicesCount() {
        if (this.useEnhancedArchitecture && this.serviceRegistry) {
            return this.serviceRegistry.getAllServices().length;
        } else {
            return Object.values(this.processors).filter(p => p !== null).length;
        }
    }

    /**
     * Enhanced run process method
     */
    async runProcess(serviceType) {
        try {
            if (this.useEnhancedArchitecture && this.enhancedOrchestrator) {
                // Use enhanced orchestrator
                return await this.enhancedOrchestrator.startService(serviceType.toLowerCase());
            } else {
                // Use legacy method
                return await this.runLegacyProcess(serviceType);
            }
        } catch (error) {
            logger.error(`Failed to run process: ${serviceType}`, {
                error: error.message,
                enhanced: this.useEnhancedArchitecture
            });
            throw error;
        }
    }

    /**
     * Legacy run process method (for backward compatibility)
     */
    async runLegacyProcess(serviceType) {
        const processor = this.processors[serviceType];
        if (!processor) {
            throw new Error(`Processor not found: ${serviceType}`);
        }

        return await processor.processRecharges();
    }

    /**
     * Get comprehensive system status
     */
    getSystemStatus() {
        const status = {
            version: '3.0',
            uptime: Date.now() - this.startTime.getTime(),
            initialized: this.isInitialized,
            enhancedArchitecture: this.useEnhancedArchitecture,
            activeServices: this.getActiveServicesCount(),
            components: {
                serviceRegistry: !!this.serviceRegistry,
                enhancedOrchestrator: !!this.enhancedOrchestrator,
                adaptiveScheduler: !!this.adaptiveScheduler,
                serviceHealthMonitor: !!this.serviceHealthMonitor,
                unifiedAnalytics: !!this.unifiedAnalytics,
                alertManager: !!this.alertManager,
                slaMonitor: !!this.slaMonitor
            }
        };

        return status;
    }

    /**
     * Graceful shutdown
     */
    async shutdown() {
        logger.info('Starting graceful shutdown...');

        try {
            // Stop enhanced components
            if (this.adaptiveScheduler) {
                await this.adaptiveScheduler.shutdown();
            }

            if (this.enhancedOrchestrator) {
                await this.enhancedOrchestrator.shutdown();
            }

            if (this.serviceHealthMonitor) {
                await this.serviceHealthMonitor.stopMonitoring();
            }

            // Stop legacy components
            if (this.healthCheckManager && typeof this.healthCheckManager.stop === 'function') {
                await this.healthCheckManager.stop();
            }

            // Cancel legacy schedules
            for (const job of this.schedules.values()) {
                if (job && typeof job.cancel === 'function') {
                    job.cancel();
                }
            }

            // Shutdown databases
            await shutdownDatabases();

            console.log('✅ Sistema de Recargas v3.0 apagado exitosamente');
            logger.info('Graceful shutdown completed');

        } catch (error) {
            logger.error('Error during shutdown', {
                error: error.message
            });
            throw error;
        }
    }

    // Legacy methods preserved for backward compatibility
    setupSchedules() {
        console.log('📅 Configurando tareas programadas (legacy mode)...');

        // GPS - Intervalo configurable basado en GPS_MINUTOS_SIN_REPORTAR
        const gpsInterval = parseInt(process.env.GPS_MINUTOS_SIN_REPORTAR) || 14;
        console.log(`   🔄 GPS verificará cada ${gpsInterval} minutos (GPS_MINUTOS_SIN_REPORTAR=${gpsInterval})`);

        const gpsRule = new schedule.RecurrenceRule();
        gpsRule.minute = new schedule.Range(0, 59, gpsInterval);
        gpsRule.tz = "America/Mazatlan";

        this.schedules.set('GPS', schedule.scheduleJob(gpsRule, async () => {
            await this.runProcess('GPS');
        }));

        // VOZ - Configurable con variable de entorno o horarios fijos por defecto
        const vozMode = process.env.VOZ_SCHEDULE_MODE || 'fixed'; // 'fixed' o 'interval'
        const vozInterval = parseInt(process.env.VOZ_MINUTOS_SIN_REPORTAR) || null;

        if (vozMode === 'interval' && vozInterval) {
            // Modo intervalo: cada N minutos (como GPS)
            console.log(`   📞 VOZ verificará cada ${vozInterval} minutos (VOZ_MINUTOS_SIN_REPORTAR=${vozInterval})`);

            const vozRule = new schedule.RecurrenceRule();
            vozRule.minute = new schedule.Range(0, 59, vozInterval);
            vozRule.tz = "America/Mazatlan";

            this.schedules.set('VOZ', schedule.scheduleJob(vozRule, async () => {
                await this.runProcess('VOZ');
            }));
        } else {
            // Modo fijo: 2 veces al día (comportamiento actual)
            console.log('   📞 VOZ verificará 2 veces al día: 1:00 AM y 4:00 AM');

            // Primera ejecución: 1:00 AM
            const vozRule1 = new schedule.RecurrenceRule();
            vozRule1.hour = 1;
            vozRule1.minute = 0;
            vozRule1.tz = "America/Mazatlan";

            this.schedules.set('VOZ_1AM', schedule.scheduleJob(vozRule1, async () => {
                await this.runProcess('VOZ');
            }));

            // Segunda ejecución: 4:00 AM
            const vozRule2 = new schedule.RecurrenceRule();
            vozRule2.hour = 4;
            vozRule2.minute = 0;
            vozRule2.tz = "America/Mazatlan";

            this.schedules.set('VOZ_4AM', schedule.scheduleJob(vozRule2, async () => {
                await this.runProcess('VOZ');
            }));
        }

        // ELIoT - Intervalo configurable como GPS
        const eliotInterval = parseInt(process.env.ELIOT_MINUTOS_SIN_REPORTAR) || 10;
        console.log(`   📡 ELIoT verificará cada ${eliotInterval} minutos (ELIOT_MINUTOS_SIN_REPORTAR=${eliotInterval})`);

        const eliotRule = new schedule.RecurrenceRule();
        eliotRule.minute = new schedule.Range(0, 59, eliotInterval);
        eliotRule.tz = "America/Mazatlan";

        this.schedules.set('ELIOT', schedule.scheduleJob(eliotRule, async () => {
            await this.runProcess('ELIOT');
        }));

        console.log('✅ Tareas programadas configuradas exitosamente');
    }

    async processPendingQueues() {
        // Legacy implementation for processing pending queues
        const pendingOperations = [];

        for (const [serviceType, queue] of this.persistenceQueues.entries()) {
            const stats = await queue.getQueueStats();
            if (stats.auxiliaryQueue.pendingDb > 0) {
                pendingOperations.push(this.runProcess(serviceType.toUpperCase()));
            }
        }

        if (pendingOperations.length > 0) {
            await Promise.allSettled(pendingOperations);
        }
    }
}

// ===== MAIN EXECUTION =====
async function main() {
    const orchestrator = new RechargeOrchestrator();

    // Graceful shutdown handling
    process.on('SIGINT', async () => {
        console.log('\n📴 Recibida señal SIGINT. Cerrando sistema...');
        try {
            await orchestrator.shutdown();
            process.exit(0);
        } catch (error) {
            console.error('❌ Error durante apagado:', error);
            process.exit(1);
        }
    });

    process.on('SIGTERM', async () => {
        console.log('\n📴 Recibida señal SIGTERM. Cerrando sistema...');
        try {
            await orchestrator.shutdown();
            process.exit(0);
        } catch (error) {
            console.error('❌ Error durante apagado:', error);
            process.exit(1);
        }
    });

    try {
        await orchestrator.initialize();

        // Keep the process running
        console.log('💫 Sistema funcionando. Presiona Ctrl+C para salir.\n');

    } catch (error) {
        console.error('❌ Error fatal en inicialización:', error);
        process.exit(1);
    }
}

// Start the system
if (require.main === module) {
    main().catch(error => {
        console.error('❌ Error fatal:', error);
        process.exit(1);
    });
}

module.exports = RechargeOrchestrator;