const moment = require('moment-timezone');
const { BaseRechargeProcessor } = require('./BaseRechargeProcessor');
const { WebserviceClient } = require('../webservices/WebserviceClient');
const serviceConfig = require('../../config/services');

class VozRechargeProcessor extends BaseRechargeProcessor {
    constructor(dbConnection, lockManager, persistenceQueue) {
        super(dbConnection, lockManager, persistenceQueue, serviceConfig.VOZ);
        
        // Configuración específica de paquetes VOZ desde config
        this.paquetes = this.config.PAQUETES;
    }

    getServiceType() {
        return 'voz';
    }

    getServiceConfig() {
        return this.config;
    }

    // ===== IMPLEMENTACIÓN ESPECÍFICA VOZ =====
    async getRecordsToProcess() {
        const tomorrow = moment().add(1, "days").endOf("day").unix();
        const hoy = moment.tz(this.config.GLOBAL?.DEFAULT_TIMEZONE || "America/Mazatlan").format("YYYY-MM-DD");

        const sql = `
            SELECT *
            FROM prepagos_automaticos
            WHERE status = 1
                AND fecha_expira_saldo <= ${tomorrow}
                AND sim NOT IN (
                    SELECT DISTINCT dr.sim
                    FROM detalle_recargas dr
                    INNER JOIN recargas r ON dr.id_recarga = r.id
                    WHERE DATE(FROM_UNIXTIME(r.fecha)) = '${hoy}'
                        AND r.tipo = 'paquete'
                        AND dr.status = 1
                )
            LIMIT 300
        `;

        return await this.db.querySequelize(sql);
    }

    async processRecords(records, stats) {
        if (records.length === 0) {
            return stats;
        }

        console.log(`📊 ESTADÍSTICAS VOZ:`);
        console.log(`   • Total paquetes VOZ: ${records.length}`);

        // Obtener proveedores ordenados por saldo
        const providers = await this.getProvidersOrderedByBalance();
        const provider = providers[0]; // Usar el de mayor saldo

        console.log(`   💰 Proveedor seleccionado: ${provider.name} ($${provider.balance})`);

        // Procesar cada paquete VOZ
        for (let i = 0; i < records.length; i++) {
            const record = records[i];
            
            try {
                const paqueteConfig = this.paquetes[record.codigo_paquete];
                if (!paqueteConfig) {
                    console.log(`   ⚠️ Código de paquete desconocido: ${record.codigo_paquete} (SIM: ${record.sim})`);
                    stats.failed++;
                    continue;
                }

                console.log(`   📞 [${i + 1}/${records.length}] VOZ ${record.sim}, Paquete ${record.codigo_paquete} (${paqueteConfig.descripcion}), Monto: $${paqueteConfig.monto}`);

                // Usar WebserviceClient centralizado con reintentos unificados
                const rechargeResult = await this.executeWithRetry(
                    () => WebserviceClient.executeRecharge(provider, record.sim, paqueteConfig.codigo),
                    {
                        maxRetries: this.config.MAX_RETRIES,
                        delayStrategy: this.config.RETRY_STRATEGY,
                        baseDelay: this.config.RETRY_BASE_DELAY,
                        serviceName: 'VOZ'
                    }
                );

                if (rechargeResult.success) {
                    // Agregar a cola auxiliar VOZ con estructura universal
                    const auxItem = {
                        id: `aux_${Date.now()}_${Math.random()}`,
                        sim: record.sim,
                        vehiculo: record.descripcion || `VOZ-${record.sim}`,
                        empresa: "SERVICIO VOZ",
                        transID: rechargeResult.transID,
                        proveedor: rechargeResult.provider,
                        provider: rechargeResult.provider,

                        // ESTRUCTURA UNIVERSAL PARA VOZ
                        tipo: "voz_recharge",
                        tipoServicio: "VOZ",
                        monto: paqueteConfig.monto,
                        diasVigencia: paqueteConfig.dias,

                        // Datos específicos de VOZ
                        codigoPaquete: record.codigo_paquete,
                        codigoPSL: paqueteConfig.codigo,

                        webserviceResponse: rechargeResult.response,

                        status: "webservice_success_pending_db",
                        timestamp: Date.now(),
                        addedAt: Date.now()
                    };

                    await this.persistenceQueue.addToAuxiliaryQueue(auxItem);

                    stats.processed++;
                    stats.success++;
                    console.log(`   ✅ VOZ ${record.sim} recargado y agregado a cola auxiliar (${paqueteConfig.dias} días, $${paqueteConfig.monto}, Provider: ${rechargeResult.provider})`);
                } else {
                    stats.failed++;
                    console.log(`   ❌ VOZ ${record.sim} falló después de reintentos: ${rechargeResult.error}`);
                }

                // Delay entre llamadas (UNIFICADO con GPS: 500ms)
                if (this.config.DELAY_BETWEEN_CALLS > 0 && i < records.length - 1) {
                    await this.delay(this.config.DELAY_BETWEEN_CALLS);
                }

            } catch (error) {
                console.error(`   ❌ Error procesando VOZ ${record.sim}:`, error.message);
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

    // ===== RECOVERY ESPECÍFICO VOZ =====
    async processCompletePendingRecharge(recharge) {
        let transaction = null;
        
        try {
            transaction = await this.db.getSequelizeClient().transaction();
            
            // Insertar en tabla recargas (maestro) - campos correctos según estructura real
            const insertSql = `
                INSERT INTO recargas (fecha, tipo, total, notas, quien, proveedor)
                VALUES (UNIX_TIMESTAMP(), 'paquete', ?, ?, 'SISTEMA_VOZ', ?)
            `;
            
            const nota = `Recarga VOZ SIM ${recharge.sim} - Paquete ${recharge.codigoPaquete} (${recharge.codigoPSL}) - ${recharge.diasVigencia} días - $${recharge.monto}`;
            
            const [results] = await this.db.querySequelize(insertSql, {
                replacements: [recharge.monto, nota, recharge.proveedor],
                type: this.db.getSequelizeClient().QueryTypes.INSERT,
                transaction
            });
            
            const idRecarga = results;
            
            // Insertar en tabla detalle_recargas (con campo importe que sí existe)
            const detalleSql = `
                INSERT INTO detalle_recargas (id_recarga, sim, importe, dispositivo, vehiculo, detalle, folio, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `;
            
            const detalleText = `Recarga VOZ - Paquete ${recharge.codigoPaquete} (${recharge.codigoPSL}) - $${recharge.monto} - ${recharge.diasVigencia} días - Provider: ${recharge.proveedor}`;
            
            await this.db.querySequelize(detalleSql, {
                replacements: [
                    idRecarga,
                    recharge.sim,
                    recharge.monto, // importe
                    '', // No hay dispositivo en VOZ
                    recharge.vehiculo || `VOZ-${recharge.sim}`,
                    detalleText,
                    recharge.webserviceResponse?.transId || null,
                    1 // Status: exitosa
                ],
                type: this.db.getSequelizeClient().QueryTypes.INSERT,
                transaction
            });
            
            // Actualizar fecha_expira_saldo en prepagos_automaticos (+diasVigencia días)
            const updateSql = `
                UPDATE prepagos_automaticos 
                SET fecha_expira_saldo = DATE_ADD(NOW(), INTERVAL ? DAY)
                WHERE sim = ?
            `;
            
            await this.db.querySequelize(updateSql, {
                replacements: [recharge.diasVigencia, recharge.sim],
                type: this.db.getSequelizeClient().QueryTypes.UPDATE,
                transaction
            });
            
            await transaction.commit();
            console.log(`   ✅ VOZ ${recharge.sim} insertado en BD (+${recharge.diasVigencia} días)`);
            
        } catch (error) {
            if (transaction) await transaction.rollback();
            throw error;
        }
    }
}

module.exports = { VozRechargeProcessor };