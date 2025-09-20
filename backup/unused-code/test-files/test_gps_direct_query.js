// Script directo para consultar dispositivos GPS que cumplen criterios
const mysql = require('mysql2/promise');
const moment = require('moment-timezone');
require('dotenv').config();

console.log('🧪 CONSULTA DIRECTA GPS - DISPOSITIVOS CANDIDATOS A RECARGA');
console.log('===========================================================');

async function queryGPSDevices() {
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

        // Conectar a base de datos
        console.log('🔌 Conectando a base de datos GPS...');
        connection = await mysql.createConnection({
            host: process.env.GPS_DB_HOST || '10.8.0.1',
            user: process.env.GPS_DB_USER || 'admin',
            password: process.env.GPS_DB_PASSWORD,
            database: process.env.GPS_DB_NAME || 'GPS_DB',
            port: process.env.GPS_DB_PORT || 3306
        });

        console.log('✅ Conexión establecida\n');

        // Query simplificado - solo prepagos_automaticos ya que la lógica GPS se basa en esto
        // Los valores de minutos_sin_reportar y dias_sin_reportar los simularemos para demostrar la lógica
        const query = `
            SELECT
                pa.sim,
                pa.fecha_expira_saldo as unix_saldo,
                pa.status,
                pa.descripcion
            FROM prepagos_automaticos pa
            WHERE pa.status = 1
            ORDER BY pa.fecha_expira_saldo ASC
            LIMIT 20
        `;

        console.log('🔍 Consultando todos los dispositivos activos...');
        const [rawResults] = await connection.execute(query);

        console.log(`📊 Total dispositivos activos: ${rawResults.length}\n`);

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
            // Simular valores de tracking (en producción vienen de la tabla dispositivos o tracking)
            record.minutos_sin_reportar = Math.floor(Math.random() * 30); // 0-30 minutos
            record.dias_sin_reportar = Math.floor(Math.random() * 20); // 0-20 días

            // Validación unix_saldo NULL
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

        console.log('📊 RESUMEN DE CLASIFICACIÓN:');
        console.log('============================');
        console.log(`• Sin fecha de vencimiento: ${sinFecha}`);
        console.log(`• Vencidos: ${vencidos}`);
        console.log(`• Por vencer (hoy): ${porVencer}`);
        console.log(`• Vigentes: ${vigentes}`);
        console.log(`• Inactivos (>${GPS_DIAS_SIN_REPORTAR} días sin reportar): ${inactivos}`);
        console.log(`• En período de gracia (<${GPS_MINUTOS_SIN_REPORTAR} min sin reportar): ${enGracia}`);
        console.log(`• CANDIDATOS A RECARGA: ${candidatosRecarga.length}\n`);

        if (candidatosRecarga.length > 0) {
            console.log('🎯 DISPOSITIVOS QUE SE RECARGARÍAN:');
            console.log('===================================');

            candidatosRecarga.forEach((device, index) => {
                console.log(`${index + 1}. SIM: ${device.sim}`);
                console.log(`   Descripción: ${device.descripcion || 'N/A'}`);
                console.log(`   Estado saldo: ${device.estadoSaldo}`);
                console.log(`   Minutos sin reportar: ${device.minutos_sin_reportar} (simulado)`);
                console.log(`   Días sin reportar: ${device.dias_sin_reportar} (simulado)`);

                const fechaVence = moment.unix(device.unix_saldo).tz(timezone).format('YYYY-MM-DD HH:mm:ss');
                console.log(`   Fecha vencimiento: ${fechaVence}`);
                console.log('');
            });
        } else {
            console.log('❌ No hay dispositivos que cumplan todos los criterios para recarga');
        }

        console.log('\n💰 OPTIMIZACIÓN DE INVERSIÓN:');
        console.log('=============================');
        console.log(`• Dispositivos en período de gracia: ${enGracia} (ahorrando recargas)`);
        console.log('  └─ Aprovechando transmisión ocasional sin saldo de Telcel');
        console.log(`• Dispositivos inactivos ignorados: ${inactivos} (evitando gasto innecesario)`);
        console.log(`• Eficiencia del filtrado: ${((enGracia + inactivos) / rawResults.length * 100).toFixed(1)}% de optimización`);

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
queryGPSDevices().catch(console.error);