// Script para procesar manualmente la cola auxiliar VOZ
// Este script inserta los registros pendientes en la base de datos

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const moment = require('moment-timezone');

// Cargar variables de entorno
require('dotenv').config();

console.log('🔄 PROCESANDO COLA AUXILIAR VOZ');
console.log('================================');

async function processVozQueue() {
    let connection = null;

    try {
        // 1. Cargar cola auxiliar
        const queueFile = path.join(__dirname, 'data', 'voz_auxiliary_queue.json');
        console.log(`📂 Cargando cola auxiliar: ${queueFile}`);

        if (!fs.existsSync(queueFile)) {
            console.log('❌ Archivo de cola no encontrado');
            return;
        }

        const queueData = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
        console.log(`📋 Registros en cola: ${queueData.length}`);

        if (queueData.length === 0) {
            console.log('✅ Cola auxiliar vacía');
            return;
        }

        // 2. Conectar a base de datos GPS (donde está la tabla recargas)
        console.log('🔌 Conectando a base de datos GPS...');
        connection = await mysql.createConnection({
            host: process.env.GPS_DB_HOST || '10.8.0.1',
            user: process.env.GPS_DB_USER || 'admin',
            password: process.env.GPS_DB_PASSWORD,
            database: process.env.GPS_DB_NAME || 'GPS_DB',
            port: process.env.GPS_DB_PORT || 3306
        });

        console.log('✅ Conexión establecida');

        // 3. Procesar cada registro
        const processedRecords = [];
        let successCount = 0;
        let failedCount = 0;

        for (const record of queueData) {
            console.log(`\n🔍 Procesando SIM: ${record.sim} (${record.vehiculo})`);
            console.log(`   TransID: ${record.transID}`);
            console.log(`   Monto: $${record.monto}`);
            console.log(`   Folio: ${record.webserviceResponse.folio}`);

            try {
                // Insertar en tabla recargas (maestro)
                const insertSql = `
                    INSERT INTO recargas (fecha, tipo, total, notas, quien, proveedor)
                    VALUES (UNIX_TIMESTAMP(), 'paquete', ?, ?, 'SISTEMA_VOZ', ?)
                `;

                const notas = `Recarga VOZ automática - SIM: ${record.sim}, Vehículo: ${record.vehiculo}, Paquete: ${record.codigoPSL}`;

                const [insertResult] = await connection.execute(insertSql, [
                    record.monto,
                    notas,
                    record.proveedor
                ]);

                const recargaId = insertResult.insertId;
                console.log(`   ✅ Recarga insertada - ID: ${recargaId}`);

                // Insertar en detalle_recargas (usando estructura correcta)
                const detalle = `Recarga VOZ - ${record.codigoPSL} (${record.diasVigencia} días) - Folio: ${record.webserviceResponse.folio} - Timeout: ${record.webserviceResponse.response.timeout}s - IP: ${record.webserviceResponse.response.ip}`;

                const insertDetailSql = `
                    INSERT INTO detalle_recargas (id_recarga, sim, importe, dispositivo, vehiculo, detalle, folio, status)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `;

                await connection.execute(insertDetailSql, [
                    recargaId,
                    record.sim,
                    record.monto,
                    record.sim,
                    record.vehiculo,
                    detalle,
                    record.webserviceResponse.folio,
                    1
                ]);

                console.log(`   ✅ Detalle insertado exitosamente`);

                // 3. ACTUALIZAR FECHA DE VENCIMIENTO PARA PRÓXIMA RECARGA
                const nuevaFechaVencimiento = moment().add(record.diasVigencia, 'days').endOf('day').unix();

                const updateSql = `
                    UPDATE prepagos_automaticos
                    SET fecha_expira_saldo = ?
                    WHERE sim = ?
                `;

                await connection.execute(updateSql, [
                    nuevaFechaVencimiento,
                    record.sim
                ]);

                const fechaLegible = moment.unix(nuevaFechaVencimiento).tz('America/Mazatlan').format('YYYY-MM-DD HH:mm:ss');
                console.log(`   📅 Fecha actualizada: ${nuevaFechaVencimiento} (${fechaLegible})`);
                console.log(`   ⏳ Próxima recarga en ${record.diasVigencia} días`);

                // Marcar como procesado
                record.status = 'completed';
                record.processedAt = Date.now();
                processedRecords.push(record);
                successCount++;

            } catch (error) {
                console.log(`   ❌ Error procesando registro: ${error.message}`);
                failedCount++;
            }
        }

        // 4. Actualizar cola auxiliar (remover procesados)
        console.log(`\n📊 RESULTADOS:`);
        console.log(`   ✅ Exitosos: ${successCount}`);
        console.log(`   ❌ Fallidos: ${failedCount}`);

        if (successCount > 0) {
            // Remover registros procesados de la cola
            const remainingRecords = queueData.filter(record => record.status !== 'completed');
            fs.writeFileSync(queueFile, JSON.stringify(remainingRecords, null, 2));
            console.log(`📝 Cola auxiliar actualizada - ${remainingRecords.length} registros restantes`);
        }

        console.log('\n🎉 Procesamiento completado');

    } catch (error) {
        console.error('❌ Error general:', error.message);
        console.error(error.stack);
    } finally {
        if (connection) {
            await connection.end();
            console.log('🔌 Conexión cerrada');
        }
    }
}

// Ejecutar script
processVozQueue().catch(console.error);