/**
 * DashboardServer - Servidor Socket.IO para dashboard web
 * Expone eventos del sistema vía WebSocket para visualización web
 */

const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { EventTypes, EventPriorities } = require('../events/EventTypes');
const { getEventBus } = require('../events/EventBus');

class DashboardServer {
    constructor(options = {}) {
        this.options = {
            port: process.env.DASHBOARD_PORT || 3001,
            host: process.env.DASHBOARD_HOST || 'localhost',
            cors: {
                origin: "*",
                methods: ["GET", "POST"]
            },
            rateLimit: {
                maxConnections: 50,
                eventLimit: 100 // eventos por segundo por cliente
            },
            ...options
        };

        this.app = express();
        this.server = createServer(this.app);
        this.io = new Server(this.server, {
            cors: this.options.cors
        });

        this.eventBus = getEventBus();
        this.isRunning = false;
        this.clients = new Map();
        this.eventBuffer = [];
        this.maxBufferSize = 1000;

        this.setupExpress();
        this.setupSocketIO();
        this.setupEventListeners();

        console.log('🌐 DashboardServer inicializado');
    }

    /**
     * Configurar rutas Express
     */
    setupExpress() {
        // Servir archivos estáticos
        this.app.use(express.static(path.join(__dirname, '../../public')));

        // Ruta principal del dashboard
        this.app.get('/', (req, res) => {
            res.sendFile(path.join(__dirname, '../../public/dashboard.html'));
        });

        // API para obtener estado actual
        this.app.get('/api/status', (req, res) => {
            const metrics = this.eventBus.getMetrics();
            const progress = this.eventBus.getCurrentProgress();
            const activeProcesses = this.eventBus.getActiveProcesses();
            const recentEvents = this.eventBus.getEventHistory({ limit: 20 });

            res.json({
                status: 'ok',
                uptime: metrics.uptime,
                metrics,
                progress,
                activeProcesses,
                recentEvents,
                connectedClients: this.clients.size
            });
        });

        // API para obtener historial de eventos
        this.app.get('/api/events', (req, res) => {
            const { limit = 50, service, type, priority } = req.query;
            const events = this.eventBus.getEventHistory({
                limit: parseInt(limit),
                service,
                type,
                priority: priority ? parseInt(priority) : null
            });

            res.json({
                events,
                total: events.length
            });
        });

        // API para obtener métricas
        this.app.get('/api/metrics', (req, res) => {
            const metrics = this.eventBus.getMetrics();
            res.json(metrics);
        });

        // Health check
        this.app.get('/health', (req, res) => {
            res.json({
                status: 'healthy',
                uptime: process.uptime(),
                memory: process.memoryUsage(),
                timestamp: new Date().toISOString()
            });
        });
    }

    /**
     * Configurar Socket.IO
     */
    setupSocketIO() {
        this.io.on('connection', (socket) => {
            this.handleClientConnection(socket);
        });

        // Middleware para rate limiting
        this.io.use((socket, next) => {
            const clientInfo = {
                id: socket.id,
                ip: socket.handshake.address,
                userAgent: socket.handshake.headers['user-agent'],
                connectedAt: Date.now(),
                eventCount: 0,
                lastEvent: 0
            };

            this.clients.set(socket.id, clientInfo);
            next();
        });
    }

    /**
     * Manejar conexión de cliente
     */
    handleClientConnection(socket) {
        const clientInfo = this.clients.get(socket.id);
        console.log(`📱 Cliente conectado: ${socket.id} (${clientInfo.ip})`);

        // Enviar estado inicial
        this.sendInitialState(socket);

        // Manejar subscripciones
        socket.on('subscribe', (options = {}) => {
            this.handleSubscription(socket, options);
        });

        // Manejar solicitudes de datos
        socket.on('request:events', (options = {}) => {
            this.sendEvents(socket, options);
        });

        socket.on('request:metrics', () => {
            this.sendMetrics(socket);
        });

        socket.on('request:progress', () => {
            this.sendProgress(socket);
        });

        // Manejar comandos (si está habilitado)
        socket.on('command', (command) => {
            this.handleCommand(socket, command);
        });

        // Manejar desconexión
        socket.on('disconnect', (reason) => {
            this.handleClientDisconnection(socket, reason);
        });

        // Ping/Pong para mantener conexión
        socket.on('ping', () => {
            socket.emit('pong', { timestamp: Date.now() });
        });
    }

    /**
     * Enviar estado inicial al cliente
     */
    sendInitialState(socket) {
        const metrics = this.eventBus.getMetrics();
        const progress = this.eventBus.getCurrentProgress();
        const activeProcesses = this.eventBus.getActiveProcesses();
        const recentEvents = this.eventBus.getEventHistory({ limit: 10 });

        socket.emit('initial-state', {
            metrics,
            progress,
            activeProcesses,
            recentEvents,
            serverInfo: {
                version: '2.2.0',
                uptime: metrics.uptime,
                connectedClients: this.clients.size
            }
        });
    }

    /**
     * Manejar subscripciones de cliente
     */
    handleSubscription(socket, options) {
        const { services = [], eventTypes = [], priority = null } = options;

        // Guardar preferencias de subscripción
        const clientInfo = this.clients.get(socket.id);
        if (clientInfo) {
            clientInfo.subscription = {
                services,
                eventTypes,
                priority,
                subscribedAt: Date.now()
            };
        }

        socket.emit('subscription-confirmed', {
            services,
            eventTypes,
            priority
        });
    }

    /**
     * Enviar eventos filtrados al cliente
     */
    sendEvents(socket, options = {}) {
        const events = this.eventBus.getEventHistory(options);
        socket.emit('events', { events });
    }

    /**
     * Enviar métricas al cliente
     */
    sendMetrics(socket) {
        const metrics = this.eventBus.getMetrics();
        socket.emit('metrics', metrics);
    }

    /**
     * Enviar progreso al cliente
     */
    sendProgress(socket) {
        const progress = this.eventBus.getCurrentProgress();
        socket.emit('progress', progress);
    }

    /**
     * Manejar comandos del cliente
     */
    handleCommand(socket, command) {
        const clientInfo = this.clients.get(socket.id);

        // Log del comando
        console.log(`📨 Comando recibido de ${socket.id}: ${command.type}`);

        switch (command.type) {
            case 'debug:stats':
                this.eventBus.debugStats();
                socket.emit('command-result', {
                    success: true,
                    message: 'Debug stats enviado a consola'
                });
                break;

            case 'debug:reset':
                this.eventBus.reset();
                socket.emit('command-result', {
                    success: true,
                    message: 'EventBus reset completado'
                });
                break;

            case 'metrics:export':
                const metrics = this.eventBus.getMetrics();
                socket.emit('command-result', {
                    success: true,
                    data: metrics,
                    message: 'Métricas exportadas'
                });
                break;

            default:
                socket.emit('command-result', {
                    success: false,
                    message: `Comando desconocido: ${command.type}`
                });
        }
    }

    /**
     * Manejar desconexión de cliente
     */
    handleClientDisconnection(socket, reason) {
        const clientInfo = this.clients.get(socket.id);
        if (clientInfo) {
            const duration = Date.now() - clientInfo.connectedAt;
            console.log(`📱 Cliente desconectado: ${socket.id} (${reason}, ${Math.round(duration/1000)}s)`);
            this.clients.delete(socket.id);
        }
    }

    /**
     * Configurar listeners del EventBus
     */
    setupEventListeners() {
        // Listener para todos los eventos
        this.eventBus.subscribeToAll((event) => {
            this.broadcastEvent(event);
            this.addToBuffer(event);
        });

        // Listeners específicos para eventos importantes
        this.eventBus.subscribe(EventTypes.PROGRESS_UPDATE, (event) => {
            this.broadcastProgress(event);
        });

        this.eventBus.subscribe(EventTypes.METRICS_UPDATE, (event) => {
            this.broadcastMetrics(event);
        });

        // Broadcast de eventos de alta prioridad inmediatamente
        this.eventBus.subscribeToHighPriority((event) => {
            this.broadcastHighPriority(event);
        });
    }

    /**
     * Broadcast evento a todos los clientes conectados
     */
    broadcastEvent(event) {
        if (!this.isRunning) return;

        // Filtrar por subscripciones de cliente
        this.clients.forEach((clientInfo, socketId) => {
            if (this.shouldSendToClient(clientInfo, event)) {
                const socket = this.io.sockets.sockets.get(socketId);
                if (socket) {
                    socket.emit('event', event);
                    clientInfo.eventCount++;
                    clientInfo.lastEvent = Date.now();
                }
            }
        });
    }

    /**
     * Broadcast progreso a clientes
     */
    broadcastProgress(event) {
        this.io.emit('progress-update', {
            service: event.service,
            progress: event.data
        });
    }

    /**
     * Broadcast métricas a clientes
     */
    broadcastMetrics(event) {
        this.io.emit('metrics-update', {
            service: event.service,
            metrics: event.data
        });
    }

    /**
     * Broadcast eventos de alta prioridad
     */
    broadcastHighPriority(event) {
        this.io.emit('high-priority-event', event);
    }

    /**
     * Determinar si enviar evento a cliente específico
     */
    shouldSendToClient(clientInfo, event) {
        if (!clientInfo.subscription) return true;

        const { services, eventTypes, priority } = clientInfo.subscription;

        // Filtrar por servicio
        if (services.length > 0 && !services.includes(event.service)) {
            return false;
        }

        // Filtrar por tipo de evento
        if (eventTypes.length > 0 && !eventTypes.includes(event.type)) {
            return false;
        }

        // Filtrar por prioridad mínima
        if (priority !== null && event.priority < priority) {
            return false;
        }

        return true;
    }

    /**
     * Agregar evento al buffer
     */
    addToBuffer(event) {
        this.eventBuffer.unshift(event);

        if (this.eventBuffer.length > this.maxBufferSize) {
            this.eventBuffer = this.eventBuffer.slice(0, this.maxBufferSize);
        }
    }

    /**
     * Iniciar servidor
     */
    async start() {
        if (this.isRunning) {
            throw new Error('DashboardServer ya está corriendo');
        }

        return new Promise((resolve, reject) => {
            this.server.listen(this.options.port, this.options.host, (err) => {
                if (err) {
                    reject(err);
                    return;
                }

                this.isRunning = true;
                console.log(`🚀 DashboardServer iniciado en http://${this.options.host}:${this.options.port}`);
                console.log(`📊 Dashboard disponible en http://${this.options.host}:${this.options.port}`);
                resolve();
            });
        });
    }

    /**
     * Detener servidor
     */
    async stop() {
        if (!this.isRunning) return;

        return new Promise((resolve) => {
            this.server.close(() => {
                this.isRunning = false;
                console.log('🛑 DashboardServer detenido');
                resolve();
            });
        });
    }

    /**
     * Obtener estadísticas del servidor
     */
    getStats() {
        return {
            isRunning: this.isRunning,
            connectedClients: this.clients.size,
            totalEvents: this.eventBuffer.length,
            uptime: this.isRunning ? Date.now() - this.startTime : 0,
            port: this.options.port,
            host: this.options.host
        };
    }

    /**
     * Broadcast personalizado
     */
    broadcast(eventName, data) {
        this.io.emit(eventName, data);
    }

    /**
     * Enviar a cliente específico
     */
    sendToClient(socketId, eventName, data) {
        const socket = this.io.sockets.sockets.get(socketId);
        if (socket) {
            socket.emit(eventName, data);
        }
    }
}

// Instancia singleton
let serverInstance = null;

/**
 * Obtener instancia del servidor
 */
function getDashboardServer(options = {}) {
    if (!serverInstance) {
        serverInstance = new DashboardServer(options);
    }
    return serverInstance;
}

/**
 * Inicializar servidor si está habilitado
 */
async function initializeDashboardServer(options = {}) {
    const isEnabled = process.env.ENABLE_WEB_DASHBOARD === 'true' ||
                     process.env.NODE_ENV === 'development';

    if (!isEnabled) {
        console.log('🌐 Dashboard web deshabilitado (ENABLE_WEB_DASHBOARD=false)');
        return null;
    }

    try {
        const server = getDashboardServer(options);
        await server.start();
        return server;
    } catch (error) {
        console.error('❌ Error iniciando DashboardServer:', error.message);
        return null;
    }
}

module.exports = {
    DashboardServer,
    getDashboardServer,
    initializeDashboardServer
};