const moment = require('moment-timezone');
const { BaseRechargeProcessor } = require('./BaseRechargeProcessor');
const { WebserviceClient } = require('../webservices/WebserviceClient');
const serviceConfig = require('../../config/services');

class GPSRechargeProcessor extends BaseRechargeProcessor {
    constructor(dbConnection, lockManager, persistenceQueue) {
        super(dbConnection, lockManager, persistenceQueue, serviceConfig.GPS);
    }

    getServiceType() {
        return 'gps';
    }

    getServiceConfig() {
        return this.config;
    }

    // ===== IMPLEMENTACIÓN ESPECÍFICA GPS =====
    async getRecordsToProcess() {
        const fechaLimite = moment().subtract(this.config.DIAS_SIN_REPORTAR_LIMITE, 'days').format('YYYY-MM-DD HH:mm:ss');
        const hoy = moment.tz(this.config.GLOBAL?.DEFAULT_TIMEZONE || "America/Mazatlan").format("YYYY-MM-DD");
        
        const sql = `
            SELECT DISTINCT
                UCASE(v.descripcion) AS descripcion,
                UCASE(e.nombre) AS empresa,
                d.nombre AS dispositivo,
                d.sim,
                d.unix_saldo,
                COALESCE(latest_track.fecha, '1970-01-01 00:00:00') AS ultimo_registro,
                COALESCE(TIMESTAMPDIFF(MINUTE, latest_track.fecha, NOW()) / 1440, 999) AS dias_sin_reportar,
                COALESCE(TIMESTAMPDIFF(MINUTE, latest_track.fecha, NOW()), 999999) AS minutos_sin_reportar
            FROM vehiculos v
            INNER JOIN empresas e ON v.empresa = e.id
            INNER JOIN dispositivos d ON v.dispositivo = d.id
            LEFT JOIN (
                SELECT dispositivo, MAX(fecha) as fecha
                FROM track 
                WHERE fecha >= '${fechaLimite}'
                GROUP BY dispositivo
            ) latest_track ON latest_track.dispositivo = d.nombre
            WHERE v.status = 1 
                AND e.status = 1 
                AND d.status = 1
                AND UNIX_TIMESTAMP() >= d.unix_saldo
                AND d.sim NOT IN (
                    SELECT DISTINCT dr.sim
                    FROM detalle_recargas dr
                    INNER JOIN recargas r ON dr.id_recarga = r.id
                    WHERE DATE(FROM_UNIXTIME(r.fecha)) = '${hoy}'
                        AND r.tipo = 'paquete'
                        AND dr.status = 1
                )
            ORDER BY dias_sin_reportar DESC, v.descripcion ASC
            LIMIT 300
        `;

        return await this.db.querySequelize(sql);
    }

    async processRecords(records, stats) {
        if (records.length === 0) {
            return stats;
        }

        // Aplicar filtrado como en script original
        const { registrosArecargar, registrosVencenFinDiaReportando, reportandoEnTiempo } = 
            this.filterDevicesOriginalLogic(records);

        // Estadísticas como en el script original
        console.log(`📊 ESTADÍSTICAS GPS:`);
        console.log(`   • Total registros: ${records.length}`);
        console.log(`   • Para recargar (sin reportar ${this.config.MINUTOS_SIN_REPORTAR_PARA_RECARGA}+ min): ${registrosArecargar.length}`);
        console.log(`   • Pendientes al finalizar día: ${registrosVencenFinDiaReportando.length}`);
        console.log(`   • Reportando en tiempo y forma: ${reportandoEnTiempo}`);

        if (registrosArecargar.length === 0) {
            return stats;
        }

        // Obtener proveedores ordenados por saldo
        const providers = await this.getProvidersOrderedByBalance();
        const provider = providers[0]; // Usar el de mayor saldo

        console.log(`   💰 Proveedor seleccionado: ${provider.name} ($${provider.balance})`);

        if (provider.balance < this.config.IMPORTE) {
            console.error(`   ⚠️ Saldo insuficiente en ${provider.name}: $${provider.balance} < $${this.config.IMPORTE}`);
            return stats;
        }

        // Procesar cada dispositivo
        for (let i = 0; i < registrosArecargar.length; i++) {
            const record = registrosArecargar[i];
            
            try {
                console.log(`   📱 [${i + 1}/${registrosArecargar.length}] GPS ${record.sim} - ${record.descripcion}`);

                // Usar WebserviceClient centralizado
                const rechargeResult = await this.executeWithRetry(
                    () => WebserviceClient.executeRecharge(provider, record.sim, this.config.CODIGO),
                    {
                        maxRetries: this.config.MAX_RETRIES,
                        delayStrategy: this.config.RETRY_STRATEGY,
                        baseDelay: this.config.RETRY_BASE_DELAY,
                        serviceName: 'GPS'
                    }
                );

                if (rechargeResult.success) {
                    // Agregar a cola auxiliar GPS
                    const auxItem = {
                        id: `aux_${Date.now()}_${Math.random()}`,
                        tipo: 'gps_recharge',
                        sim: record.sim,
                        transId: rechargeResult.transID,
                        monto: this.config.IMPORTE,
                        record: {
                            descripcion: record.descripcion,
                            empresa: record.empresa,
                            dispositivo: record.dispositivo,
                            sim: record.sim
                        },
                        webserviceResponse: rechargeResult.response,
                        noteData: {
                            currentIndex: i + 1,
                            totalToRecharge: registrosArecargar.length,
                            reportandoEnTiempo: reportandoEnTiempo,
                            totalRecords: records.length
                        },
                        provider: rechargeResult.provider,
                        status: 'webservice_success_pending_db',
                        timestamp: Date.now(),
                        addedAt: Date.now(),
                        tipoServicio: 'GPS',
                        diasVigencia: this.config.DIAS
                    };

                    await this.persistenceQueue.addToAuxiliaryQueue(auxItem);
                    stats.processed++;
                    stats.success++;
                    
                    console.log(`   ✅ GPS ${record.sim} recargado exitosamente (+${this.config.DIAS} días, $${this.config.IMPORTE})`);
                } else {
                    stats.failed++;
                    console.log(`   ❌ GPS ${record.sim} falló: ${rechargeResult.error}`);
                }

                // Delay entre llamadas (unificado)
                if (this.config.DELAY_BETWEEN_CALLS > 0 && i < registrosArecargar.length - 1) {
                    await this.delay(this.config.DELAY_BETWEEN_CALLS);
                }

                // Mostrar progreso si está habilitado
                if (this.config.SHOW_PROGRESS_BAR) {
                    const progressBar = this.generateProgressBar(i + 1, registrosArecargar.length);
                    console.log(`   ${progressBar}`);
                }

            } catch (error) {
                console.error(`   ❌ Error procesando GPS ${record.sim}:`, error.message);
                stats.failed++;
            }
        }

        return stats;
    }

    // ===== MÉTODOS WEBSERVICE (ahora delegados a WebserviceClient) =====
    async getTaecelBalance() {
        return await WebserviceClient.getTaecelBalance();
    }

    async getMstBalance() {
        return await WebserviceClient.getMstBalance();
    }

    // ===== LÓGICA DE FILTRADO ESPECÍFICA GPS =====
    filterDevicesOriginalLogic(allRecords) {
        const registrosArecargar = [];
        const registrosVencenFinDiaReportando = [];
        let reportandoEnTiempo = 0;

        for (const record of allRecords) {
            const minutosDesdeUltimoReporte = parseInt(record.minutos_sin_reportar);
            const estaVencido = parseInt(record.unix_saldo) <= Math.floor(Date.now() / 1000);

            if (estaVencido) {
                if (minutosDesdeUltimoReporte >= this.config.MINUTOS_SIN_REPORTAR_PARA_RECARGA) {
                    // Vencido y sin reportar por X minutos -> RECARGAR
                    registrosArecargar.push(record);
                } else {
                    // Vencido pero reportando recientemente -> PENDIENTE
                    registrosVencenFinDiaReportando.push(record);
                }
            } else {
                // No vencido y reportando -> OK
                reportandoEnTiempo++;
            }
        }

        return {
            registrosArecargar,
            registrosVencenFinDiaReportando,
            reportandoEnTiempo
        };
    }

    // ===== RECOVERY ESPECÍFICO GPS =====
    async processCompletePendingRecharge(recharge) {
        let transaction = null;
        
        try {
            transaction = await this.db.getSequelizeClient().transaction();
            
            // Buscar datos del registro si no están completos
            let record = recharge.record;
            if (!record || !record.descripcion) {
                record = await this.getRecordDataForRecovery(recharge);
            }
            
            const fecha = Math.floor(Date.now() / 1000);
            
            // Nota para recovery GPS
            const { currentIndex = 1, totalToRecharge = 1, reportandoEnTiempo = 0, totalRecords = 1 } = recharge.noteData || {};
            const recoveryNote = `< RECUPERACIÓN GPS > [ ${String(currentIndex).padStart(3, '0')} / ${String(totalToRecharge).padStart(3, '0')} ] ${record.descripcion} [${record.empresa}] - Recarga Automática **** ${reportandoEnTiempo} Reportando en Tiempo y Forma **** [ ${totalRecords - totalToRecharge - reportandoEnTiempo} Pendientes al Finalizar el Día ] (${totalToRecharge} procesados de ${totalRecords} total)`;
            
            // Crear resumen JSON para recovery GPS
            const resumen = { error: 0, success: 1, refund: 0 };
            
            // Insertar en recargas
            const [idRecarga] = await this.db.querySequelize(
                `INSERT INTO recargas (total, fecha, notas, quien, proveedor, tipo, resumen)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                {
                    replacements: [
                        this.config.IMPORTE,
                        fecha,
                        recoveryNote,
                        'SISTEMA_GPS',
                        recharge.provider || 'TAECEL',
                        'paquete',
                        JSON.stringify(resumen)
                    ],
                    type: this.db.getSequelizeClient().QueryTypes.INSERT,
                    transaction
                }
            );
            
            // Insertar en detalle_recargas
            const detalleText = `GPS Recovery - ${record.descripcion} - $${this.config.IMPORTE} - ${this.config.DIAS} días - Provider: ${recharge.provider}`;
            
            await this.db.querySequelize(
                `INSERT INTO detalle_recargas (id_recarga, sim, importe, dispositivo, vehiculo, detalle, folio, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                {
                    replacements: [
                        idRecarga,
                        recharge.sim,
                        this.config.IMPORTE,
                        record.dispositivo || '',
                        record.descripcion,
                        detalleText,
                        recharge.webserviceResponse?.transId || null,
                        1
                    ],
                    type: this.db.getSequelizeClient().QueryTypes.INSERT,
                    transaction
                }
            );
            
            // Actualizar unix_saldo en dispositivos (+DIAS días)
            const nuevaFechaExpiracion = Math.floor(Date.now() / 1000) + (this.config.DIAS * 24 * 60 * 60);
            
            await this.db.querySequelize(
                `UPDATE dispositivos SET unix_saldo = ? WHERE sim = ?`,
                {
                    replacements: [nuevaFechaExpiracion, recharge.sim],
                    type: this.db.getSequelizeClient().QueryTypes.UPDATE,
                    transaction
                }
            );
            
            await transaction.commit();
            console.log(`   ✅ GPS ${recharge.sim} insertado en BD (+${this.config.DIAS} días)`);
            
        } catch (error) {
            if (transaction) await transaction.rollback();
            throw error;
        }
    }

    async getRecordDataForRecovery(recharge) {
        // Obtener datos del dispositivo para recovery
        const deviceData = await this.db.querySequelize(
            `SELECT UCASE(v.descripcion) AS descripcion, UCASE(e.nombre) AS empresa, d.nombre AS dispositivo, d.sim
             FROM vehiculos v
             INNER JOIN empresas e ON v.empresa = e.id  
             INNER JOIN dispositivos d ON v.dispositivo = d.id
             WHERE d.sim = ?`,
            {
                replacements: [recharge.sim],
                type: this.db.getSequelizeClient().QueryTypes.SELECT
            }
        );

        if (deviceData.length === 0) {
            throw new Error(`No se encontraron datos para SIM ${recharge.sim}`);
        }

        return deviceData[0];
    }
}

module.exports = { GPSRechargeProcessor };