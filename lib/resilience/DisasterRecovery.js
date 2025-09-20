/**
 * DisasterRecovery - Sistema de recuperación ante desastres
 * Backup automático, snapshot del estado y procedimientos de recuperación
 */

const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { spawn } = require('child_process');
const { getEventBus } = require('../events/EventBus');
const { EventTypes } = require('../events/EventTypes');
const moment = require('moment-timezone');

const writeFile = promisify(fs.writeFile);
const readFile = promisify(fs.readFile);
const mkdir = promisify(fs.mkdir);
const readdir = promisify(fs.readdir);
const stat = promisify(fs.stat);

/**
 * Tipos de backup
 */
const BackupType = {
    FULL: 'FULL',           // Backup completo del sistema
    INCREMENTAL: 'INCREMENTAL', // Solo cambios desde último backup
    QUEUE: 'QUEUE',         // Solo colas auxiliares y DLQs
    CONFIG: 'CONFIG'        // Solo configuraciones
};

/**
 * Estado de recuperación
 */
const RecoveryState = {
    HEALTHY: 'HEALTHY',
    DEGRADED: 'DEGRADED',
    CRITICAL: 'CRITICAL',
    DISASTER: 'DISASTER'
};

class DisasterRecovery {
    constructor(options = {}) {
        this.options = {
            backupDir: options.backupDir || path.join(process.cwd(), 'backups'),
            retentionDays: options.retentionDays || 30,
            autoBackup: options.autoBackup !== false,
            backupInterval: options.backupInterval || 3600000, // 1 hora
            compressionLevel: options.compressionLevel || 6,
            enableEncryption: options.enableEncryption || false,
            maxBackupSize: options.maxBackupSize || 1024 * 1024 * 100, // 100MB
            ...options
        };

        this.eventBus = getEventBus();
        this.isRunning = false;
        this.lastBackup = null;
        this.recoveryState = RecoveryState.HEALTHY;

        // Componentes del sistema a monitorear
        this.systemComponents = {
            databases: {
                gps: { status: 'unknown', lastCheck: null },
                eliot: { status: 'unknown', lastCheck: null },
                redis: { status: 'unknown', lastCheck: null }
            },
            services: {
                webservices: { status: 'unknown', lastCheck: null },
                processors: { status: 'unknown', lastCheck: null },
                scheduler: { status: 'unknown', lastCheck: null }
            },
            files: {
                queues: { status: 'unknown', lastCheck: null },
                configs: { status: 'unknown', lastCheck: null },
                logs: { status: 'unknown', lastCheck: null }
            }
        };

        // Asegurar directorios
        this.ensureDirectories();

        // Configurar backup automático
        if (this.options.autoBackup) {
            this.scheduleAutoBackup();
        }

        console.log('🏥 DisasterRecovery inicializado:', {
            backupDir: this.options.backupDir,
            autoBackup: this.options.autoBackup,
            retentionDays: this.options.retentionDays
        });
    }

    /**
     * Asegurar que los directorios existen
     */
    async ensureDirectories() {
        const dirs = [
            this.options.backupDir,
            path.join(this.options.backupDir, 'full'),
            path.join(this.options.backupDir, 'incremental'),
            path.join(this.options.backupDir, 'queue'),
            path.join(this.options.backupDir, 'config'),
            path.join(this.options.backupDir, 'snapshots')
        ];

        for (const dir of dirs) {
            try {
                await mkdir(dir, { recursive: true });
            } catch (error) {
                if (error.code !== 'EEXIST') {
                    console.error(`❌ Error creando directorio ${dir}:`, error.message);
                }
            }
        }
    }

    /**
     * Crear backup del sistema
     */
    async createBackup(type = BackupType.FULL, options = {}) {
        const backupId = `${type.toLowerCase()}_${Date.now()}`;
        const timestamp = moment().tz('America/Mexico_City').format('YYYY-MM-DD_HH-mm-ss');

        console.log(`💾 Iniciando backup ${type}: ${backupId}`);

        try {
            const backupData = {
                id: backupId,
                type,
                timestamp: Date.now(),
                humanTime: timestamp,
                version: '2.3.0',
                components: {},
                metadata: {
                    nodeVersion: process.version,
                    platform: process.platform,
                    arch: process.arch,
                    cwd: process.cwd(),
                    env: process.env.NODE_ENV || 'development'
                }
            };

            // Backup según tipo
            switch (type) {
                case BackupType.FULL:
                    await this.createFullBackup(backupData);
                    break;
                case BackupType.INCREMENTAL:
                    await this.createIncrementalBackup(backupData);
                    break;
                case BackupType.QUEUE:
                    await this.createQueueBackup(backupData);
                    break;
                case BackupType.CONFIG:
                    await this.createConfigBackup(backupData);
                    break;
            }

            // Guardar metadata del backup
            await this.saveBackupMetadata(backupData);

            // Comprimir si está habilitado
            if (options.compress !== false) {
                await this.compressBackup(backupData);
            }

            this.lastBackup = backupData;

            this.emitEvent('backup_created', {
                backupId,
                type,
                size: await this.getBackupSize(backupData),
                duration: Date.now() - backupData.timestamp
            });

            console.log(`✅ Backup completado: ${backupId}`);
            return backupData;

        } catch (error) {
            console.error(`❌ Error creando backup ${backupId}:`, error.message);

            this.emitEvent('backup_failed', {
                backupId,
                type,
                error: error.message
            });

            throw error;
        }
    }

    /**
     * Crear backup completo
     */
    async createFullBackup(backupData) {
        const backupDir = path.join(this.options.backupDir, 'full', backupData.id);
        await mkdir(backupDir, { recursive: true });

        // Backup de colas auxiliares
        await this.backupAuxiliaryQueues(backupDir);
        backupData.components.queues = true;

        // Backup de DLQs
        await this.backupDeadLetterQueues(backupDir);
        backupData.components.dlqs = true;

        // Backup de configuraciones
        await this.backupConfigurations(backupDir);
        backupData.components.configs = true;

        // Backup de logs importantes
        await this.backupLogs(backupDir);
        backupData.components.logs = true;

        // Snapshot del estado del sistema
        await this.createSystemSnapshot(backupDir);
        backupData.components.systemSnapshot = true;

        backupData.path = backupDir;
    }

    /**
     * Crear backup incremental
     */
    async createIncrementalBackup(backupData) {
        const backupDir = path.join(this.options.backupDir, 'incremental', backupData.id);
        await mkdir(backupDir, { recursive: true });

        // Solo archivos modificados desde último backup
        const lastBackupTime = this.lastBackup ? this.lastBackup.timestamp : 0;

        // Colas modificadas
        const modifiedQueues = await this.getModifiedQueues(lastBackupTime);
        if (modifiedQueues.length > 0) {
            await this.backupSpecificQueues(backupDir, modifiedQueues);
            backupData.components.modifiedQueues = modifiedQueues;
        }

        // Logs recientes
        await this.backupRecentLogs(backupDir, lastBackupTime);
        backupData.components.recentLogs = true;

        backupData.path = backupDir;
        backupData.lastBackupRef = this.lastBackup?.id;
    }

    /**
     * Crear backup solo de colas
     */
    async createQueueBackup(backupData) {
        const backupDir = path.join(this.options.backupDir, 'queue', backupData.id);
        await mkdir(backupDir, { recursive: true });

        await this.backupAuxiliaryQueues(backupDir);
        await this.backupDeadLetterQueues(backupDir);

        backupData.components.queues = true;
        backupData.components.dlqs = true;
        backupData.path = backupDir;
    }

    /**
     * Crear backup solo de configuraciones
     */
    async createConfigBackup(backupData) {
        const backupDir = path.join(this.options.backupDir, 'config', backupData.id);
        await mkdir(backupDir, { recursive: true });

        await this.backupConfigurations(backupDir);

        backupData.components.configs = true;
        backupData.path = backupDir;
    }

    /**
     * Backup de colas auxiliares
     */
    async backupAuxiliaryQueues(backupDir) {
        const queueDir = path.join(backupDir, 'queues');
        await mkdir(queueDir, { recursive: true });

        const dataDir = path.join(process.cwd(), 'data');
        const queueFiles = [
            'gps_auxiliary_queue.json',
            'voz_auxiliary_queue.json',
            'eliot_auxiliary_queue.json'
        ];

        for (const file of queueFiles) {
            const sourcePath = path.join(dataDir, file);
            const targetPath = path.join(queueDir, file);

            try {
                if (fs.existsSync(sourcePath)) {
                    const data = await readFile(sourcePath);
                    await writeFile(targetPath, data);
                }
            } catch (error) {
                console.warn(`⚠️ Error backing up queue ${file}:`, error.message);
            }
        }
    }

    /**
     * Backup de Dead Letter Queues
     */
    async backupDeadLetterQueues(backupDir) {
        const dlqDir = path.join(backupDir, 'dlq');
        await mkdir(dlqDir, { recursive: true });

        const dlqDataDir = path.join(process.cwd(), 'data', 'dlq');

        try {
            if (fs.existsSync(dlqDataDir)) {
                const files = await readdir(dlqDataDir);

                for (const file of files) {
                    if (file.endsWith('_dlq.json')) {
                        const sourcePath = path.join(dlqDataDir, file);
                        const targetPath = path.join(dlqDir, file);

                        const data = await readFile(sourcePath);
                        await writeFile(targetPath, data);
                    }
                }
            }
        } catch (error) {
            console.warn('⚠️ Error backing up DLQs:', error.message);
        }
    }

    /**
     * Backup de configuraciones
     */
    async backupConfigurations(backupDir) {
        const configDir = path.join(backupDir, 'config');
        await mkdir(configDir, { recursive: true });

        const configFiles = [
            'package.json',
            'ecosystem.config.js',
            '.env.example',
            'CLAUDE.md'
        ];

        for (const file of configFiles) {
            const sourcePath = path.join(process.cwd(), file);
            const targetPath = path.join(configDir, file);

            try {
                if (fs.existsSync(sourcePath)) {
                    const data = await readFile(sourcePath);
                    await writeFile(targetPath, data);
                }
            } catch (error) {
                console.warn(`⚠️ Error backing up config ${file}:`, error.message);
            }
        }

        // Variables de entorno (sin valores sensibles)
        const envSnapshot = this.createEnvSnapshot();
        await writeFile(
            path.join(configDir, 'env_snapshot.json'),
            JSON.stringify(envSnapshot, null, 2)
        );
    }

    /**
     * Backup de logs importantes
     */
    async backupLogs(backupDir) {
        const logDir = path.join(backupDir, 'logs');
        await mkdir(logDir, { recursive: true });

        const logsDir = path.join(process.cwd(), 'logs');

        try {
            if (fs.existsSync(logsDir)) {
                const files = await readdir(logsDir);
                const recentFiles = [];

                // Solo logs de las últimas 24 horas
                const cutoff = Date.now() - (24 * 60 * 60 * 1000);

                for (const file of files) {
                    const filePath = path.join(logsDir, file);
                    const stats = await stat(filePath);

                    if (stats.mtime.getTime() >= cutoff) {
                        recentFiles.push(file);
                    }
                }

                // Copiar archivos recientes
                for (const file of recentFiles.slice(0, 10)) { // Máximo 10 archivos
                    const sourcePath = path.join(logsDir, file);
                    const targetPath = path.join(logDir, file);

                    try {
                        const data = await readFile(sourcePath);
                        await writeFile(targetPath, data);
                    } catch (error) {
                        console.warn(`⚠️ Error backing up log ${file}:`, error.message);
                    }
                }
            }
        } catch (error) {
            console.warn('⚠️ Error backing up logs:', error.message);
        }
    }

    /**
     * Crear snapshot del estado del sistema
     */
    async createSystemSnapshot(backupDir) {
        const snapshot = {
            timestamp: Date.now(),
            systemInfo: {
                nodeVersion: process.version,
                platform: process.platform,
                arch: process.arch,
                uptime: process.uptime(),
                memory: process.memoryUsage(),
                cpu: process.cpuUsage()
            },
            components: { ...this.systemComponents },
            processes: await this.getRunningProcesses(),
            diskUsage: await this.getDiskUsage(),
            networkInfo: await this.getNetworkInfo()
        };

        await writeFile(
            path.join(backupDir, 'system_snapshot.json'),
            JSON.stringify(snapshot, null, 2)
        );
    }

    /**
     * Crear snapshot de variables de entorno (sin secretos)
     */
    createEnvSnapshot() {
        const sensitiveKeys = [
            'PASSWORD', 'SECRET', 'KEY', 'TOKEN', 'API',
            'GPS_DB_PASSWORD', 'ELIOT_DB_PASSWORD',
            'TAECEL_KEY', 'TAECEL_NIP', 'MST_PASSWORD'
        ];

        const envSnapshot = {};

        for (const [key, value] of Object.entries(process.env)) {
            const isSensitive = sensitiveKeys.some(sensitive =>
                key.toUpperCase().includes(sensitive)
            );

            if (isSensitive) {
                envSnapshot[key] = '[REDACTED]';
            } else {
                envSnapshot[key] = value;
            }
        }

        return envSnapshot;
    }

    /**
     * Obtener procesos en ejecución
     */
    async getRunningProcesses() {
        return new Promise((resolve) => {
            const ps = spawn('ps', ['aux']);
            let output = '';

            ps.stdout.on('data', (data) => {
                output += data.toString();
            });

            ps.on('close', () => {
                const lines = output.split('\n');
                const nodeProcesses = lines.filter(line =>
                    line.includes('node') || line.includes('npm')
                );

                resolve(nodeProcesses.slice(0, 10)); // Máximo 10 procesos
            });

            ps.on('error', () => {
                resolve(['Error obteniendo procesos']);
            });
        });
    }

    /**
     * Obtener uso de disco
     */
    async getDiskUsage() {
        return new Promise((resolve) => {
            const df = spawn('df', ['-h', process.cwd()]);
            let output = '';

            df.stdout.on('data', (data) => {
                output += data.toString();
            });

            df.on('close', () => {
                const lines = output.split('\n');
                resolve(lines.slice(0, 3));
            });

            df.on('error', () => {
                resolve(['Error obteniendo uso de disco']);
            });
        });
    }

    /**
     * Obtener información de red
     */
    async getNetworkInfo() {
        return {
            hostname: require('os').hostname(),
            networkInterfaces: Object.keys(require('os').networkInterfaces()),
            platform: process.platform
        };
    }

    /**
     * Programar backup automático
     */
    scheduleAutoBackup() {
        setInterval(async () => {
            try {
                console.log('🕒 Ejecutando backup automático...');
                await this.createBackup(BackupType.INCREMENTAL);

                // Backup completo una vez al día
                const lastFullBackup = await this.getLastBackup(BackupType.FULL);
                const daysSinceLastFull = lastFullBackup ?
                    (Date.now() - lastFullBackup.timestamp) / (24 * 60 * 60 * 1000) : 999;

                if (daysSinceLastFull >= 1) {
                    console.log('📅 Ejecutando backup completo diario...');
                    await this.createBackup(BackupType.FULL);
                }

                // Limpiar backups antiguos
                await this.cleanupOldBackups();

            } catch (error) {
                console.error('❌ Error en backup automático:', error.message);
            }
        }, this.options.backupInterval);

        console.log(`⏰ Backup automático programado cada ${this.options.backupInterval / 60000} minutos`);
    }

    /**
     * Limpiar backups antiguos
     */
    async cleanupOldBackups() {
        const cutoff = Date.now() - (this.options.retentionDays * 24 * 60 * 60 * 1000);
        const backupTypes = ['full', 'incremental', 'queue', 'config'];

        let totalCleaned = 0;

        for (const type of backupTypes) {
            const typeDir = path.join(this.options.backupDir, type);

            try {
                if (fs.existsSync(typeDir)) {
                    const backups = await readdir(typeDir);

                    for (const backupId of backups) {
                        const backupPath = path.join(typeDir, backupId);
                        const stats = await stat(backupPath);

                        if (stats.mtime.getTime() < cutoff) {
                            await this.removeBackup(backupPath);
                            totalCleaned++;
                        }
                    }
                }
            } catch (error) {
                console.warn(`⚠️ Error limpiando backups ${type}:`, error.message);
            }
        }

        if (totalCleaned > 0) {
            console.log(`🧹 Limpieza de backups: ${totalCleaned} backups antiguos removidos`);
        }
    }

    /**
     * Remover backup
     */
    async removeBackup(backupPath) {
        const rmrf = spawn('rm', ['-rf', backupPath]);

        return new Promise((resolve, reject) => {
            rmrf.on('close', (code) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`Error removiendo backup: código ${code}`));
                }
            });

            rmrf.on('error', reject);
        });
    }

    /**
     * Guardar metadata del backup
     */
    async saveBackupMetadata(backupData) {
        const metadataPath = path.join(backupData.path, 'metadata.json');
        await writeFile(metadataPath, JSON.stringify(backupData, null, 2));
    }

    /**
     * Obtener tamaño del backup
     */
    async getBackupSize(backupData) {
        const du = spawn('du', ['-sh', backupData.path]);
        let output = '';

        return new Promise((resolve) => {
            du.stdout.on('data', (data) => {
                output += data.toString();
            });

            du.on('close', () => {
                const size = output.split('\t')[0] || 'unknown';
                resolve(size);
            });

            du.on('error', () => {
                resolve('unknown');
            });
        });
    }

    /**
     * Emitir evento al EventBus
     */
    emitEvent(eventType, data) {
        this.eventBus.emitEvent(`disaster_recovery.${eventType}`, {
            ...data
        }, 'DISASTER_RECOVERY');
    }

    /**
     * Obtener métricas del sistema de backup
     */
    getMetrics() {
        return {
            lastBackup: this.lastBackup,
            recoveryState: this.recoveryState,
            systemComponents: this.systemComponents,
            backupConfig: {
                autoBackup: this.options.autoBackup,
                retentionDays: this.options.retentionDays,
                backupInterval: this.options.backupInterval
            }
        };
    }
}

// Instancia singleton
let recoveryInstance = null;

/**
 * Obtener instancia del disaster recovery
 */
function getDisasterRecovery(options = {}) {
    if (!recoveryInstance) {
        recoveryInstance = new DisasterRecovery(options);
    }
    return recoveryInstance;
}

module.exports = {
    DisasterRecovery,
    getDisasterRecovery,
    BackupType,
    RecoveryState
};