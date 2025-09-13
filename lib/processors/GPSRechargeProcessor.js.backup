const moment = require('moment-timezone');
const axios = require('axios');
const soapRequest = require("easy-soap-request");
const xml2js = require("xml2js");
const config = require('../../config/database');
const recoveryMethods = require('./recovery_methods');

class GPSRechargeProcessor {
    constructor(dbConnection, lockManager, persistenceQueue) {
        this.db = dbConnection;
        this.lockManager = lockManager;
        this.persistenceQueue = persistenceQueue;

        // Agregar métodos de recuperación
        Object.assign(this, recoveryMethods);
        this.config = {
            IMPORTE: 10,        // FIJO: Siempre $10
            DIAS: 8,           // FIJO: Siempre 8 días
            CODIGO: 'TEL010',  // FIJO: Código para $10
            DIAS_SIN_REPORTAR_LIMITE: parseInt(process.env.GPS_DIAS_SIN_REPORTAR) || 14, // Días máximos para incluir en query (default 14)
            MINUTOS_SIN_REPORTAR_PARA_RECARGA: parseInt(process.env.GPS_MINUTOS_SIN_REPORTAR) || 14 // Minutos mínimos para aplicar recarga (default 14)
        };
    }

    async process() {
        const stats = { processed: 0, success: 0, failed: 0, filtered: 0 };
        const lockKey = 'recharge_gps';
        const lockId = `${lockKey}_${process.pid}_${Date.now()}`;
        let lockAcquired = false;

        try {
            // 1. Adquirir lock
            const lockExpirationMinutes = parseInt(process.env.LOCK_EXPIRATION_MINUTES) || 60;
            const lockTimeoutSeconds = lockExpirationMinutes * 60;
            const lockResult = await this.lockManager.acquireLock(lockKey, lockId, lockTimeoutSeconds);
            if (!lockResult.success) {
                console.log('   ⚠️ No se pudo adquirir lock, otro proceso en ejecución');
                return stats;
            }
            lockAcquired = true;

            // 2. Procesar cola auxiliar (recovery de fallos anteriores y crash recovery)
            console.log('🔄 Verificando cola auxiliar para recovery...');
            const pendingStats = await this.persistenceQueue.getQueueStats();
            
            // Procesar solo cola auxiliar (algoritmo de cola única)
            if (pendingStats.auxiliaryQueue.pendingDb > 0) {
                console.log(`⚡ Procesando ${pendingStats.auxiliaryQueue.pendingDb} recargas de recovery...`);
                const recoveryResult = await this.processAuxiliaryQueueRecharges();
                console.log(`   • Cola auxiliar: ${recoveryResult.processed} recuperadas, ${recoveryResult.failed} fallidas`);
                
                // SI HAY FALLAS EN RECOVERY, NO PROCESAR NUEVOS REGISTROS
                if (recoveryResult.failed > 0) {
                    console.log(`   ⚠️ HAY ${recoveryResult.failed} REGISTROS PENDIENTES SIN PROCESAR. NO CONSUMIENDO WEBSERVICES.`);
                    stats.failed = recoveryResult.failed;
                    return stats;
                }
            }

            // 3. Obtener registros nuevos
            const allRecords = await this.getAllRecordsToProcess();
            console.log(`   📋 ${allRecords.length} dispositivos GPS encontrados`);

            if (allRecords.length === 0) {
                return stats;
            }

            // 3. Aplicar lógica de filtrado como en script original
            const { registrosArecargar, registrosVencenFinDiaReportando, reportandoEnTiempo } = this.filterDevicesOriginalLogic(allRecords);

            // Estadísticas como en el script original
            console.log(`📊 ESTADÍSTICAS DEL SISTEMA:`);
            console.log(`   • Total registros: ${allRecords.length}`);
            console.log(`   • Para recargar (sin reportar ${this.config.MINUTOS_SIN_REPORTAR_PARA_RECARGA}+ min): ${registrosArecargar.length}`);
            console.log(`   • Pendientes al finalizar día: ${registrosVencenFinDiaReportando.length}`);
            console.log(`   • Reportando en tiempo y forma: ${reportandoEnTiempo}`);

            if (registrosVencenFinDiaReportando.length > 0) {
                console.log(`⏰ ${registrosVencenFinDiaReportando.length} dispositivos vencen al final del día pero están reportando`);
            }

            if (reportandoEnTiempo > 0) {
                console.log(`✅ ${reportandoEnTiempo} dispositivos reportando correctamente con saldo vigente`);
            }

            if (registrosArecargar.length === 0) {
                return stats;
            }

            // Actualizar stats para usar en las notas
            stats.totalRecords = allRecords.length;
            stats.pendientesFinDia = registrosVencenFinDiaReportando.length;
            stats.reportandoEnTiempo = reportandoEnTiempo;

            // 4. Obtener balance del proveedor
            const provider = await this.getProvider();

            if (!provider.available) {
                console.error(`   ❌ Ningún proveedor disponible - Abortando proceso`);
                return stats;
            }

            console.log(`   💰 Proveedor seleccionado: ${provider.name} ($${provider.balance})`);

            if (provider.balance < this.config.IMPORTE) {
                console.error(`   ⚠️ Saldo insuficiente en ${provider.name}: $${provider.balance} < $${this.config.IMPORTE}`);
                return stats;
            }

            // 5. Procesar recargas en lote
            const batchResult = await this.processBatchRecharges(
                registrosArecargar,
                provider,
                stats.reportandoEnTiempo,
                stats.totalRecords
            );
            
            stats.processed = batchResult.processed;
            stats.success = batchResult.success;
            stats.failed = batchResult.failed;

        } catch (error) {
            console.error('❌ Error en proceso GPS:', error);
            throw error;
        } finally {
            if (lockAcquired) {
                await this.lockManager.releaseLock(lockKey, lockId);
            }
        }

        return stats;
    }

    async getAllRecordsToProcess() {
        const fin_dia = moment.tz("America/Mazatlan").endOf("day").unix();
        const hoy = moment.tz("America/Mazatlan").format("YYYY-MM-DD");
        const dias_limite = this.config.DIAS_SIN_REPORTAR_LIMITE;

        const sql = `
            SELECT DISTINCT
                UCASE(v.descripcion) AS descripcion,
                UCASE(e.nombre) AS empresa,
                d.nombre AS dispositivo,
                d.sim AS sim,
                d.unix_saldo AS unix_saldo,
                v.status as vehiculo_estatus,
                -- Subconsulta para obtener la última conexión desde la tabla track
                (
                    SELECT t.fecha
                    FROM track t
                    WHERE t.dispositivo = d.nombre
                    ORDER BY t.fecha DESC
                    LIMIT 1
                ) AS ultimo_registro,
                -- Calcular los días sin reportar basados en la diferencia de tiempo desde la última conexión
                (
                    SELECT TRUNCATE((UNIX_TIMESTAMP() - (t.fecha)) / 60 / 60 / 24, 2)
                    FROM track t
                    WHERE t.dispositivo = d.nombre
                    ORDER BY t.fecha DESC
                    LIMIT 1
                ) AS dias_sin_reportar
            FROM
                vehiculos v
            JOIN
                empresas e ON v.empresa = e.id
            JOIN
                dispositivos d ON v.dispositivo = d.id
            JOIN
                sucursales s ON v.sucursal = s.id
            WHERE
                d.prepago = 1
                AND v.status = 1  -- Vehículo en estado 'Activo'
                AND e.status = 1  -- Empresa en estado 'Activo'
                AND d.unix_saldo IS NOT NULL
                ${this.getCompanyFilter()}
                AND (
                    e.nombre NOT LIKE '%stock%'
                    AND e.nombre NOT LIKE '%mextic los cabos%'
                    AND e.nombre NOT LIKE '%jesar%'
                    AND e.nombre NOT LIKE '%distribuidores%'
                    AND e.nombre NOT LIKE '%demo%'
                    AND e.nombre NOT LIKE '%_old%'
                    AND v.descripcion NOT LIKE '%_old%'
                    AND v.descripcion NOT LIKE '%demo%'
                )
                AND (unix_saldo <= ${fin_dia})
                AND NOT EXISTS (
                    SELECT 1 FROM detalle_recargas dr
                    INNER JOIN recargas r ON dr.id_recarga = r.id
                    WHERE dr.sim = d.sim
                        AND dr.status = 1
                        AND DATE(FROM_UNIXTIME(r.fecha)) = '${hoy}'
                )
            HAVING
                dias_sin_reportar <= ${dias_limite}
                AND vehiculo_estatus = 1
            ORDER BY
                descripcion,
                v.descripcion
        `;

        console.log(`   🔍 Buscando todos los dispositivos activos`);
        return await this.db.querySequelize(sql, {
            type: this.db.getSequelizeClient().QueryTypes.SELECT
        });
    }

    async checkDuplicate(sim) {
        const sql = `
            SELECT COUNT(*) as count
            FROM detalle_recargas dr
            INNER JOIN recargas r ON dr.id_recarga = r.id
            WHERE dr.sim = ?
                AND r.fecha > UNIX_TIMESTAMP() - 3600
                AND dr.status = 1
            LIMIT 1
        `;

        const result = await this.db.querySequelize(sql, {
            replacements: [sim],
            type: this.db.getSequelizeClient().QueryTypes.SELECT
        });

        return result[0].count > 0;
    }

    getCompanyFilter() {
        const testCompany = process.env.GPS_TEST_COMPANY;
        if (testCompany && testCompany.trim()) {
            console.log(`🧪 [TEST] Filtrando por empresa: ${testCompany}`);
            return `AND UPPER(e.nombre) LIKE UPPER('%${testCompany.trim()}%')`;
        }
        return '';
    }

    generateProgressBar(percentage) {
        const width = 20;
        const filled = Math.round((percentage / 100) * width);
        const empty = width - filled;
        
        const filledBar = '█'.repeat(filled);
        const emptyBar = '░'.repeat(empty);
        
        // Animación con diferentes colores según el progreso
        let color = '';
        if (percentage < 25) {
            color = '🔴'; // Rojo - inicio
        } else if (percentage < 50) {
            color = '🟡'; // Amarillo - progresando
        } else if (percentage < 75) {
            color = '🟠'; // Naranja - avanzando
        } else if (percentage < 100) {
            color = '🔵'; // Azul - casi completo
        } else {
            color = '🟢'; // Verde - completado
        }
        
        return `${color} [${filledBar}${emptyBar}]`;
    }

    async processBatchRecharges(registrosArecargar, provider, reportandoEnTiempo, totalRecords) {
        const batchStats = { processed: 0, success: 0, failed: 0 };
        const batchRecharges = [];
        
        console.log(`\n📦 Iniciando procesamiento en lote de ${registrosArecargar.length} recargas`);
        
        // Fase 1: Ejecutar todas las recargas de webservice
        for (let i = 0; i < registrosArecargar.length; i++) {
            const record = registrosArecargar[i];
            const currentIndex = i + 1;
            const totalToRecharge = registrosArecargar.length;
            const percentage = Math.round((currentIndex / totalToRecharge) * 100);
            const progressBar = this.generateProgressBar(percentage);
            
            console.log(`\n${progressBar} [${currentIndex}/${totalToRecharge}] ${percentage}% - ${record.descripcion} [${record.empresa}]`);
            console.log(`   📱 SIM: ${record.sim}`);
            
            try {
                // Verificar duplicado
                const isDuplicate = await this.checkDuplicate(record.sim);
                if (isDuplicate) {
                    console.log(`   ⏭️ Omitiendo: recarga reciente detectada`);
                    continue;
                }

                // Ejecutar webservice
                const webserviceResponse = await this.callWebservice(record.sim, provider);
                
                if (webserviceResponse.success) {
                    console.log(`   ✅ Webservice exitoso - TransID: ${webserviceResponse.transId}`);
                    
                    // PERSISTENCIA INMEDIATA: Guardar cada webservice exitoso en cola auxiliar
                    const auxItem = {
                        tipo: 'gps_recharge',
                        sim: record.sim,
                        transId: webserviceResponse.transId,
                        monto: this.config.IMPORTE,
                        timestamp: Date.now(),
                        record: {
                            descripcion: record.descripcion,
                            empresa: record.empresa,
                            dispositivo: record.dispositivo,
                            sim: record.sim
                        },
                        webserviceResponse: webserviceResponse,
                        noteData: {
                            currentIndex,
                            totalToRecharge: registrosArecargar.length,
                            reportandoEnTiempo,
                            totalRecords
                        },
                        provider: provider.name,
                        id: `aux_${Date.now()}_${Math.random()}`,
                        status: 'webservice_success_pending_db'
                    };
                    
                    await this.persistenceQueue.addToAuxiliaryQueue(auxItem);
                    console.log(`     💾 Guardado en cola auxiliar: ${record.sim}`);
                    
                    batchRecharges.push({
                        record,
                        webserviceResponse,
                        success: true,
                        currentIndex,
                        provider: provider.name,
                        auxId: auxItem.id  // Referencia para cleanup
                    });
                    batchStats.success++;
                } else {
                    console.log(`   ❌ Webservice falló: ${webserviceResponse.error}`);
                    batchRecharges.push({
                        record,
                        webserviceResponse,
                        success: false,
                        currentIndex,
                        provider: provider.name,
                        error: webserviceResponse.error
                    });
                    batchStats.failed++;
                }
                
                batchStats.processed++;
                
                // Pausa entre llamadas
                await new Promise(resolve => setTimeout(resolve, 500));
                
            } catch (error) {
                console.error(`   ❌ Error procesando:`, error.message);
                batchRecharges.push({
                    record,
                    success: false,
                    currentIndex,
                    provider: provider.name,
                    error: error.message
                });
                batchStats.failed++;
                batchStats.processed++;
            }
        }
        
        // Fase 2: Insertar UN SOLO registro maestro en recargas
        if (batchRecharges.length > 0) {
            let dbInsertionSuccess = true;
            try {
                await this.insertBatchToDatabase(batchRecharges, reportandoEnTiempo, totalRecords);
            } catch (error) {
                console.error(`   ❌ Error en inserción BD:`, error.message);
                dbInsertionSuccess = false;
            }
            
            // Fase 3: Algoritmo de cola única optimizada
            await this.handleQueueCleanup(batchRecharges, dbInsertionSuccess);
        }
        
        console.log(`\n📊 Lote completado: ${batchStats.success} exitosas, ${batchStats.failed} fallidas de ${batchStats.processed} procesadas`);
        return batchStats;
    }

    async insertBatchToDatabase(batchRecharges, reportandoEnTiempo, totalRecords, isRecovery = false) {
        let transaction = null;
        
        try {
            console.log(`\n💾 Insertando lote en base de datos...`);
            transaction = await this.db.getSequelizeClient().transaction();
            
            const totalAmount = batchRecharges.reduce((sum, r) => sum + (r.success ? this.config.IMPORTE : 0), 0);
            const totalToRecharge = batchRecharges.length;
            const successCount = batchRecharges.filter(r => r.success).length;
            const failedCount = batchRecharges.filter(r => !r.success).length;
            
            // Generar nota maestra con formato correcto
            const formattedNote = this.generateBatchNote(
                successCount,
                totalToRecharge,
                reportandoEnTiempo,
                totalRecords,
                isRecovery
            );
            
            // Crear resumen JSON
            const resumen = {
                error: failedCount,
                success: successCount,
                refund: 0
            };
            
            console.log(`   📝 Nota: ${formattedNote}`);
            console.log(`   📊 Resumen: ${JSON.stringify(resumen)}`);
            
            // Insertar UN SOLO registro maestro en recargas
            const [idRecarga] = await this.db.querySequelize(
                `INSERT INTO recargas (total, fecha, notas, quien, proveedor, tipo, resumen)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                {
                    replacements: [
                        totalAmount,
                        Math.floor(Date.now() / 1000),
                        formattedNote,
                        'mextic.app',
                        batchRecharges[0].provider || 'TAECEL',
                        'rastreo',
                        JSON.stringify(resumen)
                    ],
                    type: this.db.getSequelizeClient().QueryTypes.INSERT,
                    transaction
                }
            );
            
            console.log(`   ✅ Registro maestro creado con ID: ${idRecarga}`);
            
            // Insertar TODOS los detalles en detalle_recargas
            for (const recharge of batchRecharges) {
                await this.insertBatchRechargeDetail(idRecarga, recharge, transaction);
                
                // Actualizar unix_saldo solo para las exitosas
                if (recharge.success) {
                    await this.updateDeviceExpiration(recharge.record.sim, transaction);
                }
            }
            
            await transaction.commit();
            console.log(`   ✅ Lote insertado: ${successCount} exitosas, ${failedCount} fallidas`);
            
        } catch (error) {
            if (transaction) await transaction.rollback();
            console.error(`   ❌ Error insertando lote:`, error.message);
            throw error;
        }
    }

    generateBatchNote(successCount, totalToRecharge, reportandoEnTiempo, totalRecords, isRecovery = false) {
        const paddedSuccess = String(successCount).padStart(3, '0');
        const paddedTotal = String(totalToRecharge).padStart(3, '0');
        const pendingAtEnd = totalToRecharge - successCount;
        
        const recoveryPrefix = isRecovery ? '< RECUPERACIÓN > ' : '';
        
        return `${recoveryPrefix}[ ${paddedSuccess} / ${paddedTotal} ] Recarga Automática **** ${pendingAtEnd.toString().padStart(3, '0')} Pendientes al Finalizar el Día **** [ ${reportandoEnTiempo} Reportando en Tiempo y Forma ] (${totalToRecharge} procesados de ${totalRecords} total)`;
    }

    async insertRechargeDetail(idRecarga, recharge, transaction) {
        // Crear detalle formateado con datos del webservice
        let detalleFormateado = '';
        
        if (recharge.success && recharge.webserviceResponse) {
            const ws = recharge.webserviceResponse;
            // Formato TAECEL con todas las propiedades disponibles
            detalleFormateado = `[ Saldo Final: ${ws.saldoFinal || 'N/A'} ] Folio: ${ws.folio || ws.transId}, Cantidad: $${ws.monto || this.config.IMPORTE}.00, Teléfono: ${recharge.record.sim}, Carrier: ${ws.carrier || 'Telcel'}, Fecha: ${ws.fecha || new Date().toISOString().slice(0, 19).replace('T', ' ')}, TransID: ${ws.transId}, Timeout: ${ws.response?.Timeout || 'N/A'}, IP: ${ws.response?.IP || 'N/A'}${ws.nota ? ', ' + ws.nota : ''}`;
        } else {
            // Para fallos, mostrar error
            detalleFormateado = `Error: ${recharge.error || 'Webservice falló'}`;
        }
        
        console.log(`     → Insertando detalle: ${recharge.record.descripcion} [${recharge.record.empresa}] - ${recharge.success ? 'EXITOSA' : 'FALLIDA'}`);
        
        // Insertar en detalle_recargas
        await this.db.querySequelize(
            `INSERT INTO detalle_recargas (id_recarga, sim, importe, dispositivo, vehiculo, detalle, folio, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            {
                replacements: [
                    idRecarga,
                    recharge.record.sim,
                    this.config.IMPORTE,
                    recharge.record.dispositivo,
                    `${recharge.record.descripcion} [${recharge.record.empresa}]`,
                    detalleFormateado,
                    recharge.webserviceResponse?.transId || null,
                    recharge.success ? 1 : 0  // Status: 1 = exitosa, 0 = fallida
                ],
                type: this.db.getSequelizeClient().QueryTypes.INSERT,
                transaction
            }
        );
    }

    async insertBatchRechargeDetail(idRecarga, recharge, transaction) {
        // Crear detalle formateado con datos del webservice
        let detalleFormateado = '';
        
        if (recharge.success && recharge.webserviceResponse) {
            const ws = recharge.webserviceResponse;
            // Formato TAECEL con todas las propiedades disponibles
            detalleFormateado = `[ Saldo Final: ${ws.saldoFinal || 'N/A'} ] Folio: ${ws.folio || ws.transId}, Cantidad: $${ws.monto || this.config.IMPORTE}.00, Teléfono: ${recharge.record.sim}, Carrier: ${ws.carrier || 'Telcel'}, Fecha: ${ws.fecha || new Date().toISOString().slice(0, 19).replace('T', ' ')}, TransID: ${ws.transId}, Timeout: ${ws.response?.Timeout || 'N/A'}, IP: ${ws.response?.IP || 'N/A'}${ws.nota ? ', ' + ws.nota : ''}`;
        } else {
            // Para fallos, mostrar error
            detalleFormateado = `Error: ${recharge.error || 'Webservice falló'}`;
        }
        
        console.log(`     → Insertando detalle: ${recharge.record.descripcion} [${recharge.record.empresa}] - ${recharge.success ? 'EXITOSA' : 'FALLIDA'}`);
        
        // Insertar en detalle_recargas
        await this.db.querySequelize(
            `INSERT INTO detalle_recargas (id_recarga, sim, importe, dispositivo, vehiculo, detalle, folio, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            {
                replacements: [
                    idRecarga,
                    recharge.record.sim,
                    this.config.IMPORTE,
                    recharge.record.dispositivo,
                    `${recharge.record.descripcion} [${recharge.record.empresa}]`,
                    detalleFormateado,
                    recharge.webserviceResponse?.transId || null,
                    recharge.success ? 1 : 0  // Status: 1 = exitosa, 0 = fallida
                ],
                type: this.db.getSequelizeClient().QueryTypes.INSERT,
                transaction
            }
        );
    }

    async handleQueueCleanup(batchRecharges, dbInsertionSuccess = true) {
        console.log(`\n🧹 Algoritmo de cola única optimizada...`);
        
        try {
            const fs = require('fs').promises;
            const queuePath = require('path').join(__dirname, '../../data/auxiliary_queue.json');
            
            let auxiliaryQueue = [];
            try {
                const data = await fs.readFile(queuePath, 'utf8');
                auxiliaryQueue = JSON.parse(data);
            } catch (error) {
                console.log(`   ℹ️ Cola auxiliar vacía`);
                return;
            }
            
            if (dbInsertionSuccess) {
                // ✅ BD EXITOSA: Eliminar registros exitosos de cola auxiliar
                const successfulSims = new Set(batchRecharges.filter(r => r.success).map(r => r.record.sim));
                
                const remainingQueue = auxiliaryQueue.filter(item => {
                    if (item.tipo === 'gps_recharge' && item.status === 'webservice_success_pending_db') {
                        return !successfulSims.has(item.sim);
                    }
                    return true;
                });
                
                await fs.writeFile(queuePath, JSON.stringify(remainingQueue, null, 2));
                console.log(`   ✅ Cola auxiliar limpiada: ${successfulSims.size} registros eliminados tras inserción exitosa en BD`);
                
            } else {
                // ❌ BD FALLÓ: Cambiar estado para recovery en próxima ejecución  
                const updatedQueue = auxiliaryQueue.map(item => {
                    if (item.tipo === 'gps_recharge' && item.status === 'webservice_success_pending_db') {
                        // Los registros quedan en cola auxiliar con estado pendiente para recovery
                        return {
                            ...item,
                            status: 'db_insertion_failed_pending_recovery',
                            failureTimestamp: Date.now(),
                            failureReason: 'batch_db_insertion_failed'
                        };
                    }
                    return item;
                });
                
                await fs.writeFile(queuePath, JSON.stringify(updatedQueue, null, 2));
                console.log(`   🔄 Cola auxiliar actualizada: registros marcados para recovery automático`);
            }
            
        } catch (error) {
            console.error(`   ❌ Error en algoritmo de cola única:`, error.message);
        }
    }

    async executeRecharge(record, provider, currentIndex = 1, totalToRecharge = 1, reportandoEnTiempo = 0, totalRecords = 1) {
        let transaction = null;
        let webserviceConsumed = false;

        try {
            // 1. Llamar webservice
            const webserviceResponse = await this.callWebservice(record.sim, provider);

            if (!webserviceResponse.success) {
                return { success: false, error: webserviceResponse.error };
            }

            webserviceConsumed = true;

            // 2. Guardar respaldo inmediato con TODOS los datos necesarios
            await this.persistenceQueue.addToAuxiliaryQueue({
                tipo: 'gps_recharge',
                sim: record.sim,
                transId: webserviceResponse.transId,
                monto: this.config.IMPORTE,
                timestamp: Date.now(),
                // Datos del registro para recrear transacción completa
                record: {
                    descripcion: record.descripcion,
                    empresa: record.empresa,
                    dispositivo: record.dispositivo,
                    sim: record.sim
                },
                // Respuesta completa del webservice
                webserviceResponse: webserviceResponse,
                // Datos para las notas formateadas
                noteData: {
                    currentIndex,
                    totalToRecharge,
                    reportandoEnTiempo,
                    totalRecords
                },
                provider: provider.name
            });

            // 3. Transacción BD
            transaction = await this.db.getSequelizeClient().transaction();

            const fecha = Math.floor(Date.now() / 1000);

            // Insertar en recargas con nota formateada
            const formattedNote = await this.generateFormattedNote(
                record,
                currentIndex,
                totalToRecharge,
                reportandoEnTiempo,
                totalRecords
            );

            const [idRecarga] = await this.db.querySequelize(
                `INSERT INTO recargas (total, fecha, notas, quien, proveedor, tipo)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                {
                    replacements: [
                        this.config.IMPORTE,
                        fecha,
                        formattedNote,
                        'mextic.app',
                        provider.name,
                        'rastreo'
                    ],
                    type: this.db.getSequelizeClient().QueryTypes.INSERT,
                    transaction
                }
            );

            // Insertar en detalle_recargas
            await this.db.querySequelize(
                `INSERT INTO detalle_recargas (id_recarga, sim, importe, dispositivo, vehiculo, detalle, folio, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                {
                    replacements: [
                        idRecarga,
                        record.sim,
                        this.config.IMPORTE,
                        record.dispositivo,
                        `${record.descripcion} [${record.empresa}]`,
                        JSON.stringify(webserviceResponse),
                        webserviceResponse.transId,
                        1
                    ],
                    type: this.db.getSequelizeClient().QueryTypes.INSERT,
                    transaction
                }
            );

            // CRÍTICO: Actualizar unix_saldo
            const nuevaExpiracion = moment.tz("America/Mazatlan")
                .endOf("day")
                .add(this.config.DIAS, "days")
                .unix();

            await this.db.querySequelize(
                `UPDATE dispositivos SET unix_saldo = ? WHERE sim = ?`,
                {
                    replacements: [nuevaExpiracion, record.sim],
                    type: this.db.getSequelizeClient().QueryTypes.UPDATE,
                    transaction
                }
            );

            await transaction.commit();

            return {
                success: true,
                transId: webserviceResponse.transId,
                monto: this.config.IMPORTE
            };

        } catch (error) {
            if (transaction) await transaction.rollback();

            // Si el webservice se consumió, guardar en cola principal
            if (webserviceConsumed) {
                await this.persistenceQueue.addToMainQueue({
                    tipo: 'gps_failed',
                    sim: record.sim,
                    error: error.message,
                    webserviceConsumed: true
                });
            }

            throw error;
        }
    }

    async callWebservice(sim, provider) {
        console.log(`   🌐 Iniciando recarga para SIM: ${sim} con proveedor: ${provider.name}`);

        if (provider.balance < this.config.IMPORTE) {
            return {
                success: false,
                error: `Saldo insuficiente en ${provider.name}: $${provider.balance}`
            };
        }

        try {
            if (provider.name === 'TAECEL') {
                return await this.callTaecelWithRetry(sim);
            } else {
                return await this.callMstWithRetry(sim);
            }
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }

    async callTaecelWithRetry(sim, maxRetries = 3) {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                console.log(`   🔄 Intento ${attempt}/${maxRetries} - TAECEL`);

                // 1. RequestTXN
                const requestResult = await this.taecelRequestTXN(sim);
                if (!requestResult.success) {
                    if (attempt === maxRetries) {
                        return requestResult;
                    }
                    await this.delay(attempt * 1000);
                    continue;
                }

                // 2. StatusTXN
                const statusResult = await this.taecelStatusTXN(requestResult.transID);
                if (statusResult.success) {
                    return {
                        success: true,
                        transId: statusResult.data.TransID,
                        folio: statusResult.data.Folio,
                        monto: parseFloat(statusResult.data.Monto.replace(/[\$,]/g, "")),
                        carrier: statusResult.data.Carrier,
                        fecha: statusResult.data.Fecha,
                        saldoFinal: statusResult.data["Saldo Final"],
                        nota: statusResult.data.Nota || "",
                        response: statusResult.data
                    };
                }

                if (attempt === maxRetries) {
                    return statusResult;
                }

                await this.delay(attempt * 1000);

            } catch (error) {
                console.error(`   ❌ Error en intento ${attempt}:`, error.message);

                if (attempt === maxRetries) {
                    throw error;
                }

                await this.delay(attempt * 1000);
            }
        }
    }

    async callMstWithRetry(sim, maxRetries = 3) {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                console.log(`   🔄 Intento ${attempt}/${maxRetries} - MST`);

                const xml = `
                    <soapenv:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ws="http://recargas.red/ws/">
                    <soapenv:Header/>
                    <soapenv:Body>
                        <ws:RecargaEWS soapenv:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
                            <cadena xsi:type="xsd:string"><Recarga><Usuario>${config.MST.usuario}</Usuario><Passwd>${config.MST.clave}</Passwd><Telefono>${sim}</Telefono><Carrier>Telcel</Carrier><Monto>${this.config.IMPORTE}</Monto></Recarga></cadena>
                        </ws:RecargaEWS>
                    </soapenv:Body>
                    </soapenv:Envelope>`;

                const headers = {
                    'Content-Type': 'text/xml;charset=UTF-8',
                    soapAction: 'https://ventatelcel.com/ws/index.php/RecargaEWS',
                };

                const { response } = await soapRequest({
                    url: config.MST.url,
                    headers: headers,
                    xml: xml,
                    timeout: 30000,
                });

                if (response.statusCode === 200) {
                    const json = await xml2js.parseStringPromise(response.body, { mergeAttrs: true });
                    const respuesta_soap = json["SOAP-ENV:Envelope"]["SOAP-ENV:Body"][0]["ns1:RecargaEWSResponse"][0]["resultado"][0]["_"];
                    const resultado = await xml2js.parseStringPromise(respuesta_soap, { mergeAttrs: true });
                    const mensaje = resultado["Recarga"]["Resultado"][0];

                    if (typeof mensaje["Error"] !== "undefined") {
                        return {
                            success: false,
                            error: mensaje["Error"][0]
                        };
                    } else if (typeof mensaje["Folio"][0] !== "undefined") {
                        return {
                            success: true,
                            transId: mensaje["Folio"][0],
                            folio: mensaje["Folio"][0],
                            monto: mensaje["Cantidad"][0] * 1,
                            carrier: mensaje["Carrier"][0],
                            telefono: mensaje["Telefono"][0]
                        };
                    }
                }

                throw new Error(`MST respondió con status ${response.statusCode}`);

            } catch (error) {
                console.error(`   ❌ Error en intento ${attempt}:`, error.message);

                if (attempt === maxRetries || !this.isRetryableError(error)) {
                    throw error;
                }

                await this.delay(attempt * 1000);
            }
        }
    }

    async delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    isRetryableError(error) {
        return error.code === 'ECONNRESET' ||
               error.code === 'ETIMEDOUT' ||
               error.message.includes('timeout');
    }

    async getProvider() {
        let balance_taecel = 0;
        let balance_mst = 0;
        let taecel_available = false;
        let mst_available = false;

        try {
            // 1. Obtener balance TAECEL
            balance_taecel = await this.getTaecelBalance();
            taecel_available = true;
            console.log(`   💰 Balance TAECEL: $${balance_taecel}`);
        } catch (error) {
            console.error(`   ❌ Error obteniendo balance TAECEL (${error.response?.status || 'Unknown'}):`, error.message);
            if (error.response?.status === 403) {
                console.error(`   🔐 TAECEL: Error de autenticación - Verificar KEY y NIP`);
            }
        }

        try {
            // 2. Obtener balance MST
            balance_mst = await this.getMstBalance();
            mst_available = true;
            console.log(`   💰 Balance MST: $${balance_mst}`);
        } catch (error) {
            console.error(`   ❌ Error obteniendo balance MST:`, error.message);
        }

        // 3. Determinar proveedor con más saldo (solo entre los disponibles)
        let provider, balance;

        if (taecel_available && mst_available) {
            // Ambos disponibles - elegir el de mayor saldo
            provider = balance_taecel >= balance_mst ? 'TAECEL' : 'MST';
            balance = provider === 'TAECEL' ? balance_taecel : balance_mst;
        } else if (taecel_available) {
            // Solo TAECEL disponible
            provider = 'TAECEL';
            balance = balance_taecel;
        } else if (mst_available) {
            // Solo MST disponible
            provider = 'MST';
            balance = balance_mst;
        } else {
            // Ningún proveedor disponible
            console.error(`   ⚠️ ADVERTENCIA: Ningún proveedor disponible`);
            provider = 'TAECEL'; // Default para evitar errores
            balance = 0;
        }

        return {
            name: provider,
            balance: balance,
            available: taecel_available || mst_available,
            taecel_available,
            mst_available
        };
    }

    async getTaecelBalance() {
        const json_taecel = {
            key: config.TAECEL.key,
            nip: config.TAECEL.nip
        };

        const config_taecel = {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'Mozilla/5.0 (compatible; Recargas-System/1.0)'
            },
            timeout: 30000,
            validateStatus: function (status) {
                return status < 500; // No lanzar error para códigos < 500
            }
        };

        try {
            const response = await axios.post(
                `${config.TAECEL.url}/getBalance`,
                json_taecel,
                config_taecel
            );

            // Verificar respuesta HTTP
            if (response.status === 403) {
                throw new Error(`Acceso denegado - Verificar credenciales TAECEL (KEY/NIP)`);
            }

            if (response.status !== 200) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            // Verificar estructura de respuesta
            if (!response.data) {
                throw new Error("Respuesta vacía de TAECEL");
            }

            if (!response.data.success) {
                throw new Error(`API Error: ${response.data.message || 'Error desconocido'}`);
            }

            if (response.data && response.data.data) {
                const tiempoAire = response.data.data.find(item => item.Bolsa === "Tiempo Aire");
                if (tiempoAire) {
                    const saldo = tiempoAire.Saldo.replace(/,/g, "");
                    return parseFloat(saldo);
                }
            }

            throw new Error("No se encontró el saldo de Tiempo Aire en la respuesta");

        } catch (error) {
            if (error.response) {
                // Error HTTP con respuesta del servidor
                const status = error.response.status;
                const data = error.response.data;
                throw new Error(`HTTP ${status}: ${data?.message || error.response.statusText}`);
            } else if (error.request) {
                // Error de red/timeout
                throw new Error("Error de conexión con TAECEL");
            } else {
                // Error de configuración u otro
                throw error;
            }
        }
    }

    async getMstBalance() {
        const xml = `
            <soapenv:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ws="http://recargas.red/ws/">
            <soapenv:Header/>
            <soapenv:Body>
                <ws:ObtenSaldo soapenv:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
                    <cadena xsi:type="xsd:string"><Recarga><Usuario>${config.MST.usuario}</Usuario><Passwd>${config.MST.clave}</Passwd></Recarga></cadena>
                </ws:ObtenSaldo>
            </soapenv:Body>
            </soapenv:Envelope>`;

        const headers = {
            'Content-Type': 'text/xml;charset=UTF-8',
            soapAction: 'https://ventatelcel.com/ws/index.php/ObtenSaldo',
        };

        const { response } = await soapRequest({
            url: config.MST.url,
            headers: headers,
            xml: xml,
            timeout: 30000,
        });

        if (response.statusCode === 200) {
            const json_resultado = await xml2js.parseStringPromise(response.body, { mergeAttrs: true });
            const json_return1 = json_resultado["SOAP-ENV:Envelope"]["SOAP-ENV:Body"][0]["ns1:ObtenSaldoResponse"][0]["return1"][0]["_"];
            const saldo_tmp = await xml2js.parseStringPromise(json_return1, { mergeAttrs: true });
            return saldo_tmp.Recarga.Resultado[0].Saldo[0] * 1;
        }

        throw new Error("Error obteniendo saldo MST");
    }

    async taecelRequestTXN(sim) {
        const json_taecel = {
            key: config.TAECEL.key,
            nip: config.TAECEL.nip,
            producto: this.config.CODIGO,
            referencia: sim
        };

        const config_taecel = {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            timeout: 30000
        };

        const response = await axios.post(
            `${config.TAECEL.url}/RequestTXN`,
            json_taecel,
            config_taecel
        );

        if (response.data && response.data.success) {
            return {
                success: true,
                transID: response.data.data.transID
            };
        }

        return {
            success: false,
            error: response.data ? response.data.message : 'Error desconocido en RequestTXN'
        };
    }

    async taecelStatusTXN(transID) {
        const json_taecel = {
            key: config.TAECEL.key,
            nip: config.TAECEL.nip,
            transID: transID
        };

        const config_taecel = {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            timeout: 30000
        };

        const response = await axios.post(
            `${config.TAECEL.url}/StatusTXN`,
            json_taecel,
            config_taecel
        );

        if (response.data && response.data.success) {
            return {
                success: true,
                data: response.data.data
            };
        }

        return {
            success: false,
            error: response.data ? response.data.message : 'Error desconocido en StatusTXN',
            data: response.data ? response.data.data : null
        };
    }

    shouldTryFallback(error) {
        // Determinar si el error amerita intentar con el proveedor alternativo
        const fallbackErrors = [
            'saldo insuficiente',
            'timeout',
            'ECONNRESET',
            'ETIMEDOUT',
            'servidor no responde',
            'error inesperado'
        ];

        const errorLower = error.toLowerCase();
        return fallbackErrors.some(fallbackError => errorLower.includes(fallbackError));
    }

    async getAlternativeProvider(currentProvider) {
        try {
            if (currentProvider.name === 'TAECEL') {
                // Si falló TAECEL, intentar con MST
                const balance_mst = await this.getMstBalance();
                return {
                    name: 'MST',
                    balance: balance_mst
                };
            } else {
                // Si falló MST, intentar con TAECEL
                const balance_taecel = await this.getTaecelBalance();
                return {
                    name: 'TAECEL',
                    balance: balance_taecel
                };
            }
        } catch (error) {
            console.error(`   ❌ Error obteniendo proveedor alternativo:`, error.message);
            return null;
        }
    }

    filterDevicesOriginalLogic(records) {
        const minutos_para_recarga = this.config.MINUTOS_SIN_REPORTAR_PARA_RECARGA;
        const minutos_dia = minutos_para_recarga / 1440; // Convertir minutos a fracción de día
        const fin_dia = moment.tz("America/Mazatlan").endOf("day").unix();

        // Filtrar los que necesitan recarga (sin reportar >= 14 minutos como fracción)
        const registrosArecargar = records.filter(registro => {
            return registro.dias_sin_reportar >= minutos_dia;
        });

        // Filtrar los que vencen al final del día pero están reportando
        const registrosVencenFinDiaReportando = records.filter(registro => {
            return registro.unix_saldo === fin_dia && registro.dias_sin_reportar === 0;
        });

        // Calcular los que están reportando en tiempo y forma
        const reportandoEnTiempo = records.length - registrosArecargar.length - registrosVencenFinDiaReportando.length;

        return {
            registrosArecargar,
            registrosVencenFinDiaReportando,
            reportandoEnTiempo
        };
    }

    // Método removido - ahora usamos dias_sin_reportar del query SQL directamente

    // Método removido - ya no necesario con la nueva lógica

    // Método removido - ya no necesario con la nueva lógica

    async generateFormattedNote(record, currentIndex, totalToRecharge, reportandoEnTiempo, totalRecords) {
        const paddedIndex = String(currentIndex).padStart(3, '0');
        const paddedTotal = String(totalToRecharge).padStart(3, '0');
        const pendingAtEnd = totalToRecharge - currentIndex;

        // Si es una sola recarga (001/001), mostrar vehículo y empresa prominentemente
        if (totalToRecharge === 1) {
            return `[ ${paddedIndex} / ${paddedTotal} ] ${record.descripcion} [${record.empresa}] - Recarga Automática **** ${pendingAtEnd.toString().padStart(3, '0')} Pendientes al Finalizar el Día **** [ ${reportandoEnTiempo} Reportando en Tiempo y Forma ] (${currentIndex} procesados de ${totalRecords} total)`;
        }

        // Si son múltiples recargas (003/088), formato estándar SIN vehículo
        return `[ ${paddedIndex} / ${paddedTotal} ] Recarga Automática **** ${pendingAtEnd.toString().padStart(3, '0')} Pendientes al Finalizar el Día **** [ ${reportandoEnTiempo} Reportando en Tiempo y Forma ] (${currentIndex} procesados de ${totalRecords} total)`;
    }

    async processAuxiliaryQueueRecharges() {
        const stats = { processed: 0, failed: 0 };

        try {
            // Usar la cola auxiliar específica de GPS
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

            for (const recharge of pendingRecharges) {
                try {
                    await this.processCompletePendingRecharge(recharge);
                    stats.processed++;
                    console.log(`   ✅ Recarga ${recharge.sim} procesada exitosamente`);
                } catch (error) {
                    stats.failed++;
                    console.error(`   ❌ Error procesando recarga ${recharge.sim}:`, error.message);
                }
            }

            // Limpiar recargas procesadas exitosamente usando el sistema de persistencia
            const processedSims = new Set();
            
            for (const recharge of pendingRecharges) {
                if (stats.processed > 0) { // Solo si hubo éxitos
                    processedSims.add(recharge.sim);
                }
            }
            
            // Filtrar elementos procesados exitosamente de la cola
            this.persistenceQueue.auxiliaryQueue = this.persistenceQueue.auxiliaryQueue.filter(item => {
                if (item.tipo === 'gps_recharge' && processedSims.has(item.sim)) {
                    return false; // Remover exitosos
                }
                return true; // Mantener los demás
            });
            
            // Guardar la cola actualizada
            await this.persistenceQueue.saveAuxiliaryQueue();

        } catch (error) {
            console.error('   ❌ Error procesando cola auxiliar:', error.message);
            stats.failed++;
        }

        return stats;
    }

    async processCompletePendingRecharge(recharge) {
        let transaction = null;

        try {
            // Si no tiene datos completos, buscar el registro actual
            let record = recharge.record;
            if (!record || !record.descripcion) {
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

                record = results[0];
            }

            // Iniciar transacción
            transaction = await this.db.getSequelizeClient().transaction();
            const fecha = Math.floor(Date.now() / 1000);

            // Generar nota formateada
            const noteData = recharge.noteData || { currentIndex: 1, totalToRecharge: 1, reportandoEnTiempo: 0, totalRecords: 1 };
            const formattedNote = await this.generateFormattedNote(
                record,
                noteData.currentIndex,
                noteData.totalToRecharge,
                noteData.reportandoEnTiempo,
                noteData.totalRecords
            );

            // Insertar en recargas
            const [idRecarga] = await this.db.querySequelize(
                `INSERT INTO recargas (total, fecha, notas, quien, proveedor, tipo)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                {
                    replacements: [
                        recharge.monto,
                        fecha,
                        formattedNote,
                        'mextic.app',
                        recharge.provider || 'TAECEL',
                        'rastreo'
                    ],
                    type: this.db.getSequelizeClient().QueryTypes.INSERT,
                    transaction
                }
            );

            // Crear detalle formateado para webservice response
            let detalleFormateado = '';
            const wsResponse = recharge.webserviceResponse;
            if (wsResponse && wsResponse.saldoFinal) {
                detalleFormateado = `[ Saldo Final: ${wsResponse.saldoFinal} ] Folio: ${wsResponse.folio}, Cantidad: $${wsResponse.monto}, Teléfono: ${recharge.sim}, Carrier: ${wsResponse.carrier}, Fecha: ${wsResponse.fecha}, TransID: ${wsResponse.transId}, ${wsResponse.nota || ''}`;
            } else {
                detalleFormateado = JSON.stringify(wsResponse || { transId: recharge.transId, monto: recharge.monto });
            }

            // Insertar en detalle_recargas
            await this.db.querySequelize(
                `INSERT INTO detalle_recargas (id_recarga, sim, importe, dispositivo, vehiculo, detalle, folio, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                {
                    replacements: [
                        idRecarga,
                        recharge.sim,
                        recharge.monto,
                        record.dispositivo,
                        `${record.descripcion} [${record.empresa}]`,
                        detalleFormateado,
                        recharge.transId,
                        1
                    ],
                    type: this.db.getSequelizeClient().QueryTypes.INSERT,
                    transaction
                }
            );

            // Actualizar unix_saldo
            const nuevaExpiracion = moment.tz("America/Mazatlan")
                .endOf("day")
                .add(this.config.DIAS, "days")
                .unix();

            await this.db.querySequelize(
                `UPDATE dispositivos SET unix_saldo = ? WHERE sim = ?`,
                {
                    replacements: [nuevaExpiracion, recharge.sim],
                    type: this.db.getSequelizeClient().QueryTypes.UPDATE,
                    transaction
                }
            );

            await transaction.commit();

        } catch (error) {
            if (transaction) await transaction.rollback();
            throw error;
        }
    }
}

module.exports = { GPSRechargeProcessor };
