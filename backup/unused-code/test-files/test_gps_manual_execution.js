// Script para ejecutar GPS manualmente y ver dispositivos procesados
const moment = require('moment-timezone');
const GPSRechargeProcessor = require('./lib/processors/GPSRechargeProcessor');
require('dotenv').config();

console.log('🧪 EJECUCIÓN MANUAL DE GPS - VALIDACIÓN DE LÓGICA CORREGIDA');
console.log('===========================================================');

async function executeGPSManual() {
    try {
        const timezone = 'America/Mazatlan';
        const now = moment.tz(timezone);

        console.log(`📅 Fecha/Hora actual: ${now.format('YYYY-MM-DD HH:mm:ss')} (${timezone})`);
        console.log(`⏰ Unix timestamp actual: ${now.unix()}\n`);

        // Configuración del procesador GPS
        const config = {
            GPS_MINUTOS_SIN_REPORTAR: 10,
            GPS_DIAS_SIN_REPORTAR: 14,
            GPS_DB_HOST: process.env.GPS_DB_HOST || '10.8.0.1',
            GPS_DB_USER: process.env.GPS_DB_USER || 'admin',
            GPS_DB_PASSWORD: process.env.GPS_DB_PASSWORD,
            GPS_DB_NAME: process.env.GPS_DB_NAME || 'GPS_DB',
            GPS_DB_PORT: process.env.GPS_DB_PORT || 3306,
            GLOBAL: {
                DEFAULT_TIMEZONE: timezone,
                TAECEL_KEY: process.env.TAECEL_KEY,
                TAECEL_NIP: process.env.TAECEL_NIP
            }
        };

        console.log('🔧 Inicializando GPSRechargeProcessor...');
        const processor = new GPSRechargeProcessor(config);

        // Solo ejecutar la lógica de filtrado para ver qué dispositivos se considerarían
        console.log('🔍 Ejecutando solo la lógica de filtrado (sin recargas reales)...\n');

        // Llamar directamente al método de filtrado para ver la lógica
        const devices = await processor.filterDevicesOriginalLogic();

        if (devices && devices.length > 0) {
            console.log(`\n✅ DISPOSITIVOS QUE SE RECARGARÍAN: ${devices.length}`);
            console.log('================================================');

            devices.forEach((device, index) => {
                console.log(`${index + 1}. SIM: ${device.sim}`);
                console.log(`   Dispositivo: ${device.dispositivo}`);
                console.log(`   Vehículo: ${device.vehiculo}`);
                console.log(`   Estado saldo: ${device.estadoSaldo}`);
                console.log(`   Unix saldo: ${device.unix_saldo}`);
                console.log(`   Minutos sin reportar: ${device.minutos_sin_reportar || 'N/A'}`);
                console.log(`   Días sin reportar: ${device.dias_sin_reportar || 'N/A'}`);

                // Mostrar fecha de vencimiento en formato legible
                if (device.unix_saldo && device.unix_saldo !== 'null') {
                    const fechaVence = moment.unix(device.unix_saldo).tz(timezone).format('YYYY-MM-DD HH:mm:ss');
                    console.log(`   Fecha vencimiento: ${fechaVence}`);
                }
                console.log('');
            });
        } else {
            console.log('❌ No hay dispositivos que cumplan los criterios para recarga');
        }

        console.log('\n🎯 RESUMEN DE CRITERIOS APLICADOS:');
        console.log('===================================');
        console.log('✅ unix_saldo NO NULL');
        console.log('✅ Saldo vencido O por vencer HOY');
        console.log('✅ Menos de 14 días sin reportar (dispositivo activo)');
        console.log('✅ Más de 10 minutos sin reportar (necesita recarga)');
        console.log('✅ Período de gracia respetado (optimización de inversión)');

    } catch (error) {
        console.error('❌ Error en ejecución manual:', error.message);
        console.error('Stack:', error.stack);
    }
}

// Ejecutar
executeGPSManual().catch(console.error);