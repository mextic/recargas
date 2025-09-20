#!/usr/bin/env node

/**
 * Script de debug para verificar SIMs GPS específicos
 * Analiza por qué 6682428313 y 6683200532 no se están detectando
 */

const database = require('./lib/database');

function log(message, data = null) {
    const timestamp = new Date().toISOString();
    if (data) {
        console.log(`${timestamp} ${message}`, JSON.stringify(data, null, 2));
    } else {
        console.log(`${timestamp} ${message}`);
    }
}

async function debugGPSSims() {

    try {
        log('🔍 Iniciando debug de SIMs GPS específicos');

        // Conectar a BD
        await database.connect();
        const gpsDb = database.getGPSClient();

        const targetSims = ['6682428313', '6683200532'];
        const minutos_sin_reportar = parseInt(process.env.GPS_MINUTOS_SIN_REPORTAR) || 10;

        for (const sim of targetSims) {
            log(`\n🔍 Analizando SIM: ${sim}`);

            // 1. Verificar si existe en dispositivos
            const deviceQuery = `
                SELECT d.nombre, d.sim, d.prepago, d.unix_saldo, d.fecha_saldo,
                       v.descripcion, v.status as vehiculo_status,
                       e.nombre as empresa, e.status as empresa_status
                FROM dispositivos d
                LEFT JOIN vehiculos v ON v.dispositivo = d.id
                LEFT JOIN empresas e ON v.empresa = e.id
                WHERE d.sim = ?
            `;

            const device = await gpsDb.query(deviceQuery, {
                replacements: [sim],
                type: gpsDb.QueryTypes.SELECT
            });

            if (device.length === 0) {
                log(`❌ SIM ${sim} NO existe en tabla dispositivos`);
                continue;
            }

            const deviceData = device[0];
            log(`✅ Dispositivo encontrado:`, {
                nombre: deviceData.nombre,
                sim: deviceData.sim,
                prepago: deviceData.prepago,
                unix_saldo: deviceData.unix_saldo,
                fecha_saldo: deviceData.fecha_saldo,
                vehiculo_status: deviceData.vehiculo_status,
                empresa_status: deviceData.empresa_status
            });

            // 2. Verificar último reporte en track
            const trackQuery = `
                SELECT dispositivo, MAX(fecha) as ultimo_registro,
                       TRUNCATE((UNIX_TIMESTAMP() - MAX(fecha)) / 60, 0) as minutos_sin_reportar,
                       TRUNCATE((UNIX_TIMESTAMP() - MAX(fecha)) / 60 / 60 / 24, 2) as dias_sin_reportar
                FROM track
                WHERE dispositivo = ?
                GROUP BY dispositivo
            `;

            const trackData = await gpsDb.query(trackQuery, {
                replacements: [deviceData.nombre],
                type: gpsDb.QueryTypes.SELECT
            });

            if (trackData.length === 0) {
                log(`❌ SIM ${sim} NO tiene registros en tabla track`);
                continue;
            }

            const track = trackData[0];
            log(`📊 Último reporte:`, {
                ultimo_registro: new Date(track.ultimo_registro * 1000).toLocaleString(),
                minutos_sin_reportar: track.minutos_sin_reportar,
                dias_sin_reportar: track.dias_sin_reportar,
                cumple_minutos: track.minutos_sin_reportar >= minutos_sin_reportar
            });

            // 3. Verificar estado del saldo
            const ahora = Math.floor(Date.now() / 1000);
            const fin_dia = Math.floor(new Date().setHours(23, 59, 59, 999) / 1000);

            log(`💰 Estado del saldo:`, {
                unix_saldo: deviceData.unix_saldo,
                ahora: ahora,
                fin_dia: fin_dia,
                saldo_vencido: deviceData.unix_saldo < ahora,
                saldo_por_vencer: deviceData.unix_saldo >= ahora && deviceData.unix_saldo <= fin_dia,
                saldo_vigente: deviceData.unix_saldo > fin_dia
            });

            // 4. Verificar recargas recientes (últimos 6 días)
            const recargasQuery = `
                SELECT r.id, r.fecha, r.tipo, dr.sim, dr.folio
                FROM recargas r
                JOIN detalle_recargas dr ON dr.id_recarga = r.id
                WHERE dr.sim = ? AND dr.status = 1 AND r.tipo = 'rastreo'
                  AND r.fecha >= UNIX_TIMESTAMP(DATE_SUB(CURDATE(), INTERVAL 6 DAY))
                ORDER BY r.fecha DESC
                LIMIT 5
            `;

            const recargas = await gpsDb.query(recargasQuery, {
                replacements: [sim],
                type: gpsDb.QueryTypes.SELECT
            });

            log(`🔄 Recargas recientes (últimos 6 días):`, {
                total: recargas.length,
                recargas: recargas.map(r => ({
                    fecha: new Date(r.fecha * 1000).toLocaleString(),
                    folio: r.folio
                }))
            });

            // 5. Ejecutar la consulta optimizada para este SIM específico
            const consultaOptimizada = `
                SELECT DISTINCT
                    UCASE(v.descripcion) AS descripcion,
                    UCASE(e.nombre) AS empresa,
                    d.nombre AS dispositivo,
                    d.sim AS sim,
                    d.unix_saldo AS unix_saldo,
                    v.status as vehiculo_estatus,
                    t_last.ultimo_registro,
                    t_last.minutos_sin_reportar,
                    t_last.dias_sin_reportar
                FROM vehiculos v
                JOIN empresas e ON v.empresa = e.id
                JOIN dispositivos d ON v.dispositivo = d.id
                JOIN (
                    SELECT dispositivo,
                           MAX(fecha) as ultimo_registro,
                           TRUNCATE((UNIX_TIMESTAMP() - MAX(fecha)) / 60, 0) as minutos_sin_reportar,
                           TRUNCATE((UNIX_TIMESTAMP() - MAX(fecha)) / 60 / 60 / 24, 2) as dias_sin_reportar
                    FROM track
                    WHERE dispositivo = ?
                    GROUP BY dispositivo
                    HAVING minutos_sin_reportar >= ${minutos_sin_reportar}
                        AND dias_sin_reportar <= 30
                ) t_last ON t_last.dispositivo = d.nombre
                WHERE d.prepago = 1 AND v.status = 1 AND e.status = 1
                    AND d.unix_saldo IS NOT NULL AND (d.unix_saldo <= ${fin_dia})
                    AND d.sim = ?
                    AND NOT EXISTS (
                        SELECT 1 FROM detalle_recargas dr
                        JOIN recargas r ON dr.id_recarga = r.id
                        WHERE dr.sim = d.sim AND dr.status = 1 AND r.tipo = 'rastreo'
                            AND r.fecha >= UNIX_TIMESTAMP(DATE_SUB(CURDATE(), INTERVAL 6 DAY))
                    )
            `;

            const resultadoOptimizado = await gpsDb.query(consultaOptimizada, {
                replacements: [deviceData.nombre, sim],
                type: gpsDb.QueryTypes.SELECT
            });

            log(`🎯 Resultado consulta optimizada:`, {
                encontrado: resultadoOptimizado.length > 0,
                resultado: resultadoOptimizado.length > 0 ? resultadoOptimizado[0] : null
            });

            // 6. Diagnóstico final
            const diagnostico = {
                existe_dispositivo: device.length > 0,
                es_prepago: deviceData.prepago === 1,
                vehiculo_activo: deviceData.vehiculo_status === 1,
                empresa_activa: deviceData.empresa_status === 1,
                tiene_reportes: trackData.length > 0,
                minutos_suficientes: trackData.length > 0 && track.minutos_sin_reportar >= minutos_sin_reportar,
                saldo_necesita_recarga: deviceData.unix_saldo <= fin_dia,
                sin_recargas_recientes: recargas.length === 0,
                detectado_por_consulta: resultadoOptimizado.length > 0
            };

            log(`🔬 Diagnóstico completo para SIM ${sim}:`, diagnostico);

            // Identificar qué filtro está bloqueando
            const bloqueadores = [];
            if (!diagnostico.existe_dispositivo) bloqueadores.push('No existe en dispositivos');
            if (!diagnostico.es_prepago) bloqueadores.push('No es prepago');
            if (!diagnostico.vehiculo_activo) bloqueadores.push('Vehículo inactivo');
            if (!diagnostico.empresa_activa) bloqueadores.push('Empresa inactiva');
            if (!diagnostico.tiene_reportes) bloqueadores.push('Sin reportes en track');
            if (!diagnostico.minutos_suficientes) bloqueadores.push(`Menos de ${minutos_sin_reportar} min sin reportar`);
            if (!diagnostico.saldo_necesita_recarga) bloqueadores.push('Saldo no necesita recarga');
            if (!diagnostico.sin_recargas_recientes) bloqueadores.push('Tiene recargas recientes (últimos 6 días)');

            if (bloqueadores.length > 0) {
                log(`🚫 SIM ${sim} bloqueado por:`, bloqueadores);
            } else {
                log(`✅ SIM ${sim} debería ser detectado - posible bug en consulta`);
            }
        }

    } catch (error) {
        log('❌ Error en debug GPS:', error);
    } finally {
        // No necesitamos cerrar database explícitamente
        process.exit(0);
    }
}

// Ejecutar si es llamado directamente
if (require.main === module) {
    debugGPSSims();
}

module.exports = { debugGPSSims };