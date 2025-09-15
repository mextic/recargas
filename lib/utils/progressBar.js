/**
 * Sistema de Barras de Progreso Animadas
 * Proporciona indicadores visuales para el progreso de recargas
 */

class ProgressBar {
    constructor(options = {}) {
        this.total = options.total || 100;
        this.current = 0;
        this.width = options.width || 50;
        this.format = options.format || '{bar} {percentage}% | {current}/{total} | {message}';
        this.message = options.message || '';
        this.startTime = Date.now();
        this.lastUpdate = 0;
        this.updateThreshold = options.updateThreshold || 100; // ms entre actualizaciones
        
        // Configuración visual
        this.filled = options.filled || '█';
        this.empty = options.empty || '░';
        this.prefix = options.prefix || '';
        this.suffix = options.suffix || '';
        
        // Colores por servicio
        this.colors = {
            GPS: '\x1b[32m',    // Verde
            VOZ: '\x1b[34m',    // Azul
            ELIOT: '\x1b[33m',  // Amarillo
            reset: '\x1b[0m'    // Reset
        };
        
        this.serviceColor = this.colors[options.service] || '';
    }

    /**
     * Actualiza el progreso
     */
    update(current, message = null) {
        const now = Date.now();
        
        // Throttle de actualizaciones para mejor performance
        if (now - this.lastUpdate < this.updateThreshold && current < this.total) {
            return;
        }
        
        this.current = Math.min(current, this.total);
        if (message) {
            this.message = message;
        }
        
        this.render();
        this.lastUpdate = now;
    }

    /**
     * Incrementa el progreso en 1
     */
    tick(message = null) {
        this.update(this.current + 1, message);
    }

    /**
     * Renderiza la barra de progreso
     */
    render() {
        const percentage = Math.round((this.current / this.total) * 100);
        const filled = Math.round((this.current / this.total) * this.width);
        const empty = this.width - filled;
        
        // Crear la barra visual
        const bar = this.serviceColor + 
                   this.filled.repeat(filled) + 
                   this.colors.reset + 
                   this.empty.repeat(empty);
        
        // Calcular tiempo transcurrido y ETA
        const elapsed = (Date.now() - this.startTime) / 1000;
        const rate = this.current / elapsed;
        const eta = this.current < this.total ? Math.round((this.total - this.current) / rate) : 0;
        
        // Formatear el output
        let output = this.format
            .replace('{bar}', bar)
            .replace('{percentage}', percentage.toString().padStart(3))
            .replace('{current}', this.current.toString())
            .replace('{total}', this.total.toString())
            .replace('{message}', this.message)
            .replace('{elapsed}', `${elapsed.toFixed(1)}s`)
            .replace('{eta}', eta > 0 ? `${eta}s` : 'Completado')
            .replace('{rate}', `${rate.toFixed(1)}/s`);
        
        // Escribir sin nueva línea (sobreescribir línea actual)
        process.stdout.write('\r' + this.prefix + output + this.suffix);
        
        // Si está completo, agregar nueva línea
        if (this.current >= this.total) {
            process.stdout.write('\n');
        }
    }

    /**
     * Completa la barra
     */
    complete(message = 'Completado') {
        this.update(this.total, message);
    }

    /**
     * Finaliza la barra con error
     */
    fail(message = 'Error') {
        this.message = `❌ ${message}`;
        this.render();
        process.stdout.write('\n');
    }
}

/**
 * Spinner para operaciones indeterminadas
 */
class Spinner {
    constructor(options = {}) {
        this.frames = options.frames || ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
        this.message = options.message || 'Procesando...';
        this.interval = options.interval || 80;
        this.current = 0;
        this.timer = null;
        this.isSpinning = false;
        
        this.serviceColor = options.service ? 
            {
                GPS: '\x1b[32m',
                VOZ: '\x1b[34m', 
                ELIOT: '\x1b[33m'
            }[options.service] || '' : '';
        this.resetColor = '\x1b[0m';
    }

    start(message = null) {
        if (this.isSpinning) return;
        
        if (message) this.message = message;
        this.isSpinning = true;
        
        this.timer = setInterval(() => {
            const frame = this.frames[this.current % this.frames.length];
            process.stdout.write(`\r${this.serviceColor}${frame}${this.resetColor} ${this.message}`);
            this.current++;
        }, this.interval);
    }

    update(message) {
        this.message = message;
    }

    stop(finalMessage = null) {
        if (!this.isSpinning) return;
        
        clearInterval(this.timer);
        this.isSpinning = false;
        
        if (finalMessage) {
            process.stdout.write(`\r✅ ${finalMessage}\n`);
        } else {
            process.stdout.write('\r');
        }
    }

    fail(errorMessage = 'Error') {
        if (!this.isSpinning) return;
        
        clearInterval(this.timer);
        this.isSpinning = false;
        process.stdout.write(`\r❌ ${errorMessage}\n`);
    }
}

/**
 * Factory para crear progress bars por servicio
 */
class ProgressFactory {
    static createServiceProgressBar(service, total, message = '') {
        const serviceConfig = {
            GPS: {
                service: 'GPS',
                prefix: '🟢 GPS: ',
                message: message || 'Procesando dispositivos GPS...'
            },
            VOZ: {
                service: 'VOZ',
                prefix: '🔵 VOZ: ',
                message: message || 'Procesando paquetes VOZ...'
            },
            ELIOT: {
                service: 'ELIOT',
                prefix: '🟡 ELIOT: ',
                message: message || 'Procesando dispositivos ELIoT...'
            }
        };

        const config = serviceConfig[service] || {
            service: service,
            prefix: `📊 ${service}: `,
            message: message || `Procesando ${service}...`
        };

        return new ProgressBar({
            total,
            format: '{prefix}{bar} {percentage}% | {current}/{total} | {message} | ETA: {eta}',
            updateThreshold: 50, // Actualizar cada 50ms para suavidad
            ...config
        });
    }

    static createServiceSpinner(service, message = '') {
        const serviceConfig = {
            GPS: {
                service: 'GPS',
                message: message || '🟢 Inicializando GPS...'
            },
            VOZ: {
                service: 'VOZ', 
                message: message || '🔵 Inicializando VOZ...'
            },
            ELIOT: {
                service: 'ELIOT',
                message: message || '🟡 Inicializando ELIoT...'
            }
        };

        const config = serviceConfig[service] || {
            service: service,
            message: message || `📊 Inicializando ${service}...`
        };

        return new Spinner(config);
    }

    /**
     * Crea múltiples progress bars para lote
     */
    static createBatchProgress(batches) {
        return batches.map(batch => 
            this.createServiceProgressBar(batch.service, batch.total, batch.message)
        );
    }
}

module.exports = {
    ProgressBar,
    Spinner,
    ProgressFactory
};