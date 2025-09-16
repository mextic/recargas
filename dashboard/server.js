/**
 * Dashboard Server - FASE 5: Dashboard Web en Tiempo Real
 * Servidor Express + Socket.IO para visualización en tiempo real
 */
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const HealthCheckManager = require('../lib/health/HealthCheckManager');
const AlertManager = require('../lib/alerts/AlertManager');
const performanceMonitor = require('../lib/performance/PerformanceMonitor');
const { dbGps, dbEliot, getPerformanceCache } = require('../lib/database');
const moment = require('moment-timezone');

class DashboardServer {
    constructor() {
        this.app = express();
        this.server = http.createServer(this.app);
        this.io = socketIo(this.server, {
            cors: {
                origin: "*",
                methods: ["GET", "POST"]
            }
        });
        
        this.port = process.env.DASHBOARD_PORT || 3000;
        this.healthManager = null;
        this.alertManager = null;
        this.performanceCache = null;
        
        // Estado del dashboard
        this.dashboardState = {
            connectedClients: 0,
            lastUpdate: null,
            isHealthCheckRunning: false
        };
        
        this.initializeServices();
        this.setupMiddleware();
        this.setupRoutes();
        this.setupSocketHandlers();
        
        console.log('📊 Dashboard Server inicializado');
    }

    async initializeServices() {
        try {
            // Inicializar HealthCheckManager
            this.healthManager = new HealthCheckManager();
            
            // Inicializar AlertManager
            try {
                this.alertManager = new AlertManager();
                console.log('✅ AlertManager conectado al dashboard');
            } catch (error) {
                console.warn('⚠️ AlertManager no disponible en dashboard:', error.message);
            }
            
            // Obtener Performance Cache
            this.performanceCache = getPerformanceCache();
            
            console.log('✅ Servicios del dashboard inicializados');
        } catch (error) {
            console.error('❌ Error inicializando servicios del dashboard:', error.message);
        }
    }

    setupMiddleware() {
        // Servir archivos estáticos
        this.app.use(express.static(path.join(__dirname, 'public')));
        this.app.use(express.json());
        
        // CORS para desarrollo
        this.app.use((req, res, next) => {
            res.header('Access-Control-Allow-Origin', '*');
            res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
            next();
        });
        
        // Logging middleware
        this.app.use((req, res, next) => {
            console.log(`📡 ${req.method} ${req.path} - ${req.ip}`);
            next();
        });
    }

    setupRoutes() {
        // Ruta principal - servir dashboard
        this.app.get('/', (req, res) => {
            res.sendFile(path.join(__dirname, 'public', 'index.html'));
        });
        
        // API Routes
        this.app.get('/api/health/status', async (req, res) => {
            try {
                if (!this.healthManager) {
                    return res.status(503).json({ error: 'Health manager not available' });
                }
                
                const healthStatus = this.healthManager.getOverallHealth();
                res.json(healthStatus);
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });
        
        this.app.get('/api/health/history/:category?', async (req, res) => {
            try {
                const { category } = req.params;
                const limit = parseInt(req.query.limit) || 20;
                
                const history = this.healthManager.getHealthHistory(category, limit);
                res.json(history);
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });
        
        this.app.get('/api/alerts/active', async (req, res) => {
            try {
                if (!this.alertManager) {
                    return res.json([]);
                }
                
                const activeAlerts = this.alertManager.getActiveAlerts();
                res.json(activeAlerts);
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });
        
        this.app.get('/api/alerts/history', async (req, res) => {
            try {
                if (!this.alertManager) {
                    return res.json([]);
                }
                
                const limit = parseInt(req.query.limit) || 50;
                const history = this.alertManager.getAlertHistory(limit);
                res.json(history);
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });
        
        this.app.get('/api/performance/stats', async (req, res) => {
            try {
                const perfStats = performanceMonitor.getStats();
                const cacheStats = this.performanceCache ? this.performanceCache.getStats() : null;
                
                res.json({
                    performance: perfStats,
                    cache: cacheStats
                });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });
        
        this.app.get('/api/system/overview', async (req, res) => {
            try {
                const overview = await this.getSystemOverview();
                res.json(overview);
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        // Ruta para triggers manuales
        this.app.post('/api/health/check', async (req, res) => {
            try {
                const { service } = req.body;
                
                let result;
                if (service && service !== 'all') {
                    result = await this.healthManager.runSingleCheck(service);
                } else {
                    result = await this.healthManager.runAllChecks();
                }
                
                // Emitir actualización por Socket.IO
                this.io.emit('healthUpdate', result);
                
                res.json({ success: true, result });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        this.app.post('/api/alerts/test', async (req, res) => {
            try {
                if (!this.alertManager) {
                    return res.status(503).json({ error: 'Alert manager not available' });
                }
                
                const { priority = 'LOW', title = 'Test Alert', message = 'Test message from dashboard' } = req.body;
                
                const result = await this.alertManager.sendAlert({
                    priority,
                    title,
                    message,
                    service: 'DASHBOARD',
                    category: 'TEST'
                });
                
                res.json({ success: true, result });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });
        
        // Ruta para obtener datos de recargas recientes
        this.app.get('/api/recharges/recent', async (req, res) => {
            try {
                const limit = parseInt(req.query.limit) || 50;
                const recentRecharges = await this.getRecentRecharges(limit);
                res.json(recentRecharges);
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });
        
        this.app.get('/api/recharges/stats', async (req, res) => {
            try {
                const stats = await this.getRechargeStats();
                res.json(stats);
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });
    }

    setupSocketHandlers() {
        this.io.on('connection', (socket) => {
            this.dashboardState.connectedClients++;
            console.log(`👤 Cliente conectado al dashboard: ${socket.id} (Total: ${this.dashboardState.connectedClients})`);
            
            // Enviar estado inicial
            this.sendInitialData(socket);
            
            // Handlers para eventos del cliente
            socket.on('requestHealthCheck', async () => {
                try {
                    if (this.healthManager) {
                        const health = await this.healthManager.runAllChecks();
                        socket.emit('healthUpdate', health);
                    }
                } catch (error) {
                    socket.emit('error', { message: error.message });
                }
            });
            
            socket.on('requestSystemOverview', async () => {
                try {
                    const overview = await this.getSystemOverview();
                    socket.emit('systemOverview', overview);
                } catch (error) {
                    socket.emit('error', { message: error.message });
                }
            });
            
            socket.on('disconnect', () => {
                this.dashboardState.connectedClients--;
                console.log(`👤 Cliente desconectado: ${socket.id} (Total: ${this.dashboardState.connectedClients})`);
            });
        });
    }

    async sendInitialData(socket) {
        try {
            // Estado general del sistema
            const overview = await this.getSystemOverview();
            socket.emit('systemOverview', overview);
            
            // Estado de health checks
            if (this.healthManager) {
                const health = this.healthManager.getOverallHealth();
                socket.emit('healthUpdate', health);
            }
            
            // Alertas activas
            if (this.alertManager) {
                const activeAlerts = this.alertManager.getActiveAlerts();
                socket.emit('alertsUpdate', activeAlerts);
            }
            
            // Estadísticas de performance
            const perfStats = performanceMonitor.getStats();
            socket.emit('performanceUpdate', perfStats);
            
        } catch (error) {
            socket.emit('error', { message: error.message });
        }
    }

    async getSystemOverview() {
        const overview = {
            timestamp: Date.now(),
            timestampFormatted: moment().tz('America/Mazatlan').format('YYYY-MM-DD HH:mm:ss'),
            services: {},
            alerts: {},
            performance: {},
            dashboard: this.dashboardState
        };
        
        // Health status de servicios
        if (this.healthManager) {
            overview.services = this.healthManager.getOverallHealth();
        }
        
        // Estado de alertas
        if (this.alertManager) {
            const alertStats = this.alertManager.getStats();
            overview.alerts = {
                activeCount: alertStats.activeAlerts,
                totalSent: alertStats.totalSent,
                totalFailed: alertStats.totalFailed,
                enabledChannels: alertStats.enabledChannels
            };
        }
        
        // Performance stats
        const perfStats = performanceMonitor.getStats();
        overview.performance = {
            totalRequests: perfStats.totalRequests,
            hitRatio: perfStats.hitRatio,
            operations: perfStats.operations
        };
        
        return overview;
    }

    async getRecentRecharges(limit = 50) {
        try {
            const sql = `
                SELECT r.id, r.total, r.fecha, r.notas, r.quien, r.proveedor, r.tipo,
                       COUNT(dr.id) as detalle_count
                FROM recargas r
                LEFT JOIN detalle_recargas dr ON r.id = dr.id_recarga
                WHERE r.fecha >= ?
                GROUP BY r.id
                ORDER BY r.fecha DESC
                LIMIT ?
            `;
            
            const yesterday = Math.floor(Date.now() / 1000) - (24 * 60 * 60);
            const recharges = await dbGps.querySequelize(sql, {
                replacements: [yesterday, limit]
            });
            
            return recharges.map(r => ({
                ...r,
                fechaFormatted: moment.unix(r.fecha).tz('America/Mazatlan').format('YYYY-MM-DD HH:mm:ss'),
                timeAgo: moment.unix(r.fecha).fromNow()
            }));
        } catch (error) {
            console.error('Error obteniendo recargas recientes:', error.message);
            return [];
        }
    }

    async getRechargeStats() {
        try {
            const today = Math.floor(Date.now() / 1000) - (Date.now() % 86400);
            const yesterday = today - 86400;
            
            const statsQueries = [
                // Recargas de hoy por tipo
                `SELECT tipo, COUNT(*) as count, SUM(total) as total
                 FROM recargas 
                 WHERE fecha >= ?
                 GROUP BY tipo`,
                
                // Recargas de ayer por tipo
                `SELECT tipo, COUNT(*) as count, SUM(total) as total
                 FROM recargas 
                 WHERE fecha >= ? AND fecha < ?
                 GROUP BY tipo`
            ];
            
            const [todayStats, yesterdayStats] = await Promise.all([
                dbGps.querySequelize(statsQueries[0], { replacements: [today] }),
                dbGps.querySequelize(statsQueries[1], { replacements: [yesterday, today] })
            ]);
            
            return {
                today: todayStats,
                yesterday: yesterdayStats,
                timestamp: Date.now()
            };
        } catch (error) {
            console.error('Error obteniendo estadísticas de recargas:', error.message);
            return { today: [], yesterday: [], error: error.message };
        }
    }

    startRealTimeUpdates() {
        // Actualizar datos cada 30 segundos
        setInterval(async () => {
            if (this.dashboardState.connectedClients > 0) {
                try {
                    // Actualizar overview del sistema
                    const overview = await this.getSystemOverview();
                    this.io.emit('systemOverview', overview);
                    
                    // Actualizar estadísticas de recargas
                    const rechargeStats = await this.getRechargeStats();
                    this.io.emit('rechargeStats', rechargeStats);
                    
                    this.dashboardState.lastUpdate = Date.now();
                } catch (error) {
                    console.error('Error en actualización en tiempo real:', error.message);
                }
            }
        }, 30000); // 30 segundos
        
        // Actualizar health checks cada 2 minutos
        setInterval(async () => {
            if (this.dashboardState.connectedClients > 0 && this.healthManager) {
                try {
                    const health = this.healthManager.getOverallHealth();
                    this.io.emit('healthUpdate', health);
                } catch (error) {
                    console.error('Error en actualización de health checks:', error.message);
                }
            }
        }, 120000); // 2 minutos
    }

    async start() {
        try {
            // Iniciar health checks si están disponibles
            if (this.healthManager) {
                await this.healthManager.start();
                this.dashboardState.isHealthCheckRunning = true;
                console.log('✅ Health checks iniciados en el dashboard');
            }
            
            // Iniciar actualizaciones en tiempo real
            this.startRealTimeUpdates();
            
            // Iniciar servidor
            this.server.listen(this.port, () => {
                console.log(`🚀 Dashboard Server ejecutándose en puerto ${this.port}`);
                console.log(`📊 Dashboard disponible en: http://localhost:${this.port}`);
            });
            
        } catch (error) {
            console.error('❌ Error iniciando dashboard server:', error.message);
            throw error;
        }
    }

    async stop() {
        try {
            if (this.healthManager && this.dashboardState.isHealthCheckRunning) {
                await this.healthManager.stop();
                console.log('🛑 Health checks detenidos');
            }
            
            this.server.close(() => {
                console.log('🛑 Dashboard Server detenido');
            });
        } catch (error) {
            console.error('❌ Error deteniendo dashboard server:', error.message);
        }
    }
}

// Función para uso desde línea de comandos
async function startDashboard() {
    const dashboard = new DashboardServer();
    
    try {
        await dashboard.start();
        
        // Manejar cierre limpio
        process.on('SIGINT', async () => {
            console.log('\n🛑 Recibida señal de cierre...');
            await dashboard.stop();
            process.exit(0);
        });
        
    } catch (error) {
        console.error('❌ Error iniciando dashboard:', error.message);
        process.exit(1);
    }
}

// Ejecutar si se llama directamente
if (require.main === module) {
    startDashboard();
}

module.exports = DashboardServer;