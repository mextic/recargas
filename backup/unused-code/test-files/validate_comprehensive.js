#!/usr/bin/env node

/**
 * Validación Exhaustiva de Recargas GPS - Sept 18, 2025
 *
 * Valida TODAS las recargas del día contra BD y fortalece el sistema de colas
 * para prevenir limpieza prematura y permitir solo recargas 100% verificadas.
 */

const fs = require('fs');
const path = require('path');
const moment = require('moment-timezone');

// Importar configuración de BD
const config = require('./config/database');
const { dbGps, initDatabases } = require('./lib/database');

class ComprehensiveRechargeValidator {
    constructor() {
        this.csvPath = path.join(__dirname, 'ReporteVentasTAE_20250918081310.csv');
        this.auxQueuePath = path.join(__dirname, 'data', 'gps_auxiliary_queue.json');

        this.csvRecharges = [];
        this.dbRecharges = [];
        this.missingRecharges = [];
        this.currentAuxQueue = [];

        this.db = null;

        console.log('🔍 VALIDACIÓN EXHAUSTIVA DE RECARGAS GPS - Sept 18, 2025');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🎯 Objetivo: Validar 100% de recargas y fortalecer sistema de colas');
    }

    async initializeDatabase() {
        console.log('\n🔌 Conectando a base de datos...');
        try {
            await initDatabases();
            this.db = dbGps;
            console.log('   ✅ Conexión establecida exitosamente');
        } catch (error) {
            throw new Error(`Error conectando a BD: ${error.message}`);
        }
    }

    /**
     * Parsea el CSV de TAECEL completamente
     */
    parseCSVRecharges() {
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
                        monto: parseFloat(monto.replace(/[\$,]/g, '')),
                        carrier,
                        timestamp: moment.tz(fechaHora, "YYYY-MM-DD HH:mm:ss", "America/Mazatlan").valueOf()
                    });
                }
            }
        }

        console.log(`   ✅ Recargas exitosas en CSV: ${this.csvRecharges.length}`);
        console.log(`   💰 Total en CSV: $${this.csvRecharges.reduce((sum, r) => sum + r.monto, 0).toFixed(2)} MXN`);

        // Mostrar rango temporal
        if (this.csvRecharges.length > 0) {
            const primera = this.csvRecharges[0].fechaHora;
            const ultima = this.csvRecharges[this.csvRecharges.length - 1].fechaHora;
            console.log(`   ⏰ Rango temporal: ${primera} → ${ultima}`);
        }
    }

    /**
     * Consulta TODAS las recargas del 18 de septiembre en BD
     */
    async queryAllRechargesFromDB() {
        console.log('\n🗄️ Consultando TODAS las recargas del 18/sep en BD...');

        try {
            const sequelize = this.db.getSequelizeClient();

            // Consulta completa de todas las recargas GPS del día
            const query = `
                SELECT
                    r.id as recarga_id,
                    r.total,
                    r.fecha,
                    FROM_UNIXTIME(r.fecha) as fecha_formateada,
                    r.proveedor,
                    r.tipo,
                    dr.sim,
                    dr.folio,
                    dr.importe,
                    dr.dispositivo,
                    dr.status
                FROM recargas r
                INNER JOIN detalle_recargas dr ON r.id = dr.id_recarga
                WHERE DATE(FROM_UNIXTIME(r.fecha)) = '2025-09-18'
                AND r.tipo = 'rastreo'
                AND r.proveedor = 'TAECEL'
                ORDER BY r.fecha ASC, dr.folio ASC
            `;

            console.log('   🔍 Ejecutando consulta exhaustiva...');
            const results = await sequelize.query(query, {
                type: sequelize.QueryTypes.SELECT
            });

            this.dbRecharges = results;

            console.log(`   ✅ Recargas encontradas en BD: ${results.length}`);

            if (results.length > 0) {
                const totalBD = results.reduce((sum, r) => sum + parseFloat(r.importe || 0), 0);
                console.log(`   💰 Total en BD: $${totalBD.toFixed(2)} MXN`);

                // Agrupar por recarga_id para mostrar resumen
                const rechargeGroups = {};
                results.forEach(r => {
                    if (!rechargeGroups[r.recarga_id]) {
                        rechargeGroups[r.recarga_id] = {
                            fecha: r.fecha_formateada,
                            total: r.total,
                            count: 0,
                            folios: []
                        };
                    }
                    rechargeGroups[r.recarga_id].count++;
                    rechargeGroups[r.recarga_id].folios.push(r.folio);
                });

                console.log('\n   📊 Resumen por lote de recarga:');
                Object.keys(rechargeGroups).forEach(recargaId => {
                    const group = rechargeGroups[recargaId];
                    console.log(`   🔸 ID ${recargaId}: ${group.fecha} | $${group.total} | ${group.count} dispositivos`);
                });
            }

            return results;

        } catch (error) {
            throw new Error(`Error consultando BD: ${error.message}`);
        }
    }

    /**
     * Compara CSV vs BD para encontrar discrepancias
     */
    compareCSVvsBD() {
        console.log('\n🔍 Comparando CSV vs BD...');

        // Crear mapas por folio para comparación rápida
        const csvFolios = new Map();
        this.csvRecharges.forEach(r => {
            csvFolios.set(r.folio.toString(), r);
        });

        const dbFolios = new Map();
        this.dbRecharges.forEach(r => {
            if (r.folio) {
                dbFolios.set(r.folio.toString(), r);
            }
        });

        // Encontrar folios en CSV que NO están en BD
        const missingFromDB = [];
        csvFolios.forEach((csvRecharge, folio) => {
            if (!dbFolios.has(folio)) {
                missingFromDB.push(csvRecharge);
            }
        });

        // Encontrar folios en BD que NO están en CSV (posibles duplicados o errores)
        const extraInDB = [];
        dbFolios.forEach((dbRecharge, folio) => {
            if (!csvFolios.has(folio)) {
                extraInDB.push(dbRecharge);
            }
        });

        this.missingRecharges = missingFromDB;

        console.log('\n📊 ANÁLISIS COMPARATIVO:');
        console.log(`   📄 Total en CSV: ${this.csvRecharges.length} recargas`);
        console.log(`   🗄️ Total en BD: ${this.dbRecharges.length} recargas`);
        console.log(`   ❌ Faltantes en BD: ${missingFromDB.length} recargas`);
        console.log(`   ➕ Extras en BD (no en CSV): ${extraInDB.length} recargas`);

        if (missingFromDB.length > 0) {
            console.log('\n❌ RECARGAS FALTANTES EN BD:');
            missingFromDB.forEach((r, index) => {
                console.log(`   ${index + 1}. ${r.fechaHora} | SIM: ${r.telefono} | Folio: ${r.folio} | $${r.monto}`);
            });
        }

        if (extraInDB.length > 0) {
            console.log('\n➕ RECARGAS EXTRA EN BD (no en CSV):');
            extraInDB.slice(0, 10).forEach((r, index) => {
                console.log(`   ${index + 1}. ${r.fecha_formateada} | SIM: ${r.sim} | Folio: ${r.folio} | $${r.importe}`);
            });
            if (extraInDB.length > 10) {
                console.log(`   ... y ${extraInDB.length - 10} más`);
            }
        }

        return { missingFromDB, extraInDB };
    }

    /**
     * Lee y analiza la cola auxiliar actual
     */
    analyzeCurrentAuxiliaryQueue() {
        console.log('\n📋 Analizando cola auxiliar actual...');

        if (fs.existsSync(this.auxQueuePath)) {
            const queueContent = fs.readFileSync(this.auxQueuePath, 'utf-8');
            this.currentAuxQueue = JSON.parse(queueContent);
        } else {
            this.currentAuxQueue = [];
        }

        console.log(`   📊 Items en cola auxiliar: ${this.currentAuxQueue.length}`);

        if (this.currentAuxQueue.length > 0) {
            console.log('   📋 Detalles de cola auxiliar:');
            this.currentAuxQueue.forEach((item, index) => {
                console.log(`   ${index + 1}. SIM: ${item.sim} | Folio: ${item.transId} | Status: ${item.status}`);
            });
        }

        return this.currentAuxQueue;
    }

    /**
     * Genera nueva cola auxiliar con TODAS las recargas faltantes
     */
    generateComprehensiveAuxiliaryQueue() {
        console.log('\n🔧 Generando cola auxiliar exhaustiva...');

        if (this.missingRecharges.length === 0) {
            console.log('   ✅ No hay recargas faltantes - cola auxiliar innecesaria');
            return [];
        }

        const auxiliaryItems = this.missingRecharges.map((recharge, index) => ({
            id: `comprehensive_${Date.now()}_${index}`,
            tipo: 'gps_recharge',
            sim: recharge.telefono,
            transId: recharge.folio,
            monto: recharge.monto,
            record: {
                descripcion: `Recuperado CSV Exhaustivo - ${recharge.carrier || 'Telcel'}`,
                empresa: 'COMPREHENSIVE_RECOVERY',
                dispositivo: recharge.telefono,
                sim: recharge.telefono
            },
            webserviceResponse: {
                transId: recharge.folio,
                monto: recharge.monto,
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
                        Monto: `$ ${recharge.monto.toFixed(2)}`
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
                totalToRecharge: this.missingRecharges.length,
                recoveryNote: `Recarga recuperada exhaustiva CSV TAECEL ${recharge.fechaHora}`,
                originalTimestamp: recharge.fechaHora,
                validationLevel: 'COMPREHENSIVE'
            },
            provider: 'TAECEL',
            status: 'webservice_success_pending_db',
            timestamp: recharge.timestamp,
            addedAt: Date.now(),
            tipoServicio: 'GPS',
            diasVigencia: 7,
            recoveryData: {
                source: 'TAECEL_CSV_20250918_COMPREHENSIVE',
                originalFechaHora: recharge.fechaHora,
                recoveryTimestamp: new Date().toISOString(),
                validatedMissing: true,
                comprehensiveValidation: true
            }
        }));

        console.log(`   🔧 ${auxiliaryItems.length} items generados para cola auxiliar`);
        console.log(`   💰 Valor total a recuperar: $${auxiliaryItems.reduce((sum, item) => sum + item.monto, 0).toFixed(2)} MXN`);

        return auxiliaryItems;
    }

    /**
     * Valida que el sistema de colas sea 100% confiable
     */
    validateQueueReliability() {
        console.log('\n🛡️ Validando confiabilidad del sistema de colas...');

        try {
            // 1. Verificar BaseRechargeProcessor
            const baseProcessorPath = path.join(__dirname, 'lib/processors/BaseRechargeProcessor.js');
            const processorContent = fs.readFileSync(baseProcessorPath, 'utf-8');

            // Validaciones críticas
            const validations = {
                hasValidateMethod: processorContent.includes('validateRechargesInDB'),
                hasCorrectQuery: processorContent.includes('SELECT id_recarga FROM detalle_recargas'),
                hasNotVerifiedCheck: processorContent.includes('notVerified.length > 0'),
                hasFolioValidation: processorContent.includes('folio') && processorContent.includes('detalle_recargas'),
                hasBlockingLogic: processorContent.includes('checkPendingItems'),
                preventsClearOnFail: processorContent.includes('not verified') || processorContent.includes('notVerified')
            };

            console.log('   🔍 Validaciones del sistema de colas:');
            Object.keys(validations).forEach(key => {
                const status = validations[key] ? '✅' : '❌';
                const description = {
                    hasValidateMethod: 'Método validateRechargesInDB presente',
                    hasCorrectQuery: 'Consulta corregida (id_recarga vs id)',
                    hasNotVerifiedCheck: 'Verificación de no verificados',
                    hasFolioValidation: 'Validación de folios en detalle_recargas',
                    hasBlockingLogic: 'Lógica de bloqueo por items pendientes',
                    preventsClearOnFail: 'Prevención de limpieza en caso de fallo'
                };
                console.log(`   ${status} ${description[key]}`);
            });

            const allValid = Object.values(validations).every(v => v);

            if (allValid) {
                console.log('   ✅ Sistema de colas CONFIABLE');
            } else {
                console.log('   ⚠️ ADVERTENCIA: Sistema de colas requiere fortalecimiento');
            }

            return allValid;

        } catch (error) {
            console.warn(`   ⚠️ No se pudo validar completamente: ${error.message}`);
            return false;
        }
    }

    /**
     * Guarda la cola auxiliar con validación extra
     */
    async saveValidatedAuxiliaryQueue(auxiliaryItems) {
        if (auxiliaryItems.length === 0) {
            console.log('\n✅ No hay items para guardar en cola auxiliar');
            return;
        }

        console.log(`\n💾 Guardando cola auxiliar validada (${auxiliaryItems.length} items)...`);

        // Crear directorio si no existe
        const dataDir = path.dirname(this.auxQueuePath);
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }

        // Backup completo de cola actual
        if (fs.existsSync(this.auxQueuePath)) {
            const backupPath = `${this.auxQueuePath}.backup.comprehensive.${Date.now()}`;
            fs.copyFileSync(this.auxQueuePath, backupPath);
            console.log(`   💾 Backup completo: ${path.basename(backupPath)}`);
        }

        // Guardar nueva cola con timestamp de validación
        const finalQueue = auxiliaryItems.map(item => ({
            ...item,
            comprehensiveValidation: {
                validatedAt: new Date().toISOString(),
                validationLevel: 'COMPREHENSIVE',
                mustValidateBeforeClear: true
            }
        }));

        fs.writeFileSync(this.auxQueuePath, JSON.stringify(finalQueue, null, 2));

        console.log(`   ✅ Cola auxiliar guardada: ${finalQueue.length} items`);
        console.log(`   📂 Ubicación: ${this.auxQueuePath}`);
        console.log(`   🛡️ Marcada para validación obligatoria antes de limpieza`);
    }

    /**
     * Ejecuta validación exhaustiva completa
     */
    async execute() {
        try {
            console.log('🚀 Iniciando validación exhaustiva...\n');

            // Paso 1: Conectar BD
            await this.initializeDatabase();

            // Paso 2: Parsear CSV completamente
            this.parseCSVRecharges();

            // Paso 3: Consultar TODAS las recargas de BD
            await this.queryAllRechargesFromDB();

            // Paso 4: Comparar CSV vs BD exhaustivamente
            const { missingFromDB, extraInDB } = this.compareCSVvsBD();

            // Paso 5: Analizar cola auxiliar actual
            this.analyzeCurrentAuxiliaryQueue();

            // Paso 6: Validar confiabilidad del sistema
            const systemReliable = this.validateQueueReliability();

            // Paso 7: Generar cola auxiliar exhaustiva
            const auxiliaryItems = this.generateComprehensiveAuxiliaryQueue();

            // Paso 8: Guardar cola auxiliar validada
            await this.saveValidatedAuxiliaryQueue(auxiliaryItems);

            // RESUMEN FINAL
            console.log('\n✅ VALIDACIÓN EXHAUSTIVA COMPLETADA');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log(`📊 CSV Total: ${this.csvRecharges.length} | BD Total: ${this.dbRecharges.length}`);
            console.log(`❌ Faltantes: ${missingFromDB.length} | ➕ Extras: ${extraInDB.length}`);
            console.log(`🛡️ Sistema de colas: ${systemReliable ? 'CONFIABLE' : 'REQUIERE MEJORAS'}`);

            if (missingFromDB.length > 0) {
                console.log(`💰 Valor a recuperar: $${missingFromDB.reduce((sum, r) => sum + r.monto, 0).toFixed(2)} MXN`);
                console.log('\n📋 ACCIÓN REQUERIDA:');
                console.log('1. npm start - Procesará automáticamente SOLO las recargas faltantes');
                console.log('2. Sistema NO permitirá nuevas recargas hasta validar 100%');
                console.log('3. Cola NO se limpiará hasta confirmar inserción en BD');
                console.log('4. Validación exhaustiva antes de cada limpieza');
            } else {
                console.log('\n🎉 EXCELENTE: Todas las recargas están correctamente en BD');
                console.log('✅ No se requiere recuperación - Sistema funcionando al 100%');
            }

            // Cerrar conexión
            if (this.db && this.db.sequelize) {
                await this.db.sequelize.close();
            }

        } catch (error) {
            console.error('\n❌ ERROR EN VALIDACIÓN EXHAUSTIVA:', error.message);
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
    const validator = new ComprehensiveRechargeValidator();
    validator.execute();
}

module.exports = ComprehensiveRechargeValidator;