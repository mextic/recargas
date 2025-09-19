/**
 * Gestor Centralizado de Barras de Progreso
 * Maneja múltiples servicios ejecutándose en paralelo sin interferencias
 */

class ProgressManager {
    constructor() {
        this.activeServices = new Map(); // Servicios activos con su progreso
        this.renderInterval = null;
        this.isRendering = false;
        this.lastFullRender = 0;
        this.renderThrottle = 100; // Actualizar cada 100ms
        this.safetyTimeout = null; // Timeout de seguridad para evitar quedarse atascado

        // Configuración visual
        this.colors = {
            GPS: '\x1b[32m',    // Verde
            VOZ: '\x1b[34m',    // Azul
            ELIOT: '\x1b[33m',  // Amarillo
            reset: '\x1b[0m',   // Reset
            bold: '\x1b[1m',    // Negrita
            dim: '\x1b[2m'      // Atenuado
        };

        this.icons = {
            GPS: '🟢',
            VOZ: '🔵',
            ELIOT: '🟡'
        };
    }

    /**
     * Singleton pattern - Una sola instancia global
     */
    static getInstance() {
        if (!ProgressManager.instance) {
            ProgressManager.instance = new ProgressManager();
        }
        return ProgressManager.instance;
    }

    /**
     * Registra un nuevo servicio para monitoreo
     */
    register(service, total, initialMessage = '') {
        this.activeServices.set(service, {
            current: 0,
            total: total,
            message: initialMessage || `Iniciando ${service}...`,
            startTime: Date.now(),
            status: 'active' // active, completed, error
        });

        // Activar modo silencioso global
        global.PROGRESS_ACTIVE = true;

        // Iniciar renderizado si no está activo
        this.startRendering();

        // Render inicial inmediato
        this.renderAll(true);
    }

    /**
     * Actualiza el progreso de un servicio
     */
    update(service, current, message = null) {
        if (!this.activeServices.has(service)) {
            return;
        }

        const serviceData = this.activeServices.get(service);
        serviceData.current = Math.min(current, serviceData.total);

        if (message) {
            serviceData.message = message;
        }

        this.activeServices.set(service, serviceData);
    }

    /**
     * Marca un servicio como completado
     */
    complete(service, finalMessage = null) {
        if (!this.activeServices.has(service)) {
            return;
        }

        const serviceData = this.activeServices.get(service);
        serviceData.current = serviceData.total;
        serviceData.status = 'completed';
        serviceData.message = finalMessage || '✅ Completado';

        this.activeServices.set(service, serviceData);

        // Render inmediato para mostrar completado
        this.renderAll(true);

        // Esperar un momento para que se vea el mensaje de completado
        setTimeout(() => {
            this.unregister(service);
        }, 2000); // 2 segundos para ver el mensaje final

        // Si ya no hay servicios activos, parar renderizado
        if (this.getAllActiveServices().length === 0) {
            this.stopRendering();
            this.cleanupAfterCompletion();
        }
    }

    /**
     * Marca un servicio como error
     */
    fail(service, errorMessage = null) {
        if (!this.activeServices.has(service)) {
            return;
        }

        const serviceData = this.activeServices.get(service);
        serviceData.status = 'error';
        serviceData.message = errorMessage || '❌ Error';

        this.activeServices.set(service, serviceData);

        // Render inmediato para mostrar error
        this.renderAll(true);
    }

    /**
     * Desregistra un servicio (lo remueve del display)
     */
    unregister(service) {
        this.activeServices.delete(service);

        // Si ya no hay servicios, parar todo
        if (this.activeServices.size === 0) {
            this.stopRendering();
            this.cleanupAfterCompletion();
        }
    }

    /**
     * Limpieza completa después de que todos los servicios terminen
     */
    cleanupAfterCompletion() {
        // Limpiar display completamente
        this.clearDisplay();

        // Liberar estado global
        global.PROGRESS_ACTIVE = false;

        // Limpiar referencias internas
        this.activeServices.clear();

        // Parar cualquier renderizado pendiente
        if (this.renderInterval) {
            clearInterval(this.renderInterval);
            this.renderInterval = null;
        }

        // Resetear estado
        this.isRendering = false;
        this.lastFullRender = 0;

        // Mensaje final de limpieza (opcional)
        console.log(''); // Línea en blanco para separar

        console.log('🔄 Sistema regresado a estado normal');
    }

    /**
     * Obtiene servicios que están aún activos (no completados)
     */
    getAllActiveServices() {
        return Array.from(this.activeServices.entries())
            .filter(([_, data]) => data.status === 'active');
    }

    /**
     * Inicia el renderizado automático
     */
    startRendering() {
        if (this.renderInterval) {
            return; // Ya está renderizando
        }

        this.renderInterval = setInterval(() => {
            this.renderAll();
        }, this.renderThrottle);
    }

    /**
     * Para el renderizado automático
     */
    stopRendering() {
        if (this.renderInterval) {
            clearInterval(this.renderInterval);
            this.renderInterval = null;
        }
        this.isRendering = false;
    }

    /**
     * Limpia el display completo
     */
    clearDisplay() {
        // Mover cursor al inicio y limpiar las líneas usadas
        const servicesToClear = this.activeServices.size + 3; // Servicios + header + footer
        for (let i = 0; i < servicesToClear; i++) {
            process.stdout.write('\x1B[2K\x1B[1A'); // Limpiar línea y subir
        }
        process.stdout.write('\x1B[2K\r'); // Limpiar línea actual
    }

    /**
     * Renderiza todas las barras de progreso activas
     */
    renderAll(forceRender = false) {
        const now = Date.now();

        // Throttle renders para performance
        if (!forceRender && now - this.lastFullRender < this.renderThrottle) {
            return;
        }

        if (this.isRendering && !forceRender) {
            return; // Evitar renders concurrentes
        }

        this.isRendering = true;
        this.lastFullRender = now;

        try {
            // Limpiar display anterior si existe
            if (this.activeServices.size > 0) {
                this.clearDisplay();
            }

            // Header
            this.renderHeader();

            // Renderizar cada servicio
            for (const [service, data] of this.activeServices) {
                this.renderServiceBar(service, data);
            }

            // Footer con resumen
            this.renderFooter();

        } catch (error) {
            // En caso de error en render, no crashear
            console.error('Error en ProgressManager render:', error.message);
        } finally {
            this.isRendering = false;
        }
    }

    /**
     * Renderiza el header del dashboard
     */
    renderHeader() {
        const headerLine = '═'.repeat(65);
        console.log(`${this.colors.bold}${headerLine}${this.colors.reset}`);
        console.log(`${this.colors.bold}                 SISTEMA DE RECARGAS v2.0${this.colors.reset}`);
        console.log(`${this.colors.bold}${headerLine}${this.colors.reset}`);
    }

    /**
     * Renderiza la barra de progreso de un servicio específico
     */
    renderServiceBar(service, data) {
        const { current, total, message, startTime, status } = data;

        // Calcular porcentaje
        const percentage = total > 0 ? Math.round((current / total) * 100) : 0;

        // Crear barra visual (30 caracteres)
        const barWidth = 30;
        const filled = Math.round((current / total) * barWidth);
        const empty = barWidth - filled;

        const serviceColor = this.colors[service] || '';
        const icon = this.icons[service] || '📊';

        let bar;
        if (status === 'completed') {
            bar = `${this.colors.GPS}${'█'.repeat(barWidth)}${this.colors.reset}`;
        } else if (status === 'error') {
            bar = `${this.colors.reset}${'▓'.repeat(filled)}${'░'.repeat(empty)}${this.colors.reset}`;
        } else {
            bar = `${serviceColor}${'█'.repeat(filled)}${this.colors.reset}${'░'.repeat(empty)}`;
        }

        // Calcular tiempo transcurrido
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        const elapsedStr = elapsed > 60 ? `${Math.floor(elapsed/60)}m ${elapsed%60}s` : `${elapsed}s`;

        // Truncar mensaje si es muy largo
        const maxMessageLength = 25;
        const truncatedMessage = message.length > maxMessageLength ?
            message.substring(0, maxMessageLength - 3) + '...' : message;

        // Línea de progreso
        const serviceName = service.padEnd(5);
        const progressText = `${current}/${total}`.padStart(8);
        const percentageText = `${percentage}%`.padStart(4);

        console.log(`${icon} ${serviceName} ${bar} ${percentageText} | ${progressText} | ${truncatedMessage}`);
    }

    /**
     * Renderiza el footer con resumen general
     */
    renderFooter() {
        const footerLine = '═'.repeat(65);

        const totalServices = this.activeServices.size;
        const activeCount = this.getAllActiveServices().length;
        const completedCount = Array.from(this.activeServices.values())
            .filter(data => data.status === 'completed').length;
        const errorCount = Array.from(this.activeServices.values())
            .filter(data => data.status === 'error').length;

        // Calcular tiempo total (el máximo de los start times)
        const oldestStartTime = Array.from(this.activeServices.values())
            .reduce((min, data) => Math.min(min, data.startTime), Date.now());
        const totalElapsed = Math.round((Date.now() - oldestStartTime) / 1000);
        const totalElapsedStr = totalElapsed > 60 ?
            `${Math.floor(totalElapsed/60)}m ${totalElapsed%60}s` : `${totalElapsed}s`;

        console.log(`${this.colors.bold}${footerLine}${this.colors.reset}`);
        console.log(`${this.colors.dim}Tiempo: ${totalElapsedStr} | Activos: ${activeCount} | Completados: ${completedCount} | Errores: ${errorCount}${this.colors.reset}`);
    }

    /**
     * Obtiene estadísticas generales
     */
    getStats() {
        const services = Array.from(this.activeServices.entries());
        return {
            total: services.length,
            active: services.filter(([_, data]) => data.status === 'active').length,
            completed: services.filter(([_, data]) => data.status === 'completed').length,
            errors: services.filter(([_, data]) => data.status === 'error').length
        };
    }
}

module.exports = ProgressManager;