#!/usr/bin/env node
/**
 * Script de Recuperación Específica de Recargas Perdidas
 *
 * Recupera ÚNICAMENTE los 6 SIMs originalmente identificados con pérdida de datos
 * el 19/09/2025 debido al bug "reportandoEnTiempo is not defined"
 *
 * Valida que no existan recargas posteriores antes de procesar cada SIM.
 */

require('dotenv').config();
const moment = require('moment-timezone');
const { dbGps } = require('../lib/database');
const { PersistenceQueueSystem } = require('../lib/concurrency/PersistenceQueueSystem');

// Los 6 SIMs originalmente identificados por el usuario
const targetSims = [
    '6682241818',
    '6682249335',
    '6683214518',
    '6681715175',
    '6682493973',
    '6681968608'
];

// Configurar colores para output
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
    magenta: '\x1b[35m'
};

async function validateSimForRecovery(db, sim) {
    try {
        console.log(`${colors.cyan}🔍 Validando SIM ${sim}...${colors.reset}`);

        // 1. Verificar si ya tiene recarga del 19/09/2025 en BD
        const existingRecharge = await db.querySequelize(
            `SELECT dr.folio, r.fecha, r.notas
             FROM detalle_recargas dr
             JOIN recargas r ON dr.id_recarga = r.id
             WHERE dr.sim = ?
               AND DATE(FROM_UNIXTIME(r.fecha)) = '2025-09-19'
               AND r.tipo = 'rastreo'`,
            {
                replacements: [sim],
                type: db.getSequelizeClient().QueryTypes.SELECT
            }
        );

        if (existingRecharge && existingRecharge.length > 0) {
            return {
                needsRecovery: false,
                reason: `Ya tiene recarga del 19/09/2025 - Folio: ${existingRecharge[0].folio}`
            };
        }

        // 2. Verificar si tiene recargas POSTERIORES al 19/09/2025
        const posteriorRecharges = await db.querySequelize(
            `SELECT dr.folio, r.fecha, r.notas, DATE(FROM_UNIXTIME(r.fecha)) as fecha_recarga
             FROM detalle_recargas dr
             JOIN recargas r ON dr.id_recarga = r.id
             WHERE dr.sim = ?
               AND DATE(FROM_UNIXTIME(r.fecha)) > '2025-09-19'
               AND r.tipo = 'rastreo'
             ORDER BY r.fecha DESC
             LIMIT 3`,
            {
                replacements: [sim],
                type: db.getSequelizeClient().QueryTypes.SELECT
            }
        );

        if (posteriorRecharges && posteriorRecharges.length > 0) {
            const ultimaRecarga = posteriorRecharges[0];
            return {
                needsRecovery: false,
                reason: `Ya tiene recarga posterior del ${ultimaRecarga.fecha_recarga} - Folio: ${ultimaRecarga.folio}`
            };
        }

        // 3. Obtener información del dispositivo
        const deviceInfo = await db.querySequelize(
            `SELECT d.*, v.descripcion, e.nombre as empresa
             FROM dispositivos d
             LEFT JOIN vehiculos v ON d.id = v.dispositivo
             LEFT JOIN empresas e ON v.empresa = e.id
             WHERE d.sim = ? AND d.prepago = 1`,
            {
                replacements: [sim],
                type: db.getSequelizeClient().QueryTypes.SELECT
            }
        );

        if (!deviceInfo || deviceInfo.length === 0) {
            return {
                needsRecovery: false,
                reason: 'Dispositivo no encontrado o no es prepago'
            };
        }

        const device = deviceInfo[0];

        // 4. Verificar si el saldo actual indica que necesita la recarga
        const fechaExpiracion = moment.unix(device.unix_saldo).format('YYYY-MM-DD');

        // Si el saldo expira el 19/09 o antes, y no tiene recargas posteriores, necesita recuperación
        if (device.unix_saldo <= moment('2025-09-19').endOf('day').unix()) {
            return {
                needsRecovery: true,
                device: device,
                reason: `Saldo vence ${fechaExpiracion}, requiere recarga del 19/09`
            };
        }

        return {
            needsRecovery: false,
            reason: `Saldo vigente hasta ${fechaExpiracion}, no requiere recuperación`
        };

    } catch (error) {
        console.error(`❌ Error validando SIM ${sim}: ${error.message}`);
        return { needsRecovery: false, reason: `Error: ${error.message}` };
    }
}

async function createRecoveryItem(device, sim) {
    // CORREGIDO: folio debe ser bigint(20) unsigned - solo números
    const recoveryFolio = parseInt(`${Date.now()}${Math.floor(Math.random() * 1000000)}`);

    return {
        id: `recovery_${Date.now()}_${Math.random()}`,
        tipo: 'gps_recharge',
        sim: sim,
        transId: `RECOVERY_${recoveryFolio}`,
        monto: 10,
        record: {
            descripcion: device.descripcion || 'RECOVERY',
            empresa: device.empresa || 'RECOVERY',
            dispositivo: device.nombre,
            sim: sim,
            unix_saldo: device.unix_saldo,
            minutos_sin_reportar: 999  // Indicar que era por recuperación
        },
        webserviceResponse: {
            folio: recoveryFolio,
            success: true,
            saldoFinal: 'RECOVERY',
            fecha: '2025-09-19 12:00:00',
            carrier: 'Telcel',
            response: {
                timeout: '0.00',
                ip: '0.0.0.0'
            }
        },
        noteData: {
            isRecovery: true,
            originalDate: '2025-09-19',
            reason: 'Recuperación específica de SIM originalemente identificado'
        },
        provider: 'TAECEL',
        status: 'recovery_pending_db',
        timestamp: Date.now(),
        addedAt: Date.now(),
        tipoServicio: 'GPS',
        diasVigencia: 7
    };
}

async function targetedRecovery() {
    // Inicializar conexión a base de datos
    await dbGps.initialize();
    const db = dbGps;
    const persistenceQueue = new PersistenceQueueSystem('gps');

    let totalProcessed = 0;
    let recovered = 0;
    let skipped = 0;
    let errors = 0;

    console.log(`${colors.bright}${colors.blue}=== RECUPERACIÓN ESPECÍFICA DE 6 SIMs ORIGINALES ===${colors.reset}`);
    console.log(`${colors.bright}Fecha: ${moment().format('YYYY-MM-DD HH:mm:ss')}${colors.reset}`);
    console.log(`${colors.cyan}SIMs a validar: ${targetSims.length}${colors.reset}`);
    console.log(`${colors.magenta}SIMs objetivo: ${targetSims.join(', ')}${colors.reset}\n`);

    for (const sim of targetSims) {
        totalProcessed++;
        const progress = `[${totalProcessed}/${targetSims.length}]`;

        try {
            // Validar si necesita recuperación
            const validation = await validateSimForRecovery(db, sim);

            if (validation.needsRecovery) {
                // Crear item de recuperación
                const recoveryItem = await createRecoveryItem(validation.device, sim);

                // Agregar a cola auxiliar
                await persistenceQueue.addToAuxiliaryQueue(recoveryItem, 'gps');

                recovered++;
                console.log(`${colors.green}✅ ${progress} ${sim} - RECUPERADO${colors.reset}`);
                console.log(`   ${validation.reason}`);
                console.log(`   Dispositivo: ${validation.device.nombre}`);
                console.log(`   Empresa: ${validation.device.empresa || 'N/A'}`);

            } else {
                skipped++;
                console.log(`${colors.yellow}⏭️  ${progress} ${sim} - OMITIDO${colors.reset}`);
                console.log(`   ${validation.reason}`);
            }

        } catch (error) {
            errors++;
            console.log(`${colors.red}❌ ${progress} ${sim} - ERROR${colors.reset}`);
            console.log(`   ${error.message}`);
        }

        console.log(''); // Línea separadora
    }

    console.log(`${colors.bright}${colors.cyan}=== RESUMEN FINAL ===${colors.reset}`);
    console.log(`${colors.green}✅ Recuperados: ${recovered}${colors.reset}`);
    console.log(`${colors.yellow}⏭️  Omitidos: ${skipped}${colors.reset}`);
    console.log(`${colors.red}❌ Errores: ${errors}${colors.reset}`);
    console.log(`${colors.cyan}📊 Total procesados: ${totalProcessed}${colors.reset}`);

    if (recovered > 0) {
        console.log(`\n${colors.bright}${colors.green}🎉 ${recovered} recargas específicas agregadas a cola auxiliar${colors.reset}`);
        console.log(`${colors.cyan}El sistema las procesará en el próximo ciclo GPS${colors.reset}`);
    } else {
        console.log(`\n${colors.magenta}ℹ️ Ninguno de los 6 SIMs originales requiere recuperación${colors.reset}`);
        console.log(`${colors.cyan}Todos ya tienen recargas posteriores o del mismo día${colors.reset}`);
    }

    return { recovered, skipped, errors, totalProcessed };
}

// Función principal
async function main() {
    try {
        const results = await targetedRecovery();

        if (results.recovered > 0) {
            console.log(`\n${colors.bright}${colors.green}✅ RECUPERACIÓN ESPECÍFICA COMPLETADA${colors.reset}`);
            console.log(`Se recuperaron ${results.recovered} de los 6 SIMs originalmente identificados`);
        } else {
            console.log(`\n${colors.yellow}ℹ️ Ninguno de los 6 SIMs originales requiere recuperación${colors.reset}`);
            console.log(`Todos ya han sido procesados correctamente en fechas posteriores`);
        }

        process.exit(0);
    } catch (error) {
        console.error(`\n${colors.red}${colors.bright}❌ ERROR EN RECUPERACIÓN ESPECÍFICA${colors.reset}`);
        console.error(error);
        process.exit(1);
    }
}

// Ejecutar si es llamado directamente
if (require.main === module) {
    main().catch(console.error);
}

module.exports = { targetedRecovery };