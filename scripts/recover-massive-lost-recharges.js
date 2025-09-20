#!/usr/bin/env node
/**
 * Script de Recuperación Masiva de Recargas Perdidas
 *
 * Recupera todas las recargas que se perdieron el 19/09/2025 debido al bug
 * "reportandoEnTiempo is not defined"
 */

require('dotenv').config();
const moment = require('moment-timezone');
const { dbGps } = require('../lib/database');
const { PersistenceQueueSystem } = require('../lib/concurrency/PersistenceQueueSystem');

// Lista de SIMs afectados (extraída de logs)
const affectedSims = [
    '6681011022', '6681016354', '6681029517', '6681135839', '6681137359', '6681147732', '6681148618', '6681168013',
    '6681175133', '6681177925', '6681241283', '6681241586', '6681241591', '6681241593', '6681241596', '6681246174',
    '6681246213', '6681246693', '6681247231', '6681247295', '6681247325', '6681247415', '6681247492', '6681307748',
    '6681308544', '6681316186', '6681316539', '6681378646', '6681378701', '6681378931', '6681379235', '6681381835',
    '6681383698', '6681387087', '6681387254', '6681391656', '6681421159', '6681422854', '6681431547', '6681435038',
    '6681435569', '6681435720', '6681436663', '6681437479', '6681439700', '6681447700', '6681450847', '6681450919',
    '6681454770', '6681454906', '6681458831', '6681462522', '6681469627', '6681481287', '6681482090', '6681487795',
    '6681500619', '6681501904', '6681502946', '6681511474', '6681518647', '6681521593', '6681529844', '6681564839',
    '6681569256', '6681571474', '6681572664', '6681621769', '6681622037', '6681623133', '6681624070', '6681624557',
    '6681625516', '6681626484', '6681635265', '6681635271', '6681636118', '6681636225', '6681636235', '6681636667',
    '6681639539', '6681684661', '6681684977', '6681702295', '6681715175', '6681726705', '6681839659', '6681844743',
    '6681848159', '6681852962', '6681858766', '6681868208', '6681871572', '6681871580', '6681871792', '6681871819',
    '6681871960', '6681872021', '6681872301', '6681872467', '6681872593', '6681872757', '6681872839', '6681873496',
    '6681873952', '6681900901', '6681901403', '6681902172', '6681902728', '6681904217', '6681905024', '6681905643',
    '6681907140', '6681908408', '6681909665', '6681915656', '6681916728', '6681916858', '6681920761', '6681923287',
    '6681923570', '6681924488', '6681926050', '6681926592', '6681936879', '6681940259', '6681940395', '6681940644',
    '6681941012', '6681941222', '6681941328', '6681942624', '6681944007', '6681958881', '6681968608', '6681983294',
    '6681999446', '6682198805', '6682213728', '6682213785', '6682213833', '6682240262', '6682241818', '6682249335',
    '6682254879', '6682275726', '6682299492', '6682309116', '6682322231', '6682337117', '6682338660', '6682348308',
    '6682359290', '6682364990', '6682365024', '6682423639', '6682426931', '6682434540', '6682440085', '6682442738',
    '6682442839', '6682458098', '6682464822', '6682473542', '6682485053', '6682492112', '6682493973', '6682495806',
    '6682501075', '6682501081', '6682501109', '6682505957', '6682508335', '6682511762', '6682513973', '6682514243',
    '6682516069', '6682516662', '6682517492', '6682518273', '6682521147', '6682522032', '6682522046', '6682529710',
    '6682531929', '6682614127', '6683201708', '6683203210', '6683206208', '6683206256', '6683206330', '6683206357',
    '6683207286', '6683207367', '6683208046', '6683208620', '6683209050', '6683210013', '6683210074', '6683210383',
    '6683210568', '6683213107', '6683214373', '6683214514', '6683214518', '6683216842', '6683217163', '6683217360',
    '6683220391', '6683222107', '6683225544', '6683225552', '6683225786', '6683225948', '6683231152', '6683231567',
    '6683236363', '6683237194', '6683238387', '6683239102', '6683239592', '6683240522', '6683950858', '6683952359',
    '6683957332', '6683967458', '6683967706', '6683971335', '6683974363', '6683978978', '6684226867', '6684630980',
    '6684631733', '6684631860', '6684632147', '6684632596', '6684634238', '6684635879', '6684636497', '6684638076',
    '6684638108', '6684638373', '6684643712', '6684643817', '6684646654', '6684646807', '6684647014', '6684801857',
    '6684803734', '6684804336', '6688203498', '6688206138', '6688206225', '6688208210', '6688228926', '6688259237',
    '6688281341', '6688281512', '6688283678', '6688610325', '6688614211', '6688615077', '6688820595', '6688822268',
    '6688853739', '6688853943', '6688859486', '8110481080', '8110482641', '8110483737', '8111663756', '8111695024',
    '8111762635', '8111764697', '8111789384', '8111816177', '8111824942', '8111845442', '8111847622', '8111851669',
    '8112288487', '8112389739', '8112392667', '8112395166', '8112435589', '8112436568', '8112458946', '8112498887',
    '8112514844', '8135587590'
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

async function checkRechargeNeedsRecovery(db, sim) {
    try {
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
            return { needsRecovery: false, reason: 'Ya tiene recarga del 19/09/2025 en BD' };
        }

        // 2. Obtener información del dispositivo
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
            return { needsRecovery: false, reason: 'Dispositivo no encontrado o no es prepago' };
        }

        const device = deviceInfo[0];

        // 3. Verificar si el saldo actual indica que necesita la recarga
        const ahora = Math.floor(Date.now() / 1000);
        const fechaExpiracion = moment.unix(device.unix_saldo).format('YYYY-MM-DD');

        // Si el saldo expira el 19/09 o antes, necesita recuperación
        if (device.unix_saldo <= moment('2025-09-19').endOf('day').unix()) {
            return {
                needsRecovery: true,
                device: device,
                reason: `Saldo vence ${fechaExpiracion}, necesita recarga del 19/09`
            };
        }

        return {
            needsRecovery: false,
            reason: `Saldo OK hasta ${fechaExpiracion}`
        };

    } catch (error) {
        console.error(`❌ Error verificando SIM ${sim}: ${error.message}`);
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
            reason: 'Recuperación masiva por bug reportandoEnTiempo'
        },
        provider: 'TAECEL',
        status: 'recovery_pending_db',
        timestamp: Date.now(),
        addedAt: Date.now(),
        tipoServicio: 'GPS',
        diasVigencia: 7
    };
}

async function massiveRecovery() {
    // Inicializar conexión a base de datos
    await dbGps.initialize();
    const db = dbGps;
    const persistenceQueue = new PersistenceQueueSystem('gps');

    let totalProcessed = 0;
    let recovered = 0;
    let skipped = 0;
    let errors = 0;

    console.log(`${colors.bright}${colors.blue}=== RECUPERACIÓN MASIVA DE RECARGAS PERDIDAS ===${colors.reset}`);
    console.log(`${colors.bright}Fecha: ${moment().format('YYYY-MM-DD HH:mm:ss')}${colors.reset}`);
    console.log(`${colors.cyan}SIMs a procesar: ${affectedSims.length}${colors.reset}\n`);

    for (const sim of affectedSims) {
        totalProcessed++;
        const progress = `[${totalProcessed}/${affectedSims.length}]`;

        try {
            // Verificar si necesita recuperación
            const check = await checkRechargeNeedsRecovery(db, sim);

            if (check.needsRecovery) {
                // Crear item de recuperación
                const recoveryItem = await createRecoveryItem(check.device, sim);

                // Agregar a cola auxiliar
                await persistenceQueue.addToAuxiliaryQueue(recoveryItem, 'gps');

                recovered++;
                console.log(`${colors.green}✅ ${progress} ${sim} - RECUPERADO${colors.reset} (${check.reason})`);

            } else {
                skipped++;
                console.log(`${colors.yellow}⏭️  ${progress} ${sim} - OMITIDO${colors.reset} (${check.reason})`);
            }

        } catch (error) {
            errors++;
            console.log(`${colors.red}❌ ${progress} ${sim} - ERROR${colors.reset} (${error.message})`);
        }

        // Pequeña pausa para no sobrecargar
        if (totalProcessed % 10 === 0) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }

    console.log(`\n${colors.bright}${colors.cyan}=== RESUMEN FINAL ===${colors.reset}`);
    console.log(`${colors.green}✅ Recuperados: ${recovered}${colors.reset}`);
    console.log(`${colors.yellow}⏭️  Omitidos: ${skipped}${colors.reset}`);
    console.log(`${colors.red}❌ Errores: ${errors}${colors.reset}`);
    console.log(`${colors.cyan}📊 Total procesados: ${totalProcessed}${colors.reset}`);

    if (recovered > 0) {
        console.log(`\n${colors.bright}${colors.green}🎉 ${recovered} recargas agregadas a cola auxiliar para procesamiento automático${colors.reset}`);
        console.log(`${colors.cyan}El sistema las procesará en el próximo ciclo GPS${colors.reset}`);
    }

    return { recovered, skipped, errors, totalProcessed };
}

// Función principal
async function main() {
    try {
        const results = await massiveRecovery();

        if (results.recovered > 0) {
            console.log(`\n${colors.bright}${colors.green}✅ RECUPERACIÓN MASIVA COMPLETADA${colors.reset}`);
            console.log(`Se recuperaron ${results.recovered} recargas perdidas`);
        } else {
            console.log(`\n${colors.yellow}ℹ️ No se encontraron recargas que requieran recuperación${colors.reset}`);
        }

        process.exit(0);
    } catch (error) {
        console.error(`\n${colors.red}${colors.bright}❌ ERROR EN RECUPERACIÓN MASIVA${colors.reset}`);
        console.error(error);
        process.exit(1);
    }
}

// Ejecutar si es llamado directamente
if (require.main === module) {
    main().catch(console.error);
}

module.exports = { massiveRecovery };