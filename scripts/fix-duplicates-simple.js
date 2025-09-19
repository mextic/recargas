#!/usr/bin/env node

/**
 * Script simple para eliminar duplicados en detalle_recargas usando mysql2
 */

require('dotenv').config();
const mysql = require('mysql2/promise');

async function fixDuplicates() {
    let connection;

    try {
        console.log('🔄 Conectando a la base de datos GPS_DB...');

        connection = await mysql.createConnection({
            host: '10.8.0.1',
            user: 'admin',
            password: 'xebku3-keNqip-fygrok',
            database: 'gps',
            ssl: false
        });

        console.log('✅ Conectado a GPS_DB');

        // PASO 1: Verificar duplicados antes
        console.log('\n📊 PASO 1: Verificando duplicados actuales...');
        const [duplicatesBefore] = await connection.execute(`
            SELECT COUNT(*) as total_duplicados
            FROM (
                SELECT sim, folio, COUNT(*) as veces
                FROM detalle_recargas
                WHERE folio IS NOT NULL AND folio != ''
                GROUP BY sim, folio
                HAVING COUNT(*) > 1
            ) duplicados
        `);
        console.log(`   💀 Duplicados encontrados: ${duplicatesBefore[0].total_duplicados}`);

        // PASO 2: Mostrar detalle de algunos duplicados
        console.log('\n📋 PASO 2: Mostrando muestra de duplicados...');
        const [duplicatesDetail] = await connection.execute(`
            SELECT sim, folio, COUNT(*) as veces,
                   GROUP_CONCAT(id_recarga ORDER BY id_recarga) as ids_recarga
            FROM detalle_recargas
            WHERE folio IS NOT NULL AND folio != ''
            GROUP BY sim, folio
            HAVING COUNT(*) > 1
            ORDER BY veces DESC
            LIMIT 10
        `);

        duplicatesDetail.forEach(dup => {
            console.log(`   🔍 SIM: ${dup.sim}, Folio: ${dup.folio}, Veces: ${dup.veces}, IDs: ${dup.ids_recarga}`);
        });

        // PASO 3: Crear backup
        console.log('\n💾 PASO 3: Creando backup de duplicados...');
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS detalle_recargas_duplicados_backup AS
            SELECT d.*, 'DUPLICADO_ELIMINADO' as motivo, NOW() as fecha_backup
            FROM detalle_recargas d
            INNER JOIN (
                SELECT sim, folio, GROUP_CONCAT(id_recarga ORDER BY id_recarga DESC LIMIT 10000 OFFSET 1) as ids_to_delete
                FROM detalle_recargas
                WHERE folio IS NOT NULL AND folio != ''
                GROUP BY sim, folio
                HAVING COUNT(*) > 1
            ) duplicados ON FIND_IN_SET(d.id_recarga, duplicados.ids_to_delete) > 0
        `);
        console.log('   ✅ Backup creado');

        // PASO 4: Eliminar duplicados
        console.log('\n🗑️  PASO 4: Eliminando duplicados (manteniendo el más antiguo)...');
        const [deleteResult] = await connection.execute(`
            DELETE d1 FROM detalle_recargas d1
            INNER JOIN detalle_recargas d2
            WHERE d1.sim = d2.sim
              AND d1.folio = d2.folio
              AND d1.folio IS NOT NULL
              AND d1.folio != ''
              AND d1.id_recarga > d2.id_recarga
        `);
        console.log(`   ✅ Eliminados ${deleteResult.affectedRows} registros duplicados`);

        // PASO 5: Verificar limpieza
        console.log('\n🔍 PASO 5: Verificando que no quedan duplicados...');
        const [duplicatesAfter] = await connection.execute(`
            SELECT COUNT(*) as total_duplicados
            FROM (
                SELECT sim, folio, COUNT(*) as veces
                FROM detalle_recargas
                WHERE folio IS NOT NULL AND folio != ''
                GROUP BY sim, folio
                HAVING COUNT(*) > 1
            ) duplicados_restantes
        `);
        console.log(`   💯 Duplicados restantes: ${duplicatesAfter[0].total_duplicados}`);

        // PASO 6: Agregar restricción UNIQUE
        console.log('\n🔒 PASO 6: Agregando restricción UNIQUE...');
        try {
            await connection.execute(`
                ALTER TABLE detalle_recargas
                ADD CONSTRAINT unique_sim_folio UNIQUE (sim, folio)
            `);
            console.log('   ✅ Restricción UNIQUE agregada exitosamente');
        } catch (error) {
            if (error.message.includes('Duplicate entry') || error.message.includes('already exists')) {
                console.log('   ⚠️  Restricción UNIQUE ya existe');
            } else {
                console.error('   ❌ Error agregando restricción:', error.message);
            }
        }

        // PASO 7: Verificar restricción
        console.log('\n✅ PASO 7: Verificando restricción...');
        const [indexes] = await connection.execute(`
            SHOW INDEX FROM detalle_recargas WHERE Key_name = 'unique_sim_folio'
        `);

        if (indexes.length > 0) {
            console.log('   ✅ Restricción UNIQUE confirmada');
        } else {
            console.log('   ⚠️  Restricción UNIQUE no encontrada');
        }

        // PASO 8: Estadísticas finales
        console.log('\n📊 ESTADÍSTICAS FINALES:');
        const [stats] = await connection.execute(`
            SELECT
                COUNT(*) as total_registros,
                COUNT(DISTINCT CONCAT(sim, '-', folio)) as combinaciones_unicas,
                COUNT(*) - COUNT(DISTINCT CONCAT(sim, '-', folio)) as diferencia
            FROM detalle_recargas
            WHERE folio IS NOT NULL AND folio != ''
        `);

        console.log(`   📈 Total registros: ${stats[0].total_registros}`);
        console.log(`   🎯 Combinaciones únicas: ${stats[0].combinaciones_unicas}`);
        console.log(`   ⚖️  Diferencia: ${stats[0].diferencia}`);

        const [backupCount] = await connection.execute(`
            SELECT COUNT(*) as respaldados FROM detalle_recargas_duplicados_backup
        `);
        console.log(`   💾 Registros respaldados: ${backupCount[0].respaldados}`);

        console.log('\n🎉 LIMPIEZA COMPLETADA EXITOSAMENTE!');

    } catch (error) {
        console.error('❌ Error fatal:', error);
        process.exit(1);
    } finally {
        if (connection) {
            await connection.end();
            console.log('🔌 Conexión cerrada');
        }
    }
}

// Ejecutar
if (require.main === module) {
    fixDuplicates();
}

module.exports = { fixDuplicates };