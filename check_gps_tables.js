// Script para verificar estructura de tablas GPS
const mysql = require('mysql2/promise');
require('dotenv').config();

console.log('🔍 VERIFICANDO ESTRUCTURA DE TABLAS GPS');
console.log('======================================');

async function checkTablesStructure() {
    let connection = null;

    try {
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

        // Verificar tabla prepagos_automaticos
        console.log('📋 ESTRUCTURA prepagos_automaticos:');
        const [pa_columns] = await connection.execute('DESCRIBE prepagos_automaticos');
        pa_columns.forEach(col => {
            console.log(`   • ${col.Field} (${col.Type}) ${col.Null === 'YES' ? 'NULL' : 'NOT NULL'}`);
        });

        console.log('\n📋 ESTRUCTURA dispositivos:');
        const [d_columns] = await connection.execute('DESCRIBE dispositivos');
        d_columns.forEach(col => {
            console.log(`   • ${col.Field} (${col.Type}) ${col.Null === 'YES' ? 'NULL' : 'NOT NULL'}`);
        });

        console.log('\n📋 TODAS LAS TABLAS EN BASE DE DATOS:');
        const [tables] = await connection.execute('SHOW TABLES');
        tables.forEach(table => {
            console.log(`   • ${Object.values(table)[0]}`);
        });

        console.log('\n📋 ESTRUCTURA empresas:');
        const [e_columns] = await connection.execute('DESCRIBE empresas');
        e_columns.forEach(col => {
            console.log(`   • ${col.Field} (${col.Type}) ${col.Null === 'YES' ? 'NULL' : 'NOT NULL'}`);
        });

        // Ver algunos datos de ejemplo
        console.log('\n📊 EJEMPLO gps (primeros 5):');
        const [gps_sample] = await connection.execute('SELECT sim, unix_saldo, vehiculo, dispositivo FROM gps LIMIT 5');
        gps_sample.forEach((row, idx) => {
            console.log(`   ${idx + 1}. SIM: ${row.sim}, Unix saldo: ${row.unix_saldo}, Vehículo: ${row.vehiculo}, Dispositivo: ${row.dispositivo}`);
        });

        console.log('\n📊 EJEMPLO prepagos_automaticos (primeros 3):');
        const [pa_sample] = await connection.execute('SELECT * FROM prepagos_automaticos LIMIT 3');
        pa_sample.forEach((row, idx) => {
            console.log(`   ${idx + 1}. SIM: ${row.sim}, Status: ${row.status}, Fecha expira: ${row.fecha_expira_saldo}`);
        });

        console.log('\n📊 EJEMPLO dispositivos (primeros 3):');
        const [d_sample] = await connection.execute('SELECT * FROM dispositivos LIMIT 3');
        d_sample.forEach((row, idx) => {
            console.log(`   ${idx + 1}. SIM: ${row.sim || 'N/A'}, Nombre: ${row.nombre}`);
        });

    } catch (error) {
        console.error('❌ Error:', error.message);
    } finally {
        if (connection) {
            await connection.end();
            console.log('\n🔌 Conexión cerrada');
        }
    }
}

// Ejecutar
checkTablesStructure().catch(console.error);