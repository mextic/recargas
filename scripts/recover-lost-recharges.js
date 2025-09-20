#!/usr/bin/env node
/**
 * Script de Recuperación de Recargas Perdidas
 *
 * Este script identifica y recupera recargas que se ejecutaron exitosamente
 * en el webservice pero no se guardaron en la BD debido a excepciones.
 *
 * Uso: node scripts/recover-lost-recharges.js [SIM] [FOLIO]
 */

require('dotenv').config();
const moment = require('moment-timezone');
const { getDatabaseConnection } = require('../lib/database');
const { PersistenceQueueSystem } = require('../lib/concurrency/PersistenceQueueSystem');

// Configurar colores para output
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m'
};

async function recoverLostRecharge(sim, folio, fechaRecarga) {
    const db = await getDatabaseConnection();
    const persistenceQueue = new PersistenceQueueSystem('gps');

    try {
        console.log(`${colors.cyan}🔍 Verificando recarga perdida...${colors.reset}`);
        console.log(`   SIM: ${sim}`);
        console.log(`   Folio: ${folio}`);
        console.log(`   Fecha: ${fechaRecarga}`);

        // 1. Verificar si el folio ya existe en detalle_recargas
        const existingRecharge = await db.querySequelize(
            `SELECT dr.*, r.fecha, r.notas
             FROM detalle_recargas dr
             JOIN recargas r ON dr.id_recarga = r.id
             WHERE dr.folio = ?`,
            {
                replacements: [folio],
                type: db.getSequelizeClient().QueryTypes.SELECT
            }
        );

        if (existingRecharge && existingRecharge.length > 0) {
            console.log(`${colors.yellow}⚠️ El folio ${folio} ya existe en BD${colors.reset}`);
            console.log(`   ID Recarga: ${existingRecharge[0].id_recarga}`);
            console.log(`   Fecha: ${moment.unix(existingRecharge[0].fecha).format('YYYY-MM-DD HH:mm:ss')}`);
            return false;
        }

        // 2. Obtener información del dispositivo
        const deviceInfo = await db.querySequelize(
            `SELECT d.*, v.descripcion, e.nombre as empresa
             FROM dispositivos d
             LEFT JOIN vehiculos v ON d.id = v.dispositivo
             LEFT JOIN empresas e ON v.empresa = e.id
             WHERE d.sim = ?`,
            {
                replacements: [sim],
                type: db.getSequelizeClient().QueryTypes.SELECT
            }
        );

        if (!deviceInfo || deviceInfo.length === 0) {
            console.log(`${colors.red}❌ No se encontró dispositivo con SIM ${sim}${colors.reset}`);
            return false;
        }

        const device = deviceInfo[0];
        console.log(`${colors.green}✅ Dispositivo encontrado:${colors.reset}`);
        console.log(`   Nombre: ${device.nombre}`);
        console.log(`   Vehículo: ${device.descripcion || 'N/A'}`);
        console.log(`   Empresa: ${device.empresa || 'N/A'}`);
        console.log(`   Unix Saldo Actual: ${device.unix_saldo} (${moment.unix(device.unix_saldo).format('DD/MM/YYYY')})`);

        // 3. Crear item de recuperación para cola auxiliar
        const recoveryItem = {
            id: `recovery_${Date.now()}_${Math.random()}`,
            tipo: 'gps_recharge',
            sim: sim,
            transId: `RECOVERY_${folio}`,
            monto: 10,
            record: {
                descripcion: device.descripcion,
                empresa: device.empresa,
                dispositivo: device.nombre,
                sim: sim,
                unix_saldo: device.unix_saldo
            },
            webserviceResponse: {
                folio: folio,
                success: true,
                saldoFinal: 'RECOVERY',
                fecha: fechaRecarga,
                carrier: 'Telcel',
                response: {
                    timeout: '0.00',
                    ip: '0.0.0.0'
                }
            },
            noteData: {
                isRecovery: true,
                originalDate: fechaRecarga,
                reason: 'Recuperación de recarga perdida por excepción'
            },
            provider: 'TAECEL',
            status: 'recovery_pending_db',
            timestamp: Date.now(),
            addedAt: Date.now(),
            tipoServicio: 'GPS',
            diasVigencia: 7
        };

        // 4. Agregar a cola auxiliar
        console.log(`${colors.cyan}📝 Agregando a cola auxiliar para procesamiento...${colors.reset}`);
        await persistenceQueue.addToAuxiliaryQueue(recoveryItem, 'gps');

        console.log(`${colors.green}✅ RECARGA AGREGADA A COLA AUXILIAR${colors.reset}`);
        console.log(`   La recarga será procesada en el siguiente ciclo del sistema`);
        console.log(`   Folio: ${folio}`);
        console.log(`   SIM: ${sim}`);

        // 5. Calcular nuevo unix_saldo esperado (actual + 7 días)
        const nuevoUnixSaldo = device.unix_saldo + (7 * 24 * 60 * 60);
        console.log(`${colors.blue}📅 Nuevo unix_saldo esperado después del procesamiento:${colors.reset}`);
        console.log(`   ${nuevoUnixSaldo} (${moment.unix(nuevoUnixSaldo).format('DD/MM/YYYY')})`);

        return true;

    } catch (error) {
        console.error(`${colors.red}❌ Error en recuperación: ${error.message}${colors.reset}`);
        throw error;
    }
}

// Función principal
async function main() {
    const args = process.argv.slice(2);

    if (args.length < 2) {
        console.log(`${colors.yellow}Uso: node scripts/recover-lost-recharges.js [SIM] [FOLIO] [FECHA_OPCIONAL]${colors.reset}`);
        console.log(`Ejemplo: node scripts/recover-lost-recharges.js 6682241818 311474`);
        console.log(`Ejemplo con fecha: node scripts/recover-lost-recharges.js 6682241818 311474 "2025-09-19 13:21:50"`);
        process.exit(1);
    }

    const sim = args[0];
    const folio = args[1];
    const fechaRecarga = args[2] || moment().format('YYYY-MM-DD HH:mm:ss');

    console.log(`${colors.bright}${colors.blue}=== RECUPERACIÓN DE RECARGA PERDIDA ===${colors.reset}`);
    console.log(`${colors.bright}Fecha: ${moment().format('YYYY-MM-DD HH:mm:ss')}${colors.reset}\n`);

    try {
        const recovered = await recoverLostRecharge(sim, folio, fechaRecarga);

        if (recovered) {
            console.log(`\n${colors.green}${colors.bright}✅ RECUPERACIÓN EXITOSA${colors.reset}`);
            console.log(`La recarga ha sido agregada a la cola auxiliar y será procesada automáticamente.`);
        } else {
            console.log(`\n${colors.yellow}⚠️ No se requirió recuperación${colors.reset}`);
        }

        process.exit(0);
    } catch (error) {
        console.error(`\n${colors.red}${colors.bright}❌ RECUPERACIÓN FALLIDA${colors.reset}`);
        console.error(error);
        process.exit(1);
    }
}

// Ejecutar si es llamado directamente
if (require.main === module) {
    main().catch(console.error);
}

module.exports = { recoverLostRecharge };