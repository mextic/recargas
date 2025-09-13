// Métodos de recuperación mejorados
const moment = require('moment-timezone');

const recoveryMethods = {
    async processAuxiliaryQueueRecharges() {
        const stats = { processed: 0, failed: 0 };
        
        try {
            // Usar la cola auxiliar específica de GPS del sistema de persistencia
            const auxiliaryQueue = this.persistenceQueue.auxiliaryQueue;
            
            if (!auxiliaryQueue || auxiliaryQueue.length === 0) {
                console.log('   📋 Cola auxiliar GPS vacía');
                return stats;
            }
            
            const pendingRecharges = auxiliaryQueue.filter(item => 
                item.tipo === 'gps_recharge' && 
                (item.status === 'webservice_success_pending_db' || 
                 item.status === 'db_insertion_failed_pending_recovery')
            );
            
            console.log(`   🔄 Procesando ${pendingRecharges.length} recargas pendientes...`);
            
            if (pendingRecharges.length === 0) {
                return stats;
            }
            
            // Crear conjunto para rastrear SIMs procesados exitosamente
            const processedSims = new Set();
            
            // Decidir si procesar individual o en lote
            if (pendingRecharges.length === 1) {
                // RECUPERACIÓN INDIVIDUAL
                console.log('   🔄 Procesando recuperación individual...');
                try {
                    await this.processIndividualRecovery(pendingRecharges[0]);
                    stats.processed++;
                    processedSims.add(pendingRecharges[0].sim);
                    console.log(`   ✅ Recarga individual ${pendingRecharges[0].sim} recuperada exitosamente`);
                } catch (error) {
                    stats.failed++;
                    console.error(`   ❌ Error en recuperación individual:`, error.message);
                }
            } else {
                // RECUPERACIÓN EN LOTE
                console.log(`   🔄 Procesando recuperación en lote (${pendingRecharges.length} recargas)...`);
                try {
                    const batchResult = await this.processBatchRecovery(pendingRecharges);
                    stats.processed = batchResult.processed;
                    stats.failed = batchResult.failed;
                    // Agregar SIMs procesados exitosamente del lote
                    batchResult.processedSims.forEach(sim => processedSims.add(sim));
                    console.log(`   ✅ Lote recuperado: ${batchResult.processed} exitosas, ${batchResult.failed} fallidas`);
                } catch (error) {
                    stats.failed = pendingRecharges.length;
                    console.error(`   ❌ Error en recuperación en lote:`, error.message);
                }
            }
            
            // Limpiar SOLO las recargas procesadas exitosamente usando sistema de persistencia
            if (stats.processed > 0) {
                // Filtrar elementos procesados exitosamente de la cola
                this.persistenceQueue.auxiliaryQueue = this.persistenceQueue.auxiliaryQueue.filter(item => {
                    if (item.tipo === 'gps_recharge' && processedSims.has(item.sim)) {
                        return false; // Remover exitosos
                    }
                    return true; // Mantener los demás
                });
                
                // Guardar la cola actualizada usando el sistema de persistencia
                await this.persistenceQueue.saveAuxiliaryQueue();
                console.log(`   🧹 Cola auxiliar GPS limpiada: ${processedSims.size} recargas removidas`);
            }
            
        } catch (error) {
            console.error('   ❌ Error procesando cola auxiliar:', error.message);
            stats.failed++;
        }
        
        return stats;
    },

    async processIndividualRecovery(recharge) {
        let transaction = null;
        
        try {
            // Buscar datos del registro si no están completos
            let record = await this.getRecordDataForRecovery(recharge);
            
            // Iniciar transacción
            transaction = await this.db.getSequelizeClient().transaction();
            const fecha = Math.floor(Date.now() / 1000);
            
            // Nota para recuperación individual
            const recoveryNote = `< RECUPERACIÓN > [ 001 / 001 ] ${record.descripcion} [${record.empresa}] - Recarga Automática **** 000 Pendientes al Finalizar el Día **** [ 0 Reportando en Tiempo y Forma ] (1 procesados de 1 total)`;
            
            // Crear resumen JSON para recuperación individual
            const resumen = { error: 0, success: 1, refund: 0 };
            
            // Insertar en recargas
            const [idRecarga] = await this.db.querySequelize(
                `INSERT INTO recargas (total, fecha, notas, quien, proveedor, tipo, resumen)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                {
                    replacements: [
                        recharge.monto,
                        fecha,
                        recoveryNote,
                        'mextic.app',
                        recharge.provider || 'TAECEL',
                        'rastreo',
                        JSON.stringify(resumen)
                    ],
                    type: this.db.getSequelizeClient().QueryTypes.INSERT,
                    transaction
                }
            );
            
            // Insertar detalle completo
            await this.insertRechargeDetail(idRecarga, recharge, record, transaction);
            
            // Actualizar unix_saldo
            await this.updateDeviceExpiration(recharge.sim, recharge, transaction);
            
            await transaction.commit();
            
        } catch (error) {
            if (transaction) await transaction.rollback();
            throw error;
        }
    },
    
    async processBatchRecovery(recharges) {
        const batchStats = { processed: 0, failed: 0, processedSims: [] };
        let transaction = null;
        
        try {
            transaction = await this.db.getSequelizeClient().transaction();
            const fecha = Math.floor(Date.now() / 1000);
            
            // Calcular total del lote
            const totalAmount = recharges.reduce((sum, r) => sum + r.monto, 0);
            
            // Nota para recuperación en lote usando formato estándar
            const successCount = recharges.length;
            const paddedSuccess = String(successCount).padStart(3, '0');
            const paddedTotal = String(successCount).padStart(3, '0');
            const batchNote = `< RECUPERACIÓN > [ ${paddedSuccess} / ${paddedTotal} ] Recarga Automática **** 000 Pendientes al Finalizar el Día **** [ 0 Reportando en Tiempo y Forma ] (${successCount} procesados de ${successCount} total)`;
            
            // Crear resumen JSON
            const resumen = {
                error: 0,
                success: 0,
                refund: 0
            };
            
            // Insertar UNA SOLA recarga maestra
            const [idRecarga] = await this.db.querySequelize(
                `INSERT INTO recargas (total, fecha, notas, quien, proveedor, tipo, resumen)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                {
                    replacements: [
                        totalAmount,
                        fecha,
                        batchNote,
                        'mextic.app',
                        recharges[0].provider || 'TAECEL',
                        'rastreo',
                        JSON.stringify(resumen)
                    ],
                    type: this.db.getSequelizeClient().QueryTypes.INSERT,
                    transaction
                }
            );
            
            console.log(`   📦 Procesando ${recharges.length} recargas para lote ID: ${idRecarga}`);
            console.log(`   📋 Recargas en cola:`);
            recharges.forEach((r, i) => {
                console.log(`     ${i + 1}. SIM: ${r.sim}, TransID: ${r.transId}`);
            });
            
            // Insertar TODOS los detalles vinculados a la recarga maestra
            for (let i = 0; i < recharges.length; i++) {
                const recharge = recharges[i];
                console.log(`\n   🛠️ Procesando recarga ${i + 1}/${recharges.length}: SIM ${recharge.sim}`);
                
                try {
                    const record = await this.getRecordDataForRecovery(recharge);
                    console.log(`     ℹ️ Datos obtenidos: ${record.descripcion} [${record.empresa}]`);
                    
                    await this.insertRechargeDetail(idRecarga, recharge, record, transaction);
                    console.log(`     ✅ Detalle insertado exitosamente`);
                    
                    await this.updateDeviceExpiration(recharge.sim, recharge, transaction);
                    console.log(`     ⏰ Unix_saldo actualizado`);
                    
                    batchStats.processed++;
                    batchStats.processedSims.push(recharge.sim);
                    resumen.success++;
                    console.log(`     ✓ [${i + 1}/${recharges.length}] ${recharge.sim} (${record.descripcion}) COMPLETADO`);
                    
                } catch (error) {
                    batchStats.failed++;
                    resumen.error++;
                    console.error(`     ❌ [${i + 1}/${recharges.length}] ERROR en ${recharge.sim}:`, error.message);
                    console.error(`     🔍 Stack trace:`, error.stack);
                    // Continuar con los siguientes aunque uno falle
                }
            }
            
            // Actualizar resumen en la recarga maestra
            await this.db.querySequelize(
                `UPDATE recargas SET resumen = ? WHERE id = ?`,
                {
                    replacements: [JSON.stringify(resumen), idRecarga],
                    type: this.db.getSequelizeClient().QueryTypes.UPDATE,
                    transaction
                }
            );
            
            await transaction.commit();
            console.log(`   ✅ Lote completado: ${batchStats.processed} exitosas, ${batchStats.failed} fallidas`);
            console.log(`   📊 Resumen final: ${JSON.stringify(resumen)}`);
            
        } catch (error) {
            if (transaction) await transaction.rollback();
            console.error(`   ❌ Error crítico en lote de recuperación:`, error.message);
            throw error;
        }
        
        return batchStats;
    },
    
    async getRecordDataForRecovery(recharge) {
        // Si ya tiene datos completos, usarlos
        if (recharge.record && recharge.record.descripcion) {
            return recharge.record;
        }
        
        // Si no, buscar en BD
        console.log(`   🔍 Buscando datos del SIM ${recharge.sim}...`);
        const sql = `
            SELECT
                UCASE(v.descripcion) AS descripcion,
                UCASE(e.nombre) AS empresa,
                d.nombre AS dispositivo,
                d.sim AS sim
            FROM vehiculos v
            JOIN empresas e ON v.empresa = e.id
            JOIN dispositivos d ON v.dispositivo = d.id
            WHERE d.sim = ? AND d.prepago = 1
            LIMIT 1
        `;
        
        const results = await this.db.querySequelize(sql, {
            replacements: [recharge.sim],
            type: this.db.getSequelizeClient().QueryTypes.SELECT
        });
        
        if (results.length === 0) {
            throw new Error(`No se encontró el dispositivo SIM ${recharge.sim}`);
        }
        
        return results[0];
    },
    
    async insertRechargeDetail(idRecarga, recharge, record, transaction) {
        // VALIDACIÓN DEFENSIVA: Verificar campos requeridos
        if (!recharge.sim) {
            throw new Error(`Campo 'sim' requerido está undefined en recharge: ${JSON.stringify(recharge, null, 2)}`);
        }
        if (!idRecarga) {
            throw new Error(`Campo 'idRecarga' está undefined`);
        }
        if (!recharge.monto) {
            throw new Error(`Campo 'monto' requerido está undefined para SIM ${recharge.sim}`);
        }
        if (!record || !record.descripcion || !record.empresa) {
            throw new Error(`Datos de record incompletos para SIM ${recharge.sim}: ${JSON.stringify(record, null, 2)}`);
        }
        
        // Crear detalle formateado con TODOS los datos del webservice
        let detalleFormateado = '';
        const wsResponse = recharge.webserviceResponse;
        if (wsResponse && wsResponse.saldoFinal) {
            detalleFormateado = `[ Saldo Final: ${wsResponse.saldoFinal} ] Folio: ${wsResponse.folio}, Cantidad: $${wsResponse.monto}, Teléfono: ${recharge.sim}, Carrier: ${wsResponse.carrier}, Fecha: ${wsResponse.fecha}, TransID: ${wsResponse.transId}, Timeout: ${wsResponse.response?.Timeout || 'N/A'}, IP: ${wsResponse.response?.IP || 'N/A'}${wsResponse.nota ? ', ' + wsResponse.nota : ''}`;
        } else {
            detalleFormateado = JSON.stringify(wsResponse || { transId: recharge.transID || recharge.transId, monto: recharge.monto });
        }
        
        console.log(`       → Preparando INSERT detalle_recargas:`);
        console.log(`         - id_recarga: ${idRecarga}`);
        console.log(`         - sim: ${recharge.sim}`);
        console.log(`         - vehiculo: ${record.descripcion} [${record.empresa}]`);
        console.log(`         - folio: ${recharge.transID || recharge.transId}`);
        
        // VALIDACIÓN FINAL: Verificar que todos los replacements están definidos
        const replacements = [
            idRecarga,
            recharge.sim,
            recharge.monto,
            record.dispositivo || 'N/A',
            `${record.descripcion} [${record.empresa}]`,
            detalleFormateado,
            recharge.transID || recharge.transId || 'N/A',
            1  // SIEMPRE status = 1 para recargas exitosas
        ];
        
        // Verificar que ningún replacement crítico sea undefined
        replacements.forEach((replacement, index) => {
            if (replacement === undefined || replacement === null) {
                throw new Error(`Replacement[${index}] es undefined/null. SIM: ${recharge.sim}, valores: ${JSON.stringify(replacements)}`);
            }
        });
        
        // Insertar en detalle_recargas
        const result = await this.db.querySequelize(
            `INSERT INTO detalle_recargas (id_recarga, sim, importe, dispositivo, vehiculo, detalle, folio, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            {
                replacements: replacements,
                type: this.db.getSequelizeClient().QueryTypes.INSERT,
                transaction
            }
        );
        
        console.log(`       ✅ INSERT exitoso - Detalle insertado para SIM ${recharge.sim}`);
        return result;
    },
    
    async updateDeviceExpiration(sim, recharge, transaction) {
        // Usar días de vigencia desde la cola auxiliar (universal para GPS/VOZ/ELIOT)
        const dias = recharge.diasVigencia || 8; // Default GPS si no está definido
        const tipoServicio = recharge.tipoServicio || 'GPS';
        
        console.log(`     ⏰ Actualizando vigencia: +${dias} días para ${tipoServicio}`);
        
        switch(tipoServicio) {
            case 'GPS':
            case 'gps_recharge':
                await this.updateGPSExpiration(sim, dias, transaction);
                break;
            case 'VOZ':
            case 'voz_recharge':
                await this.updateVOZExpiration(sim, dias, transaction);
                break;
            case 'ELIOT':
            case 'iot_recharge':
                await this.updateELIOTExpiration(sim, dias, recharge);
                break;
            default:
                await this.updateGPSExpiration(sim, dias, transaction);
        }
    },

    async updateGPSExpiration(sim, dias, transaction) {
        const nuevaExpiracion = moment.tz("America/Mazatlan")
            .endOf("day")
            .add(dias, "days")
            .unix();
        
        await this.db.querySequelize(
            `UPDATE dispositivos SET unix_saldo = ? WHERE sim = ?`,
            {
                replacements: [nuevaExpiracion, sim],
                type: this.db.getSequelizeClient().QueryTypes.UPDATE,
                transaction
            }
        );
        console.log(`     ⏰ GPS unix_saldo actualizado (+${dias} días)`);
    },

    async updateVOZExpiration(sim, dias, transaction) {
        const nuevaExpiracion = moment.tz("America/Mazatlan")
            .endOf("day")
            .add(dias, "days")
            .format('YYYY-MM-DD HH:mm:ss');
        
        await this.db.querySequelize(
            `UPDATE prepagos_automaticos SET fecha_expira_saldo = ? WHERE sim = ?`,
            {
                replacements: [nuevaExpiracion, sim],
                type: this.db.getSequelizeClient().QueryTypes.UPDATE,
                transaction
            }
        );
        console.log(`     ⏰ VOZ fecha_expira_saldo actualizado (+${dias} días)`);
    },

    async updateELIOTExpiration(sim, dias, recharge) {
        const nuevaExpiracion = moment.tz("America/Mazatlan")
            .endOf("day")
            .add(dias, "days")
            .format('YYYY-MM-DD HH:mm:ss');
        
        // ELIOT usa diferente BD - necesitamos la conexión ELIOT
        if (recharge.eliotDb) {
            await recharge.eliotDb.querySequelize(
                `UPDATE agentes SET fecha_saldo = ? WHERE sim = ?`,
                {
                    replacements: [nuevaExpiracion, sim],
                    type: recharge.eliotDb.getSequelizeClient().QueryTypes.UPDATE
                }
            );
            console.log(`     ⏰ ELIOT fecha_saldo actualizado (+${dias} días)`);
        } else {
            console.log(`     ⚠️ No hay conexión ELIOT para actualizar SIM ${sim}`);
        }
    },

};

module.exports = recoveryMethods;