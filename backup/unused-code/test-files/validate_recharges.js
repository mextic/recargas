#!/usr/bin/env node

/**
 * Script de Validación y Recuperación Inteligente de Recargas GPS
 *
 * 1. Analiza CSV de TAECEL del 18/sep/2025
 * 2. Consulta BD para identificar qué folios YA existen
 * 3. Solo genera cola auxiliar para recargas FALTANTES
 * 4. Valida mecanismo de limpieza de cola auxiliar
 */

const fs = require('fs');
const path = require('path');
const moment = require('moment-timezone');

// Importar configuración de BD
const config = require('./config/database');
const { dbGps, initDatabases } = require('./lib/database');

class IntelligentRechargeRecovery {
    constructor() {
        this.csvPath = path.join(__dirname, 'ReporteVentasTAE_20250918081310.csv');
        this.auxQueuePath = path.join(__dirname, 'data', 'gps_auxiliary_queue.json');

        this.csvRecharges = [];
        this.existingInDB = [];
        this.missingFromDB = [];

        this.db = null;

        console.log('🔍 Validación Inteligente de Recargas GPS - Sept 18, 2025');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    }

    /**
     * Inicializa conexión a base de datos
     */
    async initializeDatabase() {
        console.log('\n🔌 Conectando a base de datos...');

        try {
            await initDatabases();
            this.db = dbGps; // Usar conexión GPS
            console.log('   ✅ Conexión establecida exitosamente');
        } catch (error) {
            throw new Error(`Error conectando a BD: ${error.message}`);
        }
    }

    /**
     * Parsea el CSV de TAECEL
     */
    parseCSV() {
        console.log('\n📊 Analizando CSV de TAECEL...');

        if (!fs.existsSync(this.csvPath)) {
            throw new Error(`CSV no encontrado: ${this.csvPath}`);
        }

        const csvContent = fs.readFileSync(this.csvPath, 'utf-8');
        const lines = csvContent.split('\n');
        const dataLines = lines.slice(1).filter(line => line.trim());

        console.log(`   📋 Líneas en CSV: ${dataLines.length}`);

        for (const line of dataLines) {
            const parts = line.split(',');

            if (parts.length >= 11) {
                const fechaHora = parts[0]?.replace(/"/g, '').trim();
                const carrier = parts[1]?.replace(/"/g, '').trim();
                const telefono = parts[4]?.replace(/"/g, '').trim();
                const folio = parts[5]?.replace(/"/g, '').trim();
                const monto = parts[6]?.replace(/"/g, '').trim();
                const status = parts[10]?.replace(/"/g, '').trim();

                if (status === 'Exitosa' && telefono && folio) {
                    this.csvRecharges.push({
                        fechaHora,
                        telefono,
                        folio,
                        monto,
                        carrier,
                        timestamp: moment.tz(fechaHora, "YYYY-MM-DD HH:mm:ss", "America/Mazatlan").valueOf()
                    });
                }
            }
        }

        console.log(`   ✅ Recargas exitosas en CSV: ${this.csvRecharges.length}`);

        // Mostrar rango temporal
        if (this.csvRecharges.length > 0) {
            const primera = this.csvRecharges[0].fechaHora;
            const ultima = this.csvRecharges[this.csvRecharges.length - 1].fechaHora;
            console.log(`   ⏰ Rango: ${primera} → ${ultima}`);
        }
    }

    /**
     * Consulta BD para ver qué folios del CSV ya existen
     */
    async checkExistingInDatabase() {
        console.log('\n🔍 Consultando folios existentes en BD...');

        if (this.csvRecharges.length === 0) {
            console.log('   ⚠️ No hay recargas del CSV para consultar');
            return;
        }

        // Extraer todos los folios del CSV
        const folios = this.csvRecharges.map(r => r.folio);
        console.log(`   📋 Consultando ${folios.length} folios únicos...`);

        try {
            // Consulta batch de folios en detalle_recargas con JOIN a recargas para la fecha
            const foliosStr = folios.map(f => `'${f}'`).join(',');
            const query = `
                SELECT DISTINCT dr.folio
                FROM detalle_recargas dr
                INNER JOIN recargas r ON dr.id_recarga = r.id
                WHERE dr.folio IN (${foliosStr})
                AND DATE(FROM_UNIXTIME(r.fecha)) = '2025-09-18'
                AND dr.folio IS NOT NULL
            `;

            console.log('   🔍 Ejecutando consulta SQL...');
            const sequelize = this.db.getSequelizeClient();
            const results = await sequelize.query(query, {
                type: sequelize.QueryTypes.SELECT
            });

            this.existingInDB = results.map(row => row.folio);

            console.log(`   ✅ Folios encontrados en BD: ${this.existingInDB.length}`);

            // Identificar faltantes
            this.missingFromDB = this.csvRecharges.filter(
                recharge => !this.existingInDB.includes(recharge.folio)
            );

            console.log(`   ❌ Folios FALTANTES en BD: ${this.missingFromDB.length}`);

        } catch (error) {
            throw new Error(`Error consultando BD: ${error.message}`);
        }
    }

    /**
     * Muestra resumen detallado de la validación
     */
    showValidationSummary() {
        console.log('\n📊 RESUMEN DE VALIDACIÓN');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log(`📄 Total en CSV TAECEL: ${this.csvRecharges.length} recargas`);
        console.log(`✅ Ya existen en BD: ${this.existingInDB.length} recargas`);
        console.log(`❌ FALTANTES en BD: ${this.missingFromDB.length} recargas`);
        console.log(`💰 Valor faltante: $${this.missingFromDB.length * 10}.00 MXN`);

        if (this.missingFromDB.length > 0) {
            console.log('\n🔍 Primeras 10 recargas faltantes:');
            this.missingFromDB.slice(0, 10).forEach((recharge, index) => {
                console.log(`   ${index + 1}. ${recharge.fechaHora} | SIM: ${recharge.telefono} | Folio: ${recharge.folio}`);
            });

            if (this.missingFromDB.length > 10) {
                console.log(`   ... y ${this.missingFromDB.length - 10} más`);
            }
        }
    }

    /**
     * Valida el mecanismo actual de limpieza de cola auxiliar
     */
    async validateQueueCleaningMechanism() {
        console.log('\n🔧 Validando mecanismo de limpieza de cola auxiliar...');

        try {
            // Leer BaseRechargeProcessor para ver lógica de validación
            const baseProcessorPath = path.join(__dirname, 'lib/processors/BaseRechargeProcessor.js');
            if (!fs.existsSync(baseProcessorPath)) {
                throw new Error('BaseRechargeProcessor.js no encontrado');
            }

            const processorContent = fs.readFileSync(baseProcessorPath, 'utf-8');

            // Verificar que existe validateRechargesInDB
            const hasValidateMethod = processorContent.includes('validateRechargesInDB');
            const hasCorrectQuery = processorContent.includes('SELECT id_recarga FROM detalle_recargas');
            const hasNotVerifiedCheck = processorContent.includes('notVerified.length > 0');

            console.log('   🔍 Validando métodos de seguridad:');
            console.log(`   ${hasValidateMethod ? '✅' : '❌'} validateRechargesInDB() presente`);
            console.log(`   ${hasCorrectQuery ? '✅' : '❌'} Consulta corregida (id_recarga vs id)`);
            console.log(`   ${hasNotVerifiedCheck ? '✅' : '❌'} Verificación de no verificados`);

            if (!hasValidateMethod || !hasCorrectQuery || !hasNotVerifiedCheck) {
                console.warn('   ⚠️ ADVERTENCIA: Mecanismo de validación puede tener problemas');
            } else {
                console.log('   ✅ Mecanismo de validación parece correcto');
            }

        } catch (error) {
            console.warn(`   ⚠️ No se pudo validar mecanismo: ${error.message}`);
        }
    }

    /**
     * Genera cola auxiliar SOLO para recargas faltantes
     */
    async generateAuxiliaryQueue() {
        if (this.missingFromDB.length === 0) {
            console.log('\n✅ No hay recargas faltantes - No se requiere cola auxiliar');
            return [];
        }

        console.log(`\n🔧 Generando cola auxiliar para ${this.missingFromDB.length} recargas faltantes...`);

        const auxiliaryItems = this.missingFromDB.map((recharge, index) => ({
            id: `recovery_${Date.now()}_${index}`,
            tipo: 'gps_recharge',
            sim: recharge.telefono,
            transId: recharge.folio,
            monto: 10.00,
            record: {
                descripcion: `Recuperado CSV - ${recharge.carrier || 'Telcel'}`,
                empresa: 'RECOVERY_DATA',
                dispositivo: recharge.telefono,
                sim: recharge.telefono
            },
            webserviceResponse: {
                transId: recharge.folio,
                monto: 10.00,
                folio: recharge.folio,
                saldoFinal: "N/A",
                carrier: recharge.carrier || "Telcel",
                fecha: recharge.fechaHora.split(' ')[0],
                response: {
                    timeout: "7.00",
                    ip: "127.0.0.1",
                    originalResponse: {
                        TransID: recharge.folio,
                        Folio: recharge.folio,
                        Monto: recharge.monto
                    }
                }
            },
            webserviceData: {
                transID: recharge.folio,
                response: {
                    folio: recharge.folio,
                    timeout: "7.00",
                    ip: "127.0.0.1"
                }
            },
            noteData: {
                currentIndex: index + 1,
                totalToRecharge: this.missingFromDB.length,
                recoveryNote: `Recarga recuperada de CSV TAECEL ${recharge.fechaHora}`,
                originalTimestamp: recharge.fechaHora
            },
            provider: 'TAECEL',
            status: 'webservice_success_pending_db',
            timestamp: recharge.timestamp,
            addedAt: Date.now(),
            tipoServicio: 'GPS',
            diasVigencia: 7,
            recoveryData: {
                source: 'TAECEL_CSV_20250918',
                originalFechaHora: recharge.fechaHora,
                recoveryTimestamp: new Date().toISOString(),
                validatedMissing: true
            }
        }));

        console.log(`   🔧 ${auxiliaryItems.length} items generados para cola auxiliar`);
        return auxiliaryItems;
    }

    /**
     * Guarda la cola auxiliar validada
     */
    async saveAuxiliaryQueue(auxiliaryItems) {
        if (auxiliaryItems.length === 0) {
            console.log('\n✅ No hay items para guardar en cola auxiliar');
            return;
        }

        console.log('\n💾 Guardando cola auxiliar...');

        // Crear directorio si no existe
        const dataDir = path.dirname(this.auxQueuePath);
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }

        // Backup de cola actual si existe
        if (fs.existsSync(this.auxQueuePath)) {
            const currentContent = fs.readFileSync(this.auxQueuePath, 'utf-8');
            const currentQueue = JSON.parse(currentContent);

            if (currentQueue.length > 0) {
                const backupPath = `${this.auxQueuePath}.backup.${Date.now()}`;
                fs.writeFileSync(backupPath, JSON.stringify(currentQueue, null, 2));
                console.log(`   💾 Backup creado: ${path.basename(backupPath)}`);
            }
        }

        // Guardar nueva cola
        fs.writeFileSync(this.auxQueuePath, JSON.stringify(auxiliaryItems, null, 2));

        console.log(`   ✅ Cola auxiliar guardada: ${auxiliaryItems.length} items`);
        console.log(`   📂 Ubicación: ${this.auxQueuePath}`);
    }

    /**
     * Ejecuta todo el proceso de validación y recuperación inteligente
     */
    async execute() {
        try {
            console.log('🚀 Iniciando validación inteligente...\n');

            // Paso 1: Conectar BD
            await this.initializeDatabase();

            // Paso 2: Parsear CSV
            this.parseCSV();

            // Paso 3: Consultar BD para ver qué existe
            await this.checkExistingInDatabase();

            // Paso 4: Mostrar resumen
            this.showValidationSummary();

            // Paso 5: Validar mecanismo de limpieza
            await this.validateQueueCleaningMechanism();

            // Paso 6: Generar cola solo para faltantes
            const auxiliaryItems = await this.generateAuxiliaryQueue();

            // Paso 7: Guardar cola auxiliar
            await this.saveAuxiliaryQueue(auxiliaryItems);

            console.log('\n✅ VALIDACIÓN Y RECUPERACIÓN COMPLETADA');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

            if (this.missingFromDB.length > 0) {
                console.log(`🔄 Se recuperaron ${this.missingFromDB.length} recargas faltantes`);
                console.log('📋 PRÓXIMOS PASOS:');
                console.log('1. npm start - El sistema procesará la cola auxiliar automáticamente');
                console.log('2. Verificar logs de inserción en BD');
                console.log('3. Confirmar que cola se limpie solo tras inserción exitosa');
                console.log(`4. Valor total a recuperar: $${this.missingFromDB.length * 10}.00 MXN`);
            } else {
                console.log('✅ Todas las recargas del CSV ya están en BD - No se requiere recuperación');
            }

            // Cerrar conexión BD
            if (this.db && this.db.sequelize) {
                await this.db.sequelize.close();
            }

        } catch (error) {
            console.error('\n❌ ERROR EN VALIDACIÓN:', error.message);
            console.error(error.stack);

            if (this.db && this.db.sequelize) {
                await this.db.sequelize.close();
            }

            process.exit(1);
        }
    }
}

// Ejecutar si se llama directamente
if (require.main === module) {
    const recovery = new IntelligentRechargeRecovery();
    recovery.execute();
}

module.exports = IntelligentRechargeRecovery;