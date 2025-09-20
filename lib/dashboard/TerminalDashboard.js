/**
 * TerminalDashboard - Dashboard profesional para terminal
 * Visualización avanzada de progreso y eventos en tiempo real
 */

const { EventTypes, EventIcons, EventColors, Services } = require('../events/EventTypes');
const { getEventBus } = require('../events/EventBus');

class TerminalDashboard {
    constructor(options = {}) {
        this.options = {
            maxEvents: 10,
            refreshRate: 100, // ms
            width: process.stdout.columns || 80,
            height: process.stdout.rows || 24,
            showMetrics: true,
            showProgress: true,
            showEvents: true,
            colors: true,
            ...options
        };

        this.eventBus = getEventBus();
        this.isActive = false;
        this.refreshTimer = null;
        this.lastRender = '';

        // Estado del dashboard
        this.state = {
            currentProgress: {},
            recentEvents: [],
            metrics: {},
            activeProcesses: {},
            systemStatus: 'idle'
        };

        // Configurar limpieza al salir
        process.on('SIGINT', () => this.stop());
        process.on('SIGTERM', () => this.stop());

        this.setupEventListeners();
    }

    /**
     * Configurar listeners del EventBus
     */
    setupEventListeners() {
        // Listener para todos los eventos (historial)
        this.eventBus.subscribeToAll((event) => {
            this.addEvent(event);
        });

        // Listener específico para progreso
        this.eventBus.subscribe(EventTypes.PROGRESS_UPDATE, (event) => {
            this.updateProgress(event.service, event.data);
        });

        // Listener para métricas
        this.eventBus.subscribe(EventTypes.METRICS_UPDATE, (event) => {
            this.updateMetrics(event.service, event.data);
        });

        // Listener para procesos
        this.eventBus.subscribe(EventTypes.PROCESS_START, (event) => {
            this.state.activeProcesses[event.service] = {
                startTime: event.timestamp,
                processId: event.data.processId
            };
            this.state.systemStatus = 'processing';
        });

        this.eventBus.subscribe(EventTypes.PROCESS_END, (event) => {
            delete this.state.activeProcesses[event.service];
            if (Object.keys(this.state.activeProcesses).length === 0) {
                this.state.systemStatus = 'idle';
            }
        });
    }

    /**
     * Iniciar el dashboard
     */
    start() {
        if (this.isActive) return;

        this.isActive = true;

        // Limpiar pantalla y ocultar cursor
        this.clearScreen();
        this.hideCursor();

        // Renderizar inmediatamente
        this.render();

        // Configurar actualización automática
        this.refreshTimer = setInterval(() => {
            if (this.isActive) {
                this.render();
            }
        }, this.options.refreshRate);

        console.log('🎯 TerminalDashboard iniciado');
    }

    /**
     * Detener el dashboard
     */
    stop() {
        if (!this.isActive) return;

        this.isActive = false;

        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = null;
        }

        // Mostrar cursor y mover al final
        this.showCursor();
        this.moveCursorToEnd();

        console.log('\n👋 TerminalDashboard detenido');
    }

    /**
     * Agregar evento al historial
     */
    addEvent(event) {
        this.state.recentEvents.unshift(event);

        // Mantener solo los últimos N eventos
        if (this.state.recentEvents.length > this.options.maxEvents) {
            this.state.recentEvents = this.state.recentEvents.slice(0, this.options.maxEvents);
        }
    }

    /**
     * Actualizar progreso de un servicio
     */
    updateProgress(service, progressData) {
        this.state.currentProgress[service] = {
            ...progressData,
            lastUpdate: Date.now()
        };
    }

    /**
     * Actualizar métricas de un servicio
     */
    updateMetrics(service, metricsData) {
        this.state.metrics[service] = {
            ...metricsData,
            lastUpdate: Date.now()
        };
    }

    /**
     * Renderizar el dashboard completo
     */
    render() {
        if (!this.isActive) return;

        const output = this.buildDashboard();

        // Solo actualizar si hay cambios (evitar parpadeo)
        if (output !== this.lastRender) {
            this.clearScreen();
            process.stdout.write(output);
            this.lastRender = output;
        }
    }

    /**
     * Construir el contenido completo del dashboard
     */
    buildDashboard() {
        const width = this.options.width;
        const lines = [];

        // Header
        lines.push(this.buildHeader(width));
        lines.push(this.buildSeparator(width));

        // Progress Section
        if (this.options.showProgress) {
            lines.push(this.buildProgressSection(width));
            lines.push(this.buildSeparator(width));
        }

        // Events Section
        if (this.options.showEvents) {
            lines.push(this.buildEventsSection(width));
            lines.push(this.buildSeparator(width));
        }

        // Metrics Section
        if (this.options.showMetrics) {
            lines.push(this.buildMetricsSection(width));
        }

        lines.push(this.buildFooter(width));

        return lines.join('\n');
    }

    /**
     * Construir header del dashboard
     */
    buildHeader(width) {
        const timestamp = new Date().toLocaleString('es-MX', {
            timeZone: 'America/Mazatlan',
            hour12: false
        });

        const title = '🚀 SISTEMA DE RECARGAS v2.2';
        const status = this.state.systemStatus.toUpperCase();
        const statusIcon = this.state.systemStatus === 'processing' ? '🟢' : '🟡';

        const left = `║ ${title}`;
        const right = `${statusIcon} ${status} | ${timestamp} ║`;
        const padding = width - left.length - right.length;

        return `╔${'═'.repeat(width - 2)}╗\n${left}${' '.repeat(Math.max(0, padding))}${right}`;
    }

    /**
     * Construir separador
     */
    buildSeparator(width, char = '═') {
        return `╠${char.repeat(width - 2)}╣`;
    }

    /**
     * Construir sección de progreso
     */
    buildProgressSection(width) {
        const lines = ['║ 📊 PROGRESO ACTUAL' + ' '.repeat(width - 21) + '║'];

        if (Object.keys(this.state.currentProgress).length === 0) {
            lines.push(`║ ${' '.repeat(width - 4)} ║`);
            lines.push(`║ 💤 Sistema en espera - No hay procesos activos${' '.repeat(width - 52)} ║`);
            lines.push(`║ ${' '.repeat(width - 4)} ║`);
        } else {
            lines.push(`║ ┌${'─'.repeat(width - 6)}┐ ║`);

            Object.entries(this.state.currentProgress).forEach(([service, progress]) => {
                const progressLine = this.buildProgressBar(service, progress, width - 8);
                lines.push(`║ │ ${progressLine}│ ║`);

                const detailLine = this.buildProgressDetails(progress, width - 8);
                lines.push(`║ │ ${detailLine}│ ║`);

                lines.push(`║ │${' '.repeat(width - 6)}│ ║`);
            });

            lines.push(`║ └${'─'.repeat(width - 6)}┘ ║`);
        }

        return lines.join('\n');
    }

    /**
     * Construir barra de progreso individual
     */
    buildProgressBar(service, progress, maxWidth) {
        const serviceIcon = service === 'GPS' ? '🟢' : service === 'VOZ' ? '🔵' : '🟡';
        const percentage = progress.percentage || 0;
        const current = progress.current || 0;
        const total = progress.total || 0;

        const barWidth = 30;
        const filled = Math.round((percentage / 100) * barWidth);
        const empty = barWidth - filled;

        const bar = this.options.colors ?
            `\x1b[32m${'█'.repeat(filled)}\x1b[37m${'░'.repeat(empty)}\x1b[0m` :
            `${'█'.repeat(filled)}${'░'.repeat(empty)}`;

        const info = `${percentage.toString().padStart(3)}% (${current}/${total})`;
        const line = `${serviceIcon} ${service}: ${bar} ${info}`;

        return line.padEnd(maxWidth);
    }

    /**
     * Construir detalles del progreso
     */
    buildProgressDetails(progress, maxWidth) {
        const message = progress.message || 'Procesando...';
        const truncatedMessage = message.length > maxWidth - 4 ?
            message.substring(0, maxWidth - 7) + '...' :
            message;

        return `⚡ ${truncatedMessage}`.padEnd(maxWidth);
    }

    /**
     * Construir sección de eventos
     */
    buildEventsSection(width) {
        const lines = ['║ 📝 EVENTOS EN TIEMPO REAL' + ' '.repeat(width - 29) + '║'];

        if (this.state.recentEvents.length === 0) {
            lines.push(`║ ${' '.repeat(width - 4)} ║`);
            lines.push(`║ 📭 No hay eventos recientes${' '.repeat(width - 33)} ║`);
            lines.push(`║ ${' '.repeat(width - 4)} ║`);
        } else {
            this.state.recentEvents.slice(0, this.options.maxEvents).forEach(event => {
                const eventLine = this.buildEventLine(event, width - 4);
                lines.push(`║ ${eventLine} ║`);
            });
        }

        return lines.join('\n');
    }

    /**
     * Construir línea de evento individual
     */
    buildEventLine(event, maxWidth) {
        const icon = EventIcons[event.type] || EventIcons.default;
        const timestamp = new Date(event.timestamp).toLocaleTimeString('es-MX', {
            hour12: false,
            timeZone: 'America/Mazatlan'
        });

        let message = '';

        // Formatear mensaje según tipo de evento
        switch (event.type) {
            case EventTypes.RECHARGE_SUCCESS:
                message = `${event.data.vehicle || 'DEVICE'} [${event.data.company || 'N/A'}] - Recarga exitosa ($${event.data.amount || 10})`;
                break;
            case EventTypes.RECHARGE_ERROR:
                message = `${event.data.vehicle || 'DEVICE'} [${event.data.company || 'N/A'}] - Error: ${event.data.error?.message || 'Unknown'}`;
                break;
            case EventTypes.PROCESS_START:
                message = `Iniciando proceso ${event.service}`;
                break;
            case EventTypes.PROCESS_END:
                message = `Proceso ${event.service} completado`;
                break;
            case EventTypes.QUEUE_UPDATE:
                message = `Cola auxiliar: ${event.data.pending || 0} items pendientes`;
                break;
            default:
                message = event.data.message || event.type;
        }

        // Truncar mensaje si es muy largo
        const maxMessageLength = maxWidth - timestamp.length - 6; // icon + spaces + timestamp
        if (message.length > maxMessageLength) {
            message = message.substring(0, maxMessageLength - 3) + '...';
        }

        const color = this.options.colors ? (EventColors[event.type] || EventColors.default) : '';
        const reset = this.options.colors ? '\x1b[0m' : '';

        return `${color}├─ ${icon} ${timestamp} ${message}${reset}`.padEnd(maxWidth);
    }

    /**
     * Construir sección de métricas
     */
    buildMetricsSection(width) {
        const lines = ['║ 📈 ESTADÍSTICAS' + ' '.repeat(width - 19) + '║'];

        const globalMetrics = this.eventBus.getMetrics();
        const servicesData = [];

        // Recopilar datos de servicios
        Object.entries(this.state.metrics).forEach(([service, metrics]) => {
            servicesData.push({
                service,
                processed: metrics.processed || 0,
                successful: metrics.successful || 0,
                failed: metrics.failed || 0,
                pending: metrics.pending || 0
            });
        });

        if (servicesData.length === 0) {
            lines.push(`║ ├─ Procesados: 0 | Exitosos: 0 | Errores: 0 | Pendientes: 0${' '.repeat(width - 63)} ║`);
        } else {
            servicesData.forEach(data => {
                const metricsLine = `├─ ${data.service}: Procesados: ${data.processed} | Exitosos: ${data.successful} | Errores: ${data.failed} | Pendientes: ${data.pending}`;
                lines.push(`║ ${metricsLine.padEnd(width - 4)} ║`);
            });
        }

        // Información del sistema
        const uptime = Math.round(globalMetrics.uptime / 1000);
        const nextExecution = this.getNextExecutionTime();
        lines.push(`║ └─ Uptime: ${uptime}s | Próxima ejecución: ${nextExecution}${' '.repeat(width - 4 - `└─ Uptime: ${uptime}s | Próxima ejecución: ${nextExecution}`.length)} ║`);

        return lines.join('\n');
    }

    /**
     * Construir footer del dashboard
     */
    buildFooter(width) {
        return `╚${'═'.repeat(width - 2)}╝`;
    }

    /**
     * Obtener próximo tiempo de ejecución
     */
    getNextExecutionTime() {
        // Esto debería conectarse con el scheduler real
        // Por ahora, usar GPS como referencia (cada 10 minutos)
        const now = new Date();
        const next = new Date(now);
        next.setMinutes(Math.ceil(now.getMinutes() / 10) * 10, 0, 0);

        return next.toLocaleTimeString('es-MX', {
            hour12: false,
            timeZone: 'America/Mazatlan'
        });
    }

    /**
     * Utilidades de terminal
     */
    clearScreen() {
        process.stdout.write('\x1b[2J\x1b[H');
    }

    hideCursor() {
        process.stdout.write('\x1b[?25l');
    }

    showCursor() {
        process.stdout.write('\x1b[?25h');
    }

    moveCursorToEnd() {
        process.stdout.write('\x1b[999;999H');
    }

    /**
     * Pausar/reanudar actualización
     */
    pause() {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = null;
        }
    }

    resume() {
        if (this.isActive && !this.refreshTimer) {
            this.refreshTimer = setInterval(() => {
                if (this.isActive) {
                    this.render();
                }
            }, this.options.refreshRate);
        }
    }

    /**
     * Actualizar configuración
     */
    updateOptions(newOptions) {
        this.options = { ...this.options, ...newOptions };

        // Actualizar dimensiones si cambió el terminal
        this.options.width = process.stdout.columns || this.options.width;
        this.options.height = process.stdout.rows || this.options.height;
    }
}

// Instancia singleton
let dashboardInstance = null;

/**
 * Obtener instancia del dashboard
 */
function getTerminalDashboard(options = {}) {
    if (!dashboardInstance) {
        dashboardInstance = new TerminalDashboard(options);
    }
    return dashboardInstance;
}

/**
 * Inicializar dashboard si está habilitado
 */
function initializeTerminalDashboard(options = {}) {
    // Solo inicializar si no estamos en modo headless
    const isHeadless = process.env.HEADLESS === 'true' ||
                      process.env.NODE_ENV === 'test' ||
                      !process.stdout.isTTY;

    if (isHeadless) {
        return null;
    }

    const dashboard = getTerminalDashboard(options);
    dashboard.start();

    return dashboard;
}

module.exports = {
    TerminalDashboard,
    getTerminalDashboard,
    initializeTerminalDashboard
};