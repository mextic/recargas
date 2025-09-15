const axios = require('axios');
const soapRequest = require('easy-soap-request');
const xml2js = require('xml2js');
const config = require('../../config/database');

/**
 * Cliente centralizado para webservices TAECEL y MST
 * Elimina duplicación de código entre procesadores
 */
class WebserviceClient {
    // ===== TAECEL METHODS =====
    
    /**
     * Obtiene balance de TAECEL
     * Código extraído de GPS/VOZ (era duplicado exacto)
     */
    static async getTaecelBalance() {
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

            // Buscar saldo de Tiempo Aire
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

    /**
     * Solicita una transacción en TAECEL (RequestTXN)
     * Código extraído de GPS/VOZ (era duplicado exacto)
     */
    static async taecelRequestTXN(sim, producto) {
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

    /**
     * Consulta estado de transacción en TAECEL (StatusTXN)
     * Código extraído de GPS/VOZ (era duplicado exacto)
     */
    static async taecelStatusTXN(transID) {
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

    /**
     * Ejecuta recarga completa en TAECEL (RequestTXN + StatusTXN)
     * Lógica extraída y unificada de GPS/VOZ
     */
    static async taecelRecharge(sim, codigoPaquete) {
        try {
            console.log(`   🔵 TAECEL: RequestTXN para SIM ${sim}, Código: ${codigoPaquete}`);

            // Paso 1: RequestTXN
            const requestResult = await this.taecelRequestTXN(sim, codigoPaquete);

            if (!requestResult.success) {
                throw new Error(`RequestTXN falló: ${requestResult.error}`);
            }

            console.log(`   🔵 TAECEL: StatusTXN para TransID ${requestResult.transID}`);

            // Paso 2: StatusTXN
            const statusResult = await this.taecelStatusTXN(requestResult.transID);

            if (!statusResult.success) {
                throw new Error(`StatusTXN falló: ${statusResult.error}`);
            }

            // Procesar respuesta exitosa
            const responseData = statusResult.data;
            
            // Log de debugging para ver estructura real (solo cuando hay problemas)
            if (!responseData.Timeout || !responseData.IP) {
                console.log('🔍 DEBUG TAECEL - Missing timeout/IP:', {
                    hasTimeout: !!responseData.Timeout,
                    hasIP: !!responseData.IP,
                    keys: Object.keys(responseData)
                });
            }
            
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
            } = responseData;

            const montoFloat = parseFloat((Monto || '0').replace(/[\\$,]/g, ""));

            // Manejar valores que pueden no existir o ser undefined
            const timeoutValue = Timeout || responseData.timeout || '0.00';
            const ipValue = IP || responseData.ip || responseData.IP_Address || '0.0.0.0';

            return {
                success: true,
                provider: 'TAECEL',
                transID: TransID,
                response: {
                    transId: TransID,
                    monto: montoFloat,
                    folio: Folio,
                    saldoFinal: SaldoFinal || 'N/A',
                    carrier: Carrier || 'Telcel',
                    fecha: Fecha || new Date().toISOString().split('T')[0],
                    response: { 
                        timeout: timeoutValue, 
                        ip: ipValue,
                        originalResponse: responseData  // Para debugging
                    },
                    nota: Nota || ""
                }
            };

        } catch (error) {
            return {
                success: false,
                provider: 'TAECEL',
                error: error.message
            };
        }
    }

    // ===== MST METHODS =====

    /**
     * Obtiene balance de MST
     * Código extraído de GPS/VOZ (similar con pequeñas diferencias)
     */
    static async getMstBalance() {
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

    /**
     * Ejecuta recarga en MST
     * Código extraído de VOZ
     */
    static async mstRecharge(sim, codigoPaquete, tipoRecarga = "Paquetes") {
        try {
            const url = process.env.MST_URL || "https://www.ventatelcel.com/ws/index.php?wsdl";
            const username = process.env.MST_USER;
            const password = process.env.MST_PASSWORD;

            console.log(`   🟡 MST: ${tipoRecarga} para SIM ${sim}, Código: ${codigoPaquete}`);

            const xml = `
                <soapenv:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ws="http://recargas.red/ws/">
                <soapenv:Header/>
                <soapenv:Body>
                    <ws:${tipoRecarga} soapenv:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
                        <cadena xsi:type="xsd:string"><Recarga><Usuario>${username}</Usuario><Passwd>${password}</Passwd><Telefono>${sim}</Telefono><Carrier>Telcel</Carrier><Monto>${codigoPaquete}</Monto></Recarga></cadena>
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

                return {
                    success: true,
                    provider: 'MST',
                    transID: folio,
                    response: {
                        transId: folio,
                        monto: cantidad,
                        folio: folio,
                        saldoFinal: "N/A",
                        carrier: carrier,
                        fecha: new Date().toISOString().split('T')[0]
                    }
                };
            }

            throw new Error("Respuesta MST inválida: no se encontró Folio");

        } catch (error) {
            return {
                success: false,
                provider: 'MST',
                error: error.message
            };
        }
    }

    // ===== MÉTODOS HELPER =====

    /**
     * Ejecuta recarga con el proveedor especificado
     */
    static async executeRecharge(provider, sim, codigoPaquete) {
        switch (provider.name) {
            case 'TAECEL':
                return await this.taecelRecharge(sim, codigoPaquete);
            case 'MST':
                return await this.mstRecharge(sim, codigoPaquete);
            default:
                throw new Error(`Proveedor desconocido: ${provider.name}`);
        }
    }
}

module.exports = { WebserviceClient };