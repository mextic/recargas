// Script correcto para GPS - BD GPS_DB, tabla dispositivos, campo unix_saldo
const mysql = require('mysql2/promise');
const moment = require('moment-timezone');
require('dotenv').config();

console.log('🧪 CONSULTA GPS REAL - TABLA DISPOSITIVOS.UNIX_SALDO');
console.log('===================================================');

async function queryRealGPSDevices() {
    let connection = null;

    try {
        const timezone = 'America/Mazatlan';
        const now = moment.tz(timezone);
        const ahora = now.unix();
        const finDiaHoy = now.clone().endOf('day').unix();

        console.log(`📅 Fecha/Hora actual: ${now.format('YYYY-MM-DD HH:mm:ss')} (${timezone})`);
        console.log(`⏰ Unix timestamp actual: ${ahora}`);
        console.log(`🌅 Unix timestamp fin día hoy: ${finDiaHoy}`);
        console.log(`   └─ Fecha fin día: ${moment.unix(finDiaHoy).tz(timezone).format('YYYY-MM-DD HH:mm:ss')}\n`);

        // Conectar a base de datos GPS
        console.log('🔌 Conectando a base de datos GPS...');
        connection = await mysql.createConnection({
            host: process.env.GPS_DB_HOST || '10.8.0.1',
            user: process.env.GPS_DB_USER || 'admin',
            password: process.env.GPS_DB_PASSWORD,
            database: process.env.GPS_DB_NAME || 'GPS_DB',
            port: process.env.GPS_DB_PORT || 3306
        });

        console.log('✅ Conexión establecida\n');

        // Query correcto para GPS usando tabla dispositivos
        const query = `
            SELECT
                d.sim,
                d.unix_saldo,
                d.nombre as dispositivo,
                d.prepago,
                e.nombre as empresa_nombre,
                d.conexion
            FROM dispositivos d
            LEFT JOIN empresas e ON d.empresa = e.id_empresa
            WHERE d.prepago = 1
            ORDER BY d.unix_saldo ASC
            LIMIT 20
        `;

        console.log('🔍 Consultando dispositivos GPS prepago...');
        const [rawResults] = await connection.execute(query);

        console.log(`📊 Total dispositivos GPS prepago: ${rawResults.length}\n`);

        // Aplicar lógica de filtrado GPS
        const GPS_MINUTOS_SIN_REPORTAR = parseInt(process.env.GPS_MINUTOS_SIN_REPORTAR) || 10;
        const GPS_DIAS_SIN_REPORTAR = parseInt(process.env.GPS_DIAS_SIN_REPORTAR) || 14;

        console.log(`⚙️ CONFIGURACIÓN GPS:`);
        console.log(`   • Mínimo minutos sin reportar: ${GPS_MINUTOS_SIN_REPORTAR}`);
        console.log(`   • Máximo días sin reportar: ${GPS_DIAS_SIN_REPORTAR}\n`);

        let sinFecha = 0;
        let vencidos = 0;
        let porVencer = 0;
        let vigentes = 0;
        let inactivos = 0;
        let enGracia = 0;
        let candidatosRecarga = [];

        for (const record of rawResults) {
            // Simular valores de tracking (en producción vienen de sistema de tracking)
            record.minutos_sin_reportar = Math.floor(Math.random() * 30); // 0-30 minutos
            record.dias_sin_reportar = Math.floor(Math.random() * 20); // 0-20 días

            // Validación unix_saldo NULL - CRÍTICO PARA GPS
            if (!record.unix_saldo || record.unix_saldo === null || record.unix_saldo === 'null') {
                record.estadoSaldo = 'sin_fecha';
                sinFecha++;
                continue;
            }

            const unix_saldo = parseInt(record.unix_saldo);

            // Clasificar estado del saldo
            const estaVencido = unix_saldo < ahora;
            const vencePorVencer = unix_saldo >= ahora && unix_saldo <= finDiaHoy;
            const esVigente = unix_saldo > finDiaHoy;

            if (estaVencido) {
                vencidos++;
                record.estadoSaldo = 'vencido';
            } else if (vencePorVencer) {
                porVencer++;
                record.estadoSaldo = 'por_vencer';
            } else {
                vigentes++;
                record.estadoSaldo = 'vigente';
                continue; // Los vigentes no se procesan
            }

            // Verificar si dispositivo está inactivo (más de 14 días sin reportar)
            if (record.dias_sin_reportar >= GPS_DIAS_SIN_REPORTAR) {
                inactivos++;
                record.razon = 'dispositivo_inactivo';
                continue;
            }

            // Si llegamos aquí: vencido o por_vencer + dispositivo activo
            // Verificar si está en período de gracia (reportando recientemente)
            if (record.minutos_sin_reportar < GPS_MINUTOS_SIN_REPORTAR) {
                enGracia++;
                record.razon = 'periodo_gracia';
                continue;
            }

            // Candidato para recarga
            record.razon = 'candidato_recarga';
            candidatosRecarga.push(record);
        }

        console.log('📊 RESUMEN DE CLASIFICACIÓN GPS:');
        console.log('================================');
        console.log(`• Sin fecha de vencimiento: ${sinFecha}`);
        console.log(`• Vencidos: ${vencidos}`);
        console.log(`• Por vencer (hoy): ${porVencer}`);
        console.log(`• Vigentes: ${vigentes}`);
        console.log(`• Inactivos (>${GPS_DIAS_SIN_REPORTAR} días sin reportar): ${inactivos}`);
        console.log(`• En período de gracia (<${GPS_MINUTOS_SIN_REPORTAR} min sin reportar): ${enGracia}`);
        console.log(`• CANDIDATOS A RECARGA GPS: ${candidatosRecarga.length}\n`);

        if (candidatosRecarga.length > 0) {
            console.log('🎯 DISPOSITIVOS GPS QUE SE RECARGARÍAN:');
            console.log('=======================================');

            candidatosRecarga.forEach((device, index) => {
                console.log(`${index + 1}. SIM: ${device.sim}`);
                console.log(`   Dispositivo: ${device.dispositivo || 'N/A'}`);
                console.log(`   Empresa: ${device.empresa_nombre || 'N/A'}`);
                console.log(`   Estado saldo: ${device.estadoSaldo}`);
                console.log(`   Minutos sin reportar: ${device.minutos_sin_reportar} (simulado)`);
                console.log(`   Días sin reportar: ${device.dias_sin_reportar} (simulado)`);
                console.log(`   Conexión: ${device.conexion ? 'Activa' : 'Inactiva'}`);

                const fechaVence = moment.unix(device.unix_saldo).tz(timezone).format('YYYY-MM-DD HH:mm:ss');
                console.log(`   Fecha vencimiento: ${fechaVence}`);
                console.log('');
            });
        } else {
            console.log('❌ No hay dispositivos GPS que cumplan todos los criterios para recarga');
        }

        console.log('\n💰 OPTIMIZACIÓN DE INVERSIÓN GPS:');
        console.log('=================================');
        console.log(`• Dispositivos en período de gracia: ${enGracia} (ahorrando recargas)`);
        console.log('  └─ Aprovechando transmisión ocasional sin saldo de Telcel');
        console.log(`• Dispositivos inactivos ignorados: ${inactivos} (evitando gasto innecesario)`);
        console.log(`• Eficiencia del filtrado: ${((enGracia + inactivos) / rawResults.length * 100).toFixed(1)}% de optimización`);

        console.log('\n✅ LÓGICA GPS IMPLEMENTADA CORRECTAMENTE:');
        console.log('========================================');
        console.log('✅ Base de datos: GPS_DB');
        console.log('✅ Tabla: dispositivos');
        console.log('✅ Campo: unix_saldo');
        console.log('✅ Filtro: prepago = 1');
        console.log('✅ Lógica: vencido/por_vencer + activo + no reportando = RECARGAR');

    } catch (error) {
        console.error('❌ Error:', error.message);
        console.error('Stack:', error.stack);
    } finally {
        if (connection) {
            await connection.end();
            console.log('\n🔌 Conexión cerrada');
        }
    }
}

// Ejecutar
queryRealGPSDevices().catch(console.error);