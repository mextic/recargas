#!/usr/bin/env node

/**
 * Script para eliminar duplicados en detalle_recargas y agregar restricción UNIQUE
 * Usa las credenciales del sistema para conectar a la BD
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Usar el sistema de BD existente
const { dbGps, initDatabases, Sequelize } = require('../lib/database');

async function fixDuplicates() {

    try {
        console.log('🔄 Conectando a la base de datos GPS_DB...');
        await initDatabases();

        // Leer el script SQL
        const sqlFile = path.join(__dirname, 'fix-duplicates.sql');
        const sqlContent = fs.readFileSync(sqlFile, 'utf8');

        // Dividir en comandos individuales
        const sqlCommands = sqlContent
            .split(';')
            .map(cmd => cmd.trim())
            .filter(cmd => cmd.length > 0 && !cmd.startsWith('--'));

        console.log(`📋 Ejecutando ${sqlCommands.length} comandos SQL...\n`);

        for (let i = 0; i < sqlCommands.length; i++) {
            const command = sqlCommands[i];

            // Saltar comentarios y comandos vacíos
            if (command.startsWith('--') || command.length < 10) {
                continue;
            }

            try {
                console.log(`⚡ Ejecutando comando ${i + 1}/${sqlCommands.length}:`);
                console.log(`   ${command.substring(0, 80)}...`);

                const result = await dbGps.query(command, {
                    type: Sequelize.QueryTypes.SELECT
                });

                // Mostrar resultados si los hay
                if (result && result.length > 0) {
                    console.log(`   ✅ Resultado:`, result);
                } else {
                    console.log(`   ✅ Comando ejecutado exitosamente`);
                }

            } catch (error) {
                if (error.message.includes('Duplicate entry') || error.message.includes('already exists')) {
                    console.log(`   ⚠️  Ya existe restricción UNIQUE - Continuando...`);
                } else {
                    console.error(`   ❌ Error en comando ${i + 1}:`, error.message);
                    // Continuar con siguiente comando en caso de error no crítico
                }
            }

            console.log(''); // Línea en blanco
        }

        console.log('🎉 Proceso de limpieza de duplicados completado!');

    } catch (error) {
        console.error('❌ Error fatal:', error);
        process.exit(1);
    } finally {
        // Cerrar conexión
        if (dbGps) {
            await dbGps.close();
        }
        process.exit(0);
    }
}

// Ejecutar si es llamado directamente
if (require.main === module) {
    fixDuplicates();
}

module.exports = { fixDuplicates };