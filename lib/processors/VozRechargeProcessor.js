const moment = require('moment-timezone');
const xml2js = require('xml2js');
const soapRequest = require('easy-soap-request');
const axios = require('axios');
const config = require('../../config/database.js');

class VozRechargeProcessor {
    constructor(dbConnection, lockManager, persistenceQueue) {
        this.db = dbConnection;
        this.lockManager = lockManager;
        this.persistenceQueue = persistenceQueue;
        // Configuración de paquetes VOZ - Basada en códigos reales de BD
        this.paquetes = {
            // Códigos activos en BD
            150005: { codigo: "PSL150", dias: 25, monto: 150, descripcion: "MDVR/Equipos especiales" },
            150006: { codigo: "PSL150", dias: 25, monto: 150, descripcion: "Usuarios individuales" },
            300005: { codigo: "PSL300", dias: 30, monto: 300, descripcion: "DashCam/Equipos avanzados" },
            // Códigos legacy por compatibilidad
            10007: { codigo: "PSL010", dias: 1, monto: 10, descripcion: "Legacy 10" },
            20006: { codigo: "PSL020", dias: 2, monto: 20, descripcion: "Legacy 20" },
            30006: { codigo: "PSL030", dias: 3, monto: 30, descripcion: "Legacy 30" },
            50006: { codigo: "PSL050", dias: 7, monto: 50, descripcion: "Legacy 50" },
            100006: { codigo: "PSL100", dias: 15, monto: 100, descripcion: "Legacy 100" },
            200006: { codigo: "PSL200", dias: 30, monto: 200, descripcion: "Legacy 200" }
        };
    }

    async process() {
        const stats = { processed: 0, success: 0, failed: 0 };
        const lockKey = 'recharge_voz';
        const lockId = `${lockKey}_${process.pid}_${Date.now()}`;
        let lockAcquired = false;

        try {
            // Similar a GPS pero para prepagos_automaticos
            const lockExpirationMinutes = parseInt(process.env.LOCK_EXPIRATION_MINUTES) || 60;
            const lockTimeoutSeconds = lockExpirationMinutes * 60;
            const lockResult = await this.lockManager.acquireLock(lockKey, lockId, lockTimeoutSeconds);
            if (!lockResult.success) {
                console.log('   ⚠️ No se pudo adquirir lock VOZ');
                return stats;
            }
            lockAcquired = true;

            // 1. PRIMERO: Procesar cola auxiliar VOZ (recovery)
            console.log('🔄 Verificando cola auxiliar VOZ para recovery...');
            const pendingStats = await this.persistenceQueue.getQueueStats();
            
            if (pendingStats.auxiliaryQueue.pendingDb > 0) {
                console.log(`⚡ Procesando ${pendingStats.auxiliaryQueue.pendingDb} recargas VOZ de recovery...`);
                const recoveryResult = await this.processAuxiliaryQueueRecharges();
                console.log(`   • Cola auxiliar VOZ: ${recoveryResult.processed} recuperadas, ${recoveryResult.failed} fallidas`);
                
                // SI HAY FALLAS EN RECOVERY, NO PROCESAR NUEVOS REGISTROS
                if (recoveryResult.failed > 0) {
                    console.log(`   ⚠️ HAY ${recoveryResult.failed} REGISTROS PENDIENTES SIN PROCESAR. NO CONSUMIENDO WEBSERVICES.`);
                    stats.failed = recoveryResult.failed;
                    return stats;
                }
            }

            const records = await this.getRecordsToProcess();
            console.log(`   📋 ${records.length} paquetes VOZ para procesar`);

            // Procesar cada paquete VOZ
            for (const record of records) {
                try {
                    const paqueteConfig = this.paquetes[record.codigo_paquete];
                    if (!paqueteConfig) {
                        console.log(`   ⚠️ Código de paquete desconocido: ${record.codigo_paquete} (SIM: ${record.sim})`);
                        stats.failed++;
                        continue;
                    }

                    console.log(`   📞 Procesando VOZ: SIM ${record.sim}, Paquete ${record.codigo_paquete} (${paqueteConfig.descripcion}), Monto: $${paqueteConfig.monto}`);

                    // Intentar recarga con webservices (TAECEL/MST con reintentos)
                    const rechargeResult = await this.attemptRecharge(record, paqueteConfig);

                    if (rechargeResult.success) {
                        // Agregar a cola auxiliar universal
                        const auxItem = {
                            id: `aux_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
                            sim: record.sim,
                            vehiculo: record.descripcion || `VOZ-${record.sim}`,
                            empresa: "SERVICIO VOZ",
                            transID: rechargeResult.transID,
                            proveedor: rechargeResult.provider,
                            provider: rechargeResult.provider,

                            // ESTRUCTURA UNIVERSAL PARA VOZ
                            tipo: "voz_recharge",
                            tipoServicio: "VOZ",
                            monto: paqueteConfig.monto,
                            diasVigencia: paqueteConfig.dias,

                            // Datos específicos de VOZ
                            codigoPaquete: record.codigo_paquete,
                            codigoPSL: paqueteConfig.codigo,

                            webserviceResponse: rechargeResult.response,

                            status: "webservice_success_pending_db",
                            timestamp: Date.now(),
                            addedAt: Date.now()
                        };

                        await this.persistenceQueue.addToAuxiliaryQueue(auxItem);

                        stats.processed++;
                        stats.success++;
                        console.log(`   ✅ VOZ ${record.sim} recargado y agregado a cola auxiliar (${paqueteConfig.dias} días, $${paqueteConfig.monto}, Provider: ${rechargeResult.provider})`);
                    } else {
                        stats.failed++;
                        console.log(`   ❌ VOZ ${record.sim} falló después de reintentos: ${rechargeResult.error}`);
                    }

                } catch (error) {
                    console.error(`   ❌ Error procesando VOZ ${record.sim}:`, error.message);
                    stats.failed++;
                }
            }

        } finally {
            if (lockAcquired) {
                await this.lockManager.releaseLock(lockKey, lockId);
            }
        }

        return stats;
    }

    async getRecordsToProcess() {
        const tomorrow = moment().add(1, "days").endOf("day").unix();
        const hoy = moment.tz("America/Mazatlan").format("YYYY-MM-DD");

        const sql = `
            SELECT *
            FROM prepagos_automaticos
            WHERE status = 1
                AND fecha_expira_saldo <= ${tomorrow}
                AND sim NOT IN (
                    SELECT DISTINCT dr.sim
                    FROM detalle_recargas dr
                    INNER JOIN recargas r ON dr.id_recarga = r.id
                    WHERE DATE(FROM_UNIXTIME(r.fecha)) = '${hoy}'
                        AND r.tipo = 'paquete'
                        AND dr.status = 1
                )
            LIMIT 300
        `;

        return await this.db.querySequelize(sql);
    }

    async attemptRecharge(record, paqueteConfig) {
        const maxRetries = 3;
        let lastError = null;

        // Lista de proveedores a intentar (TAECEL primero por saldo)
        const providers = await this.getProvidersOrderedByBalance();

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            for (const provider of providers) {
                try {
                    console.log(`   🔄 Intento ${attempt}/${maxRetries} con ${provider.name} para SIM ${record.sim}`);

                    const result = await this.callWebservice(provider, record, paqueteConfig);

                    if (result.success) {
                        return {
                            success: true,
                            provider: provider.name,
                            transID: result.transID,
                            response: result.response
                        };
                    } else {
                        lastError = result.error;
                        console.log(`   ⚠️ ${provider.name} falló para SIM ${record.sim}: ${result.error}`);
                    }
                } catch (error) {
                    lastError = error.message;
                    console.error(`   ❌ Error con ${provider.name} para SIM ${record.sim}:`, error.message);
                }
            }

            if (attempt < maxRetries) {
                console.log(`   ⏳ Esperando antes del siguiente intento...`);
                await new Promise(resolve => setTimeout(resolve, 2000)); // 2 segundos entre intentos
            }
        }

        return {
            success: false,
            error: `Falló después de ${maxRetries} intentos: ${lastError}`
        };
    }

    async getProvidersOrderedByBalance() {
        let balanceTaecel = 0;
        let balanceMst = 0;

        try {
            // Obtener saldo TAECEL
            console.log('   💰 Consultando saldo TAECEL...');
            balanceTaecel = await this.getTaecelBalance();
            console.log(`   💰 Balance TAECEL: $${balanceTaecel}`);
        } catch (error) {
            console.error('   ❌ Error consultando saldo TAECEL:', error.message);
            balanceTaecel = 0;
        }

        try {
            // Obtener saldo MST
            console.log('   💰 Consultando saldo MST...');
            balanceMst = await this.getMstBalance();
            console.log(`   💰 Balance MST: $${balanceMst}`);
        } catch (error) {
            console.error('   ❌ Error consultando saldo MST:', error.message);
            balanceMst = 0;
        }

        // Ordenar por mayor saldo
        const providers = [
            { name: 'TAECEL', balance: balanceTaecel },
            { name: 'MST', balance: balanceMst }
        ];

        // Filtrar solo los que tienen saldo > 100
        const validProviders = providers.filter(p => p.balance > 100);

        // Ordenar por saldo descendente
        validProviders.sort((a, b) => b.balance - a.balance);

        if (validProviders.length === 0) {
            throw new Error(`No hay proveedores con saldo suficiente (>$100). TAECEL: $${balanceTaecel}, MST: $${balanceMst}`);
        }

        console.log(`   🏆 Proveedor con más saldo: ${validProviders[0].name} ($${validProviders[0].balance})`);
        return validProviders;
    }

    async getTaecelBalance() {
        // Reutilizar la misma lógica de GPS para obtener balance TAECEL
        const json_taecel = {
            key: config.TAECEL.key,
            nip: config.TAECEL.nip
        };

        const config_taecel = {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'Mozilla/5.0 (compatible; Recargas-System/1.0)'
            },
            timeout: 30000,
            validateStatus: function (status) {
                return status < 500; // No lanzar error para códigos < 500
            }
        };

        try {
            const response = await axios.post(
                `${config.TAECEL.url}/getBalance`,
                json_taecel,
                config_taecel
            );

            if (response.status === 403) {
                throw new Error(`Acceso denegado - Verificar credenciales TAECEL (KEY/NIP)`);
            }

            if (response.status !== 200) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            // Verificar estructura de respuesta
            if (!response.data) {
                throw new Error("Respuesta vacía de TAECEL");
            }

            if (!response.data.success) {
                throw new Error(`API Error: ${response.data.message || 'Error desconocido'}`);
            }

            // Reutilizar la misma lógica exitosa de GPS
            if (response.data && response.data.data) {
                const tiempoAire = response.data.data.find(item => item.Bolsa === "Tiempo Aire");
                if (tiempoAire) {
                    const saldo = tiempoAire.Saldo.replace(/,/g, "");
                    return parseFloat(saldo);
                }
            }

            throw new Error("No se encontró el saldo de Tiempo Aire en la respuesta");
        } catch (error) {
            if (axios.isAxiosError(error)) {
                if (error.code === 'ECONNABORTED') {
                    throw new Error('Timeout conectando con TAECEL');
                }
                if (error.response) {
                    throw new Error(`HTTP ${error.response.status}: ${error.response.statusText}`);
                }
                if (error.request) {
                    throw new Error('No se pudo conectar con TAECEL');
                }
            }
            throw error;
        }
    }

    async getMstBalance() {
        const url = process.env.MST_URL || "https://www.ventatelcel.com/ws/index.php?wsdl";
        const username = process.env.MST_USER;
        const password = process.env.MST_PASSWORD;

        const xmlSaldo = `
            <soapenv:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ws="http://recargas.red/ws/">
            <soapenv:Header/>
            <soapenv:Body>
                <ws:ObtenSaldo soapenv:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
                    <cadena xsi:type="xsd:string"><Recarga><Usuario>${username}</Usuario><Passwd>${password}</Passwd></Recarga></cadena>
                </ws:ObtenSaldo>
            </soapenv:Body>
            </soapenv:Envelope>`;

        const headersSoapRequest = {
            "Content-Type": "text/xml;charset=UTF-8",
            soapAction: "https://ventatelcel.com/ws/index.php/ObtenSaldo",
        };

        const { response } = await soapRequest({
            url: url,
            headers: headersSoapRequest,
            xml: xmlSaldo,
            timeout: 300000,
        });

        const { body, statusCode } = response;

        if (statusCode === 200) {
            const jsonResultado = await xml2js.parseStringPromise(body, { mergeAttrs: true });
            const jsonReturn1 = jsonResultado["SOAP-ENV:Envelope"]["SOAP-ENV:Body"][0]["ns1:ObtenSaldoResponse"][0]["return1"][0]["_"];
            const saldoTmp = await xml2js.parseStringPromise(jsonReturn1, { mergeAttrs: true });
            return saldoTmp.Recarga.Resultado[0].Saldo[0] * 1;
        }

        throw new Error(`MST saldo request failed with status: ${statusCode}`);
    }

    async callWebservice(provider, record, paqueteConfig) {
        const moment = require('moment');

        if (provider.name === 'TAECEL') {
            return await this.callTAECEL(record, paqueteConfig);
        } else if (provider.name === 'MST') {
            return await this.callMST(record, paqueteConfig);
        }

        throw new Error(`Proveedor desconocido: ${provider.name}`);
    }

    async callTAECEL(record, paqueteConfig) {
        try {
            console.log(`   🔵 TAECEL: RequestTXN para SIM ${record.sim}, Código: ${paqueteConfig.codigo}`);

            // Paso 1: RequestTXN usando la función real de GPS
            const requestResult = await this.taecelRequestTXN(record.sim, paqueteConfig.codigo);

            if (!requestResult.success) {
                throw new Error(`RequestTXN falló: ${requestResult.error}`);
            }

            console.log(`   🔵 TAECEL: StatusTXN para TransID ${requestResult.transID}`);

            // Paso 2: StatusTXN usando la función real de GPS
            const statusResult = await this.taecelStatusTXN(requestResult.transID);

            if (!statusResult.success) {
                throw new Error(`StatusTXN falló: ${statusResult.error}`);
            }

            // Procesar respuesta exitosa (igual que en tu código original)
            const {
                TransID,
                Fecha,
                Carrier,
                Telefono,
                Folio,
                Status,
                Monto,
                Timeout,
                IP,
                "Saldo Final": SaldoFinal,
                Nota,
            } = statusResult.data;

            const montoFloat = parseFloat(Monto.replace(/[\$,]/g, ""));

            let detalle = `[ Saldo Final: ${SaldoFinal} ] Folio: ${Folio}, Cantidad: ${Monto}, Teléfono: ${Telefono}, Carrier: ${Carrier}, Fecha: ${Fecha}, TransID: ${TransID}, Timeout: ${Timeout}, IP: ${IP}`;
            if (Nota && Nota !== "") {
                detalle += `, Nota: ${Nota}`;
            }

            return {
                success: true,
                transID: TransID,
                response: {
                    transId: TransID,
                    monto: montoFloat,
                    folio: Folio,
                    saldoFinal: SaldoFinal,
                    carrier: Carrier,
                    fecha: Fecha,
                    response: { Timeout, IP },
                    nota: Nota || ""
                }
            };

        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }

    async callMST(record, paqueteConfig) {
        try {
            const url = process.env.MST_URL || "https://www.ventatelcel.com/ws/index.php?wsdl";
            const username = process.env.MST_USER;
            const password = process.env.MST_PASSWORD;
            const tipoRecarga = "Paquetes";

            console.log(`   🟡 MST: ${tipoRecarga} para SIM ${record.sim}, Código: ${record.codigo_paquete}`);

            const xml = `
                <soapenv:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ws="http://recargas.red/ws/">
                <soapenv:Header/>
                <soapenv:Body>
                    <ws:${tipoRecarga} soapenv:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
                        <cadena xsi:type="xsd:string"><Recarga><Usuario>${username}</Usuario><Passwd>${password}</Passwd><Telefono>${record.sim}</Telefono><Carrier>Telcel</Carrier><Monto>${record.codigo_paquete}</Monto></Recarga></cadena>
                    </ws:${tipoRecarga}>
                </soapenv:Body>
                </soapenv:Envelope>`;

            const headersSoapRequest = {
                "Content-Type": "text/xml;charset=UTF-8",
                soapAction: "https://ventatelcel.com/ws/index.php/" + tipoRecarga,
            };

            const { response } = await soapRequest({
                url: url,
                headers: headersSoapRequest,
                xml: xml,
                timeout: 30000,
            });

            const { body, statusCode } = response;

            if (statusCode !== 200) {
                throw new Error(`MST response status code: ${statusCode}`);
            }

            const json = await xml2js.parseStringPromise(body, { mergeAttrs: true });
            const respuestaSoap = json["SOAP-ENV:Envelope"]["SOAP-ENV:Body"][0]["ns1:" + tipoRecarga + "Response"][0]["resultado"][0]["_"];
            const resultado = await xml2js.parseStringPromise(respuestaSoap, { mergeAttrs: true });
            const mensaje = resultado["Recarga"]["Resultado"][0];

            // Si hay un error
            if (typeof mensaje["Error"] !== "undefined") {
                throw new Error(mensaje["Error"][0]);
            }

            // Si todo está bien
            if (typeof mensaje["Folio"][0] !== "undefined") {
                const cantidad = mensaje["Cantidad"][0] * 1;
                const carrier = mensaje["Carrier"][0];
                const folio = mensaje["Folio"][0];
                const telefono = mensaje["Telefono"][0];

                const detalle = `Folio: ${folio}, Cantidad: ${cantidad}, Teléfono: ${telefono}, Carrier: ${carrier}`;

                return {
                    success: true,
                    transID: folio,
                    response: {
                        transId: folio,
                        monto: cantidad,
                        folio: folio,
                        saldoFinal: "N/A",
                        carrier: carrier,
                        fecha: moment().format("YYYY-MM-DD")
                    }
                };
            }

            throw new Error("Respuesta MST inválida: no se encontró Folio");

        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }

    // Funciones TAECEL reutilizadas de GPS (exactamente iguales)
    async taecelRequestTXN(sim, producto) {
        const json_taecel = {
            key: config.TAECEL.key,
            nip: config.TAECEL.nip,
            producto: producto,
            referencia: sim
        };

        const config_taecel = {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            timeout: 30000
        };

        const response = await axios.post(
            `${config.TAECEL.url}/RequestTXN`,
            json_taecel,
            config_taecel
        );

        if (response.data && response.data.success) {
            return {
                success: true,
                transID: response.data.data.transID
            };
        }

        return {
            success: false,
            error: response.data ? response.data.message : 'Error desconocido en RequestTXN'
        };
    }

    async taecelStatusTXN(transID) {
        const json_taecel = {
            key: config.TAECEL.key,
            nip: config.TAECEL.nip,
            transID: transID
        };

        const config_taecel = {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            timeout: 30000
        };

        const response = await axios.post(
            `${config.TAECEL.url}/StatusTXN`,
            json_taecel,
            config_taecel
        );

        if (response.data && response.data.success) {
            return {
                success: true,
                data: response.data.data
            };
        }

        return {
            success: false,
            error: response.data ? response.data.message : 'Error desconocido en StatusTXN',
            data: response.data ? response.data.data : null
        };
    }

    // Método de recovery para cola auxiliar VOZ (igual que GPS)
    async processAuxiliaryQueueRecharges() {
        const stats = { processed: 0, failed: 0 };

        try {
            // Usar la cola auxiliar específica de VOZ
            const auxiliaryQueue = this.persistenceQueue.auxiliaryQueue;
            
            if (!auxiliaryQueue || auxiliaryQueue.length === 0) {
                console.log('   📋 Cola auxiliar VOZ vacía');
                return stats;
            }

            const pendingRecharges = auxiliaryQueue.filter(item =>
                item.tipo === 'voz_recharge' &&
                (item.status === 'webservice_success_pending_db' ||
                 item.status === 'db_insertion_failed_pending_recovery')
            );

            console.log(`   🔄 Procesando ${pendingRecharges.length} recargas VOZ pendientes...`);

            for (const recharge of pendingRecharges) {
                try {
                    await this.processCompletePendingVozRecharge(recharge);
                    stats.processed++;
                    console.log(`   ✅ Recarga VOZ ${recharge.sim} procesada exitosamente`);
                } catch (error) {
                    stats.failed++;
                    console.error(`   ❌ Error procesando recarga VOZ ${recharge.sim}:`, error.message);
                }
            }

            // Limpiar recargas procesadas exitosamente usando el sistema de persistencia
            const processedSims = new Set();
            
            for (const recharge of pendingRecharges) {
                if (stats.processed > 0) { // Solo si hubo éxitos
                    processedSims.add(recharge.sim);
                }
            }
            
            // Filtrar elementos procesados exitosamente de la cola
            this.persistenceQueue.auxiliaryQueue = this.persistenceQueue.auxiliaryQueue.filter(item => {
                if (item.tipo === 'voz_recharge' && processedSims.has(item.sim)) {
                    return false; // Remover exitosos
                }
                return true; // Mantener los demás
            });
            
            // Guardar la cola actualizada
            await this.persistenceQueue.saveAuxiliaryQueue();

        } catch (error) {
            console.error('   ❌ Error procesando cola auxiliar VOZ:', error.message);
            stats.failed++;
        }

        return stats;
    }

    async processCompletePendingVozRecharge(recharge) {
        let transaction = null;
        
        try {
            transaction = await this.db.getSequelizeClient().transaction();
            
            // Insertar en tabla recargas (maestro) - campos correctos según estructura real
            const insertSql = `
                INSERT INTO recargas (fecha, tipo, total, notas, quien, proveedor)
                VALUES (UNIX_TIMESTAMP(), 'paquete', ?, ?, 'SISTEMA_VOZ', ?)
            `;
            
            const nota = `Recarga VOZ SIM ${recharge.sim} - Paquete ${recharge.codigoPaquete} (${recharge.codigoPSL}) - ${recharge.diasVigencia} días - $${recharge.monto}`;
            
            const [results] = await this.db.querySequelize(insertSql, {
                replacements: [recharge.monto, nota, recharge.proveedor],
                type: this.db.getSequelizeClient().QueryTypes.INSERT,
                transaction
            });
            
            const idRecarga = results;
            
            // Insertar en tabla detalle_recargas (con campo importe que sí existe)
            const detalleSql = `
                INSERT INTO detalle_recargas (id_recarga, sim, importe, dispositivo, vehiculo, detalle, folio, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `;
            
            const detalleText = `Recarga VOZ - Paquete ${recharge.codigoPaquete} (${recharge.codigoPSL}) - $${recharge.monto} - ${recharge.diasVigencia} días - Provider: ${recharge.proveedor}`;
            
            await this.db.querySequelize(detalleSql, {
                replacements: [
                    idRecarga,
                    recharge.sim,
                    recharge.monto, // importe
                    '', // No hay dispositivo en VOZ
                    recharge.vehiculo || `VOZ-${recharge.sim}`,
                    detalleText,
                    recharge.webserviceResponse?.transId || null,
                    1 // Status: exitosa
                ],
                type: this.db.getSequelizeClient().QueryTypes.INSERT,
                transaction
            });
            
            // Actualizar fecha_expira_saldo en prepagos_automaticos (+diasVigencia días)
            const updateSql = `
                UPDATE prepagos_automaticos 
                SET fecha_expira_saldo = DATE_ADD(NOW(), INTERVAL ? DAY)
                WHERE sim = ?
            `;
            
            await this.db.querySequelize(updateSql, {
                replacements: [recharge.diasVigencia, recharge.sim],
                type: this.db.getSequelizeClient().QueryTypes.UPDATE,
                transaction
            });
            
            await transaction.commit();
            console.log(`   ✅ VOZ ${recharge.sim} insertado en BD (+${recharge.diasVigencia} días)`);
            
        } catch (error) {
            if (transaction) await transaction.rollback();
            throw error;
        }
    }
}

module.exports = { VozRechargeProcessor };
