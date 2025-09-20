const fs = require('fs').promises;
const path = require('path');

class PersistenceQueueSystem {
    constructor(config = {}) {
        this.serviceType = config.serviceType || 'gps'; // 'gps', 'voz', 'eliot'
        this.dataDir = path.join(process.cwd(), 'data');
        this.auxiliaryQueueFile = path.join(this.dataDir, `${this.serviceType}_auxiliary_queue.json`);
        this.crashRecoveryFile = path.join(this.dataDir, `${this.serviceType}_crash_recovery.json`);
        
        this.auxiliaryQueue = [];
        this.maxRetries = config.maxRetries || 3;
        this.enableAutoRecovery = config.enableAutoRecovery !== false;
    }

    async initialize() {
        await fs.mkdir(this.dataDir, { recursive: true });
        await this.loadAuxiliaryQueue();
        
        if (this.enableAutoRecovery) {
            await this.checkCrashRecovery();
        }
    }

    async checkCrashRecovery() {
        try {
            const crashData = await this.loadCrashRecoveryData();
            
            if (crashData && crashData.wasProcessing) {
                console.log('   🔍 Recuperación ante crash detectada');
                console.log(`      • Items en proceso: ${crashData.itemsInProcess}`);
                
                // Recuperar items no procesados
                if (crashData.processingItems) {
                    for (const item of crashData.processingItems) {
                        await this.addToAuxiliaryQueue(item);
                    }
                }
                
                await this.clearCrashRecovery();
                return { itemsRecovered: crashData.itemsInProcess };
            }
        } catch (error) {
            console.error('Error en recuperación:', error);
        }
        
        return { itemsRecovered: 0 };
    }


    async addToAuxiliaryQueue(item, serviceType = null) {
        // Calcular fecha de expiración formateada según el servicio
        let fechaExpiracion = null;

        if (item.sim) {
            try {
                switch(serviceType?.toLowerCase()) {
                    case 'gps':
                        if (item.unix_saldo) {
                            // Convertir unix timestamp a fecha DD/MM/YYYY
                            const moment = require('moment-timezone');
                            fechaExpiracion = moment.unix(item.unix_saldo)
                                .tz('America/Mazatlan')
                                .format('DD/MM/YYYY');
                        }
                        break;

                    case 'voz':
                        if (item.fecha_expira_saldo) {
                            // Convertir fecha MySQL a DD/MM/YYYY
                            const moment = require('moment-timezone');
                            fechaExpiracion = moment(item.fecha_expira_saldo)
                                .tz('America/Mazatlan')
                                .format('DD/MM/YYYY');
                        }
                        break;

                    case 'eliot':
                        if (item.fecha_saldo) {
                            // Convertir fecha a DD/MM/YYYY
                            const moment = require('moment-timezone');
                            fechaExpiracion = moment(item.fecha_saldo)
                                .tz('America/Mazatlan')
                                .format('DD/MM/YYYY');
                        }
                        break;
                }
            } catch (error) {
                console.error(`Error formateando fecha expiración ${serviceType}: ${error.message}`);
            }
        }

        const auxItem = {
            ...item,
            id: `aux_${Date.now()}_${Math.random()}`,
            serviceType: serviceType || 'unknown',
            fechaExpiracion, // NUEVO: Fecha de expiración DD/MM/YYYY
            status: 'pending',
            attempts: 0,
            lastAttempt: null,
            error: null
        };

        this.auxiliaryQueue.push(auxItem);
        await this.saveAuxiliaryQueue();

        return auxItem.id;
    }

    /**
     * Marca un item como insertado exitosamente
     */
    async markItemAsInserted(itemId, sim) {
        const item = this.auxiliaryQueue.find(i => i.id === itemId || i.sim === sim);
        if (item) {
            item.status = 'inserted';
            item.lastAttempt = new Date().toISOString();
            await this.saveAuxiliaryQueue();
        }
    }

    /**
     * Marca un item como duplicado (ya existe en BD)
     */
    async markItemAsDuplicate(itemId, sim) {
        const item = this.auxiliaryQueue.find(i => i.id === itemId || i.sim === sim);
        if (item) {
            item.status = 'duplicate';
            item.lastAttempt = new Date().toISOString();
            await this.saveAuxiliaryQueue();
        }
    }

    /**
     * Marca un item como fallido
     */
    async markItemAsFailed(itemId, sim, error) {
        const item = this.auxiliaryQueue.find(i => i.id === itemId || i.sim === sim);
        if (item) {
            item.status = 'failed';
            item.attempts = (item.attempts || 0) + 1;
            item.lastAttempt = new Date().toISOString();
            item.error = error?.message || String(error);
            await this.saveAuxiliaryQueue();
        }
    }

    /**
     * Limpia items procesados exitosamente (inserted o duplicate)
     */
    async cleanProcessedItems() {
        const originalLength = this.auxiliaryQueue.length;

        this.auxiliaryQueue = this.auxiliaryQueue.filter(item =>
            item.status !== 'inserted' && item.status !== 'duplicate'
        );

        const cleanedCount = originalLength - this.auxiliaryQueue.length;

        if (cleanedCount > 0) {
            await this.saveAuxiliaryQueue();
        }

        return {
            cleaned: cleanedCount,
            remaining: this.auxiliaryQueue.length
        };
    }


    async getQueueStats() {
        const stats = {
            pending: 0,
            inserted: 0,
            duplicate: 0,
            failed: 0
        };

        this.auxiliaryQueue.forEach(item => {
            if (stats.hasOwnProperty(item.status)) {
                stats[item.status]++;
            } else {
                stats.pending++; // Default para estados no reconocidos
            }
        });

        return {
            auxiliaryQueue: {
                total: this.auxiliaryQueue.length,
                pending: stats.pending,
                inserted: stats.inserted,
                duplicate: stats.duplicate,
                failed: stats.failed,
                // Compatibilidad con código existente
                pendingDb: stats.pending + stats.failed
            }
        };
    }

    async loadAuxiliaryQueue() {
        try {
            const auxData = await fs.readFile(this.auxiliaryQueueFile, 'utf8');
            this.auxiliaryQueue = JSON.parse(auxData);
        } catch {
            this.auxiliaryQueue = [];
        }
    }


    async saveAuxiliaryQueue() {
        await fs.writeFile(
            this.auxiliaryQueueFile,
            JSON.stringify(this.auxiliaryQueue, null, 2)
        );
    }

    async loadCrashRecoveryData() {
        try {
            const data = await fs.readFile(this.crashRecoveryFile, 'utf8');
            return JSON.parse(data);
        } catch {
            return null;
        }
    }

    async markProcessingStart() {
        const crashData = {
            wasProcessing: true,
            timestamp: Date.now(),
            itemsInProcess: this.auxiliaryQueue.length,
            processingItems: this.auxiliaryQueue.slice(0, 10)
        };
        
        await fs.writeFile(
            this.crashRecoveryFile,
            JSON.stringify(crashData, null, 2)
        );
    }

    async markProcessingEnd() {
        await this.clearCrashRecovery();
    }

    async clearCrashRecovery() {
        try {
            await fs.unlink(this.crashRecoveryFile);
        } catch {
            // Archivo no existe
        }
    }
}

module.exports = { PersistenceQueueSystem };
