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


    async addToAuxiliaryQueue(item) {
        const auxItem = {
            ...item,
            id: `aux_${Date.now()}_${Math.random()}`,
            status: 'webservice_success_pending_db'
        };
        
        this.auxiliaryQueue.push(auxItem);
        await this.saveAuxiliaryQueue();
        
        return auxItem.id;
    }


    async getQueueStats() {
        return {
            auxiliaryQueue: {
                total: this.auxiliaryQueue.length,
                pendingDb: this.auxiliaryQueue.filter(i => 
                    i.status === 'webservice_success_pending_db' ||
                    i.status === 'db_insertion_failed_pending_recovery'
                ).length
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
