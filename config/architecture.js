/**
 * Architecture Configuration - Centralized service topology and deployment settings
 * Defines service architecture patterns, resource allocation, and operational policies
 */

const serviceConfig = require('./services');

module.exports = {
    // ===== SERVICE ARCHITECTURE PATTERNS =====
    architecturePatterns: {
        // Single-instance pattern for small workloads
        'single_instance': {
            instanceCount: 1,
            loadBalancing: false,
            clustering: false,
            healthChecks: 'basic',
            scalingPolicy: 'manual'
        },

        // Multi-instance pattern for medium workloads
        'multi_instance': {
            instanceCount: 3,
            loadBalancing: true,
            clustering: false,
            healthChecks: 'comprehensive',
            scalingPolicy: 'manual'
        },

        // Clustered pattern for high-availability workloads
        'clustered': {
            instanceCount: 5,
            loadBalancing: true,
            clustering: true,
            healthChecks: 'comprehensive',
            scalingPolicy: 'auto'
        }
    },

    // ===== SERVICE ARCHITECTURE ASSIGNMENTS =====
    serviceArchitectures: {
        'gps': {
            pattern: 'multi_instance',
            priority: 'high',
            criticality: 'critical',
            resourceClass: 'high_performance'
        },

        'voz': {
            pattern: 'single_instance',
            priority: 'medium',
            criticality: 'important',
            resourceClass: 'standard'
        },

        'eliot': {
            pattern: 'multi_instance',
            priority: 'medium',
            criticality: 'important',
            resourceClass: 'standard'
        }
    },

    // ===== RESOURCE ALLOCATION POLICIES =====
    resourceAllocation: {
        // Resource classes define compute and memory allocation
        resourceClasses: {
            'low': {
                cpu: { min: 0.1, max: 0.5, target: 0.2 },
                memory: { min: '128MB', max: '512MB', target: '256MB' },
                connections: { database: 2, redis: 1, mongodb: 1 },
                disk: { temp: '100MB', logs: '500MB' }
            },

            'standard': {
                cpu: { min: 0.2, max: 1.0, target: 0.5 },
                memory: { min: '256MB', max: '1GB', target: '512MB' },
                connections: { database: 5, redis: 2, mongodb: 2 },
                disk: { temp: '200MB', logs: '1GB' }
            },

            'high_performance': {
                cpu: { min: 0.5, max: 2.0, target: 1.0 },
                memory: { min: '512MB', max: '2GB', target: '1GB' },
                connections: { database: 10, redis: 5, mongodb: 3 },
                disk: { temp: '500MB', logs: '2GB' }
            }
        },

        // Global resource limits
        globalLimits: {
            maxTotalInstances: 20,
            maxConcurrentServices: 3,
            maxDatabaseConnections: 50,
            maxRedisConnections: 20,
            maxMemoryUsage: '8GB',
            maxCpuUsage: 4.0
        },

        // Resource allocation strategy
        allocationStrategy: {
            algorithm: 'priority_weighted', // priority_weighted, round_robin, least_loaded
            rebalancing: true,
            rebalanceInterval: '5m',
            resourceMonitoring: true,
            autoScaling: {
                enabled: process.env.AUTO_SCALING_ENABLED === 'true',
                metrics: ['cpu', 'memory', 'response_time'],
                scaleUpThreshold: 80,   // Percentage
                scaleDownThreshold: 30, // Percentage
                cooldownPeriod: '10m'
            }
        }
    },

    // ===== SERVICE ISOLATION POLICIES =====
    serviceIsolation: {
        // Network isolation
        network: {
            isolationLevel: 'process', // none, process, container
            firewallRules: [],
            allowedConnections: {
                'gps': ['database', 'redis', 'webservice'],
                'voz': ['database', 'redis', 'webservice'],
                'eliot': ['database', 'redis', 'webservice', 'mongodb']
            }
        },

        // Resource isolation
        resource: {
            cpuQuotas: true,
            memoryLimits: true,
            diskQuotas: false,
            networkBandwidth: false
        },

        // Security isolation
        security: {
            processIsolation: true,
            fileSystemIsolation: false,
            userIsolation: false,
            secretsIsolation: true
        }
    },

    // ===== SCALING POLICIES =====
    scalingPolicies: {
        // Horizontal scaling rules
        horizontal: {
            'gps': {
                minInstances: 1,
                maxInstances: 5,
                targetUtilization: 70,
                scaleUpCooldown: '5m',
                scaleDownCooldown: '10m',
                metrics: ['cpu', 'memory', 'queue_length']
            },

            'voz': {
                minInstances: 1,
                maxInstances: 2,
                targetUtilization: 80,
                scaleUpCooldown: '10m',
                scaleDownCooldown: '15m',
                metrics: ['cpu', 'memory']
            },

            'eliot': {
                minInstances: 1,
                maxInstances: 3,
                targetUtilization: 75,
                scaleUpCooldown: '5m',
                scaleDownCooldown: '10m',
                metrics: ['cpu', 'memory', 'mongodb_connections']
            }
        },

        // Vertical scaling rules
        vertical: {
            enabled: false, // Requires container orchestration
            maxCpuIncrease: 2.0,
            maxMemoryIncrease: 2.0,
            cooldownPeriod: '15m'
        }
    },

    // ===== SERVICE DEPENDENCIES =====
    serviceDependencies: {
        // Dependency graph
        dependencies: {
            'gps': {
                required: ['database', 'redis'],
                optional: ['webservice', 'alerting'],
                provides: ['gps_recharge_service']
            },

            'voz': {
                required: ['database', 'redis'],
                optional: ['webservice', 'alerting'],
                provides: ['voz_recharge_service']
            },

            'eliot': {
                required: ['database', 'redis', 'mongodb'],
                optional: ['webservice', 'alerting'],
                provides: ['eliot_recharge_service']
            }
        },

        // Startup order based on dependencies
        startupOrder: [
            { services: ['database', 'redis', 'mongodb'], parallel: true },
            { services: ['webservice'], parallel: false },
            { services: ['gps', 'voz', 'eliot'], parallel: true },
            { services: ['alerting', 'monitoring'], parallel: true }
        ],

        // Dependency health monitoring
        healthChecks: {
            enabled: true,
            checkInterval: '30s',
            timeoutPerCheck: '10s',
            retryAttempts: 3,
            circuitBreaker: true
        }
    },

    // ===== DEPLOYMENT CONFIGURATION =====
    deployment: {
        // Deployment strategies
        strategies: {
            'development': {
                pattern: 'single_instance',
                isolation: 'minimal',
                monitoring: 'basic',
                logging: 'debug'
            },

            'staging': {
                pattern: 'multi_instance',
                isolation: 'moderate',
                monitoring: 'comprehensive',
                logging: 'info'
            },

            'production': {
                pattern: 'clustered',
                isolation: 'strict',
                monitoring: 'comprehensive',
                logging: 'warn'
            }
        },

        // Current deployment strategy
        currentStrategy: process.env.DEPLOYMENT_STRATEGY || 'development',

        // Rolling update configuration
        rollingUpdate: {
            enabled: true,
            maxUnavailable: 1,
            maxSurge: 1,
            updateTimeout: '300s',
            rollbackOnFailure: true
        },

        // Health check configuration
        healthChecks: {
            startup: {
                enabled: true,
                timeoutSeconds: 30,
                periodSeconds: 5,
                failureThreshold: 6
            },
            liveness: {
                enabled: true,
                timeoutSeconds: 10,
                periodSeconds: 30,
                failureThreshold: 3
            },
            readiness: {
                enabled: true,
                timeoutSeconds: 5,
                periodSeconds: 10,
                failureThreshold: 3
            }
        }
    },

    // ===== MONITORING AND OBSERVABILITY =====
    monitoring: {
        // Metrics collection
        metrics: {
            enabled: true,
            interval: '30s',
            retention: '7d',
            exporters: ['prometheus', 'influxdb'],
            customMetrics: {
                'recharge_success_rate': 'gauge',
                'recharge_duration': 'histogram',
                'queue_depth': 'gauge',
                'error_rate': 'counter'
            }
        },

        // Distributed tracing
        tracing: {
            enabled: process.env.TRACING_ENABLED === 'true',
            samplingRate: 0.1, // 10% sampling
            exporter: 'jaeger',
            serviceName: 'recargas-system'
        },

        // Logging configuration
        logging: {
            level: process.env.LOG_LEVEL || 'info',
            format: 'json',
            destination: 'stdout',
            retention: '30d',
            compression: true,
            contextualLogging: true
        },

        // Alerting configuration
        alerting: {
            enabled: true,
            channels: ['slack', 'email', 'webhook'],
            severity: {
                critical: { response_time: '5m', escalation: ['pagerduty'] },
                warning: { response_time: '15m', escalation: ['slack'] },
                info: { response_time: '1h', escalation: ['email'] }
            }
        }
    },

    // ===== BACKUP AND DISASTER RECOVERY =====
    backupAndRecovery: {
        // Backup strategies
        backup: {
            enabled: true,
            frequency: 'daily',
            retention: '30d',
            compression: true,
            encryption: true,
            destinations: ['local', 's3'],
            components: ['database', 'configuration', 'logs', 'queues']
        },

        // Disaster recovery
        disasterRecovery: {
            rpo: '1h',  // Recovery Point Objective
            rto: '4h',  // Recovery Time Objective
            backupSites: 1,
            autoFailover: false,
            dataReplication: 'async',
            testingFrequency: 'monthly'
        },

        // High availability
        highAvailability: {
            enabled: process.env.HA_ENABLED === 'true',
            activePassive: true,
            heartbeatInterval: '10s',
            failoverTimeout: '30s',
            splitBrainProtection: true
        }
    },

    // ===== SECURITY CONFIGURATION =====
    security: {
        // Authentication and authorization
        auth: {
            enabled: true,
            method: 'jwt', // jwt, oauth, api_key
            tokenExpiry: '24h',
            refreshTokens: true,
            roleBasedAccess: true
        },

        // Network security
        network: {
            tls: {
                enabled: process.env.TLS_ENABLED === 'true',
                version: 'TLSv1.3',
                cipherSuites: 'strong',
                certificateRotation: true
            },
            firewall: {
                enabled: false,
                defaultPolicy: 'deny',
                allowedPorts: [3000, 8080, 9090]
            }
        },

        // Data security
        data: {
            encryption: {
                atRest: true,
                inTransit: true,
                algorithm: 'AES-256-GCM',
                keyRotation: true
            },
            sanitization: {
                enabled: true,
                sqlInjectionProtection: true,
                xssProtection: true,
                inputValidation: true
            }
        },

        // Secrets management
        secrets: {
            provider: 'env', // env, vault, aws_secrets
            rotation: false,
            encryption: true,
            auditLogging: true
        }
    },

    // ===== PERFORMANCE OPTIMIZATION =====
    performance: {
        // Caching strategies
        caching: {
            enabled: true,
            layers: ['redis', 'application'],
            policies: {
                'default': { ttl: '5m', maxSize: '100MB' },
                'static': { ttl: '1h', maxSize: '50MB' },
                'dynamic': { ttl: '1m', maxSize: '200MB' }
            },
            evictionPolicy: 'lru'
        },

        // Connection pooling
        connectionPooling: {
            database: {
                enabled: true,
                minConnections: 2,
                maxConnections: 20,
                idleTimeout: '30s',
                connectionTimeout: '10s'
            },
            redis: {
                enabled: true,
                minConnections: 1,
                maxConnections: 10,
                idleTimeout: '60s',
                connectionTimeout: '5s'
            }
        },

        // Query optimization
        queryOptimization: {
            enabled: true,
            cachePreparedStatements: true,
            queryTimeout: '30s',
            slowQueryLogging: true,
            slowQueryThreshold: '1s'
        },

        // Resource optimization
        resourceOptimization: {
            garbageCollection: {
                algorithm: 'G1GC',
                tuning: true,
                monitoring: true
            },
            memoryManagement: {
                heapSize: 'auto',
                offHeapCaching: false,
                memoryLeakDetection: true
            }
        }
    },

    // ===== DEVELOPMENT AND TESTING =====
    development: {
        // Development tools
        tools: {
            hotReload: process.env.NODE_ENV === 'development',
            debugging: {
                enabled: process.env.DEBUG_ENABLED === 'true',
                port: 9229,
                inspector: true
            },
            profiling: {
                enabled: process.env.PROFILING_ENABLED === 'true',
                sampling: true,
                heapSnapshots: true
            }
        },

        // Testing configuration
        testing: {
            unitTests: {
                framework: 'jest',
                coverage: true,
                threshold: 80
            },
            integrationTests: {
                framework: 'jest',
                database: 'test',
                isolation: true
            },
            loadTesting: {
                enabled: false,
                framework: 'k6',
                scenarios: ['normal', 'peak', 'stress']
            }
        }
    },

    // ===== COMPLIANCE AND GOVERNANCE =====
    compliance: {
        // Data governance
        dataGovernance: {
            dataClassification: true,
            dataLineage: false,
            dataRetention: {
                logs: '30d',
                metrics: '90d',
                backups: '1y'
            }
        },

        // Regulatory compliance
        regulatory: {
            gdpr: false,
            hipaa: false,
            sox: false,
            pci: false
        },

        // Auditing
        auditing: {
            enabled: true,
            accessLogs: true,
            changeTracking: true,
            complianceReports: 'monthly'
        }
    },

    // ===== RUNTIME CONFIGURATION =====
    runtime: {
        // Environment-specific overrides
        environments: {
            development: {
                resourceAllocation: {
                    resourceClasses: {
                        'high_performance': {
                            cpu: { min: 0.1, max: 0.5, target: 0.2 },
                            memory: { min: '128MB', max: '512MB', target: '256MB' }
                        }
                    }
                },
                monitoring: {
                    metrics: { interval: '60s' },
                    logging: { level: 'debug' }
                }
            },

            production: {
                security: {
                    network: { tls: { enabled: true } }
                },
                monitoring: {
                    metrics: { interval: '15s' },
                    logging: { level: 'warn' }
                }
            }
        },

        // Feature flags
        featureFlags: {
            'adaptive_scheduling': process.env.FEATURE_ADAPTIVE_SCHEDULING === 'true',
            'auto_scaling': process.env.FEATURE_AUTO_SCALING === 'true',
            'performance_optimization': process.env.FEATURE_PERF_OPT === 'true',
            'advanced_monitoring': process.env.FEATURE_ADV_MONITORING === 'true'
        }
    },

    // ===== HELPER FUNCTIONS =====
    helpers: {
        /**
         * Get configuration for current environment
         */
        getCurrentEnvironmentConfig() {
            const env = process.env.NODE_ENV || 'development';
            const strategy = module.exports.deployment.currentStrategy;
            const envConfig = module.exports.runtime.environments[env] || {};
            const strategyConfig = module.exports.deployment.strategies[strategy] || {};

            return {
                environment: env,
                strategy,
                ...envConfig,
                ...strategyConfig
            };
        },

        /**
         * Get service architecture configuration
         */
        getServiceArchitecture(serviceKey) {
            const serviceArch = this.serviceArchitectures[serviceKey];
            if (!serviceArch) {
                return null;
            }

            const pattern = this.architecturePatterns[serviceArch.pattern];
            const resourceClass = this.resourceAllocation.resourceClasses[serviceArch.resourceClass];

            return {
                ...serviceArch,
                pattern: pattern,
                resources: resourceClass
            };
        },

        /**
         * Validate configuration
         */
        validateConfiguration() {
            const errors = [];

            // Validate service architectures
            Object.keys(module.exports.serviceArchitectures).forEach(serviceKey => {
                const arch = module.exports.serviceArchitectures[serviceKey];
                if (!module.exports.architecturePatterns[arch.pattern]) {
                    errors.push(`Invalid pattern '${arch.pattern}' for service '${serviceKey}'`);
                }
                if (!module.exports.resourceAllocation.resourceClasses[arch.resourceClass]) {
                    errors.push(`Invalid resource class '${arch.resourceClass}' for service '${serviceKey}'`);
                }
            });

            // Validate dependencies
            Object.keys(module.exports.serviceDependencies.dependencies).forEach(serviceKey => {
                const deps = module.exports.serviceDependencies.dependencies[serviceKey];
                // Additional dependency validation would go here
            });

            return {
                isValid: errors.length === 0,
                errors
            };
        }
    }
};