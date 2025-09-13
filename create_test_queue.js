#!/usr/bin/env node

// Script para crear cola auxiliar universal de prueba con 43 transacciones GPS
const fs = require('fs').promises;
const path = require('path');

async function createTestQueue() {
    console.log('🧪 Creando cola auxiliar universal de prueba...');
    
    // Datos originales de las 43 transacciones GPS exitosas
    const transacciones = [
        { sim: "6681997068", vehiculo: "0212 - 01AK1C", empresa: "TRANSPORTES SURI, S.A. DE C.V. (ALSUA)", transID: "250900833181" },
        { sim: "6681639717", vehiculo: "135 SUBURBAN", empresa: "EQUIPOS Y PRODUCTOS QUÍMICOS DEL NOROESTE S.A. DE C.V.", transID: "250900833184" },
        { sim: "6681640928", vehiculo: "8012 - 73BB1F", empresa: "TRANSPORTES SURI, S.A. DE C.V. (ALSUA)", transID: "250900833190" },
        { sim: "6682253288", vehiculo: "8512 - 62AN7E", empresa: "TRANSPORTES SURI, S.A. DE C.V. (ALSUA)", transID: "250900833194" },
        { sim: "6681304219", vehiculo: "A02", empresa: "IBARRA FLORES HECTOR EMANUEL - (FUMIGACIONES IBARRA)", transID: "250900833202" },
        { sim: "6681644182", vehiculo: "AU-030", empresa: "CONSTRUCTORA GUSA SA DE CV (LOS MOCHIS MENSUAL)", transID: "250900833204" },
        { sim: "6681246880", vehiculo: "AU-070", empresa: "CONSTRUCTORA GUSA SA DE CV (MAZATLAN)", transID: "250900833206" },
        { sim: "6681639973", vehiculo: "CA-074", empresa: "CONSTRUCTORA GUSA SA DE CV (LOS MOCHIS MENSUAL)", transID: "250900833207" },
        { sim: "6681639608", vehiculo: "CA-083", empresa: "CONSTRUCTORA GUSA SA DE CV (LOS CABOS MENSUAL)", transID: "250900833210" },
        { sim: "6681644038", vehiculo: "CA-123", empresa: "CONSTRUCTORA GUSA SA DE CV (LOS MOCHIS MENSUAL)", transID: "250900833213" },
        { sim: "6684634784", vehiculo: "CAJA CH-02", empresa: "ESBEYDI AGLAE VERDUGO MORALES", transID: "250900833217" },
        { sim: "6681634491", vehiculo: "CG2", empresa: "CONSTRUCTORA GUSA SA DE CV (LOS CABOS MENSUAL)", transID: "250900833225" },
        { sim: "6681639429", vehiculo: "COMPRAS-LOGISTICA (ROBUST 2025)", empresa: "TECNO BLOCK DE LOS MOCHIS S.A. DE C.V.", transID: "250900833232" },
        { sim: "6681636926", vehiculo: "DEG-30", empresa: "DEG ENERGY", transID: "250900833236" },
        { sim: "6681506356", vehiculo: "EC-0026 INTERNTIONAL 6706/LIMPIEZA BAÑOS", empresa: "AGRÍCOLA DIANA LAURA", transID: "250900833241" },
        { sim: "6681373200", vehiculo: "F350", empresa: "ULISES ESPINOSA RODRIGUEZ", transID: "250900833244" },
        { sim: "6683231570", vehiculo: "JMB22 DAYCAB", empresa: "SERVICIO DE TRANSPORTE DE CARGA JMB SA DE CV", transID: "250900833250" },
        { sim: "6684238868", vehiculo: "KENWORTH", empresa: "LETICIA GRAILLET", transID: "250900833254" },
        { sim: "6681484315", vehiculo: "KIA RIO 1 MOCHIS", empresa: "DIESEL Y ENERGETICOS DE MEXICO (DIESEL PLUS)", transID: "250900833261" },
        { sim: "6681493181", vehiculo: "L-02 FRONTIER", empresa: "URUZ", transID: "250900833270" },
        { sim: "6681135100", vehiculo: "LP - HINO 2019 - IVAN GONZALEZ", empresa: "LOF AGRO DE GUASAVE", transID: "250900833273" },
        { sim: "6681639804", vehiculo: "MOTO CS CARLOS", empresa: "EGLAEL PEÑUELAS LOPEZ", transID: "250900833280" },
        { sim: "6681634261", vehiculo: "MOVIL 01", empresa: "ESTHER ELISA VALENZUELA LUZANILLA (MARDAN XPRESS)", transID: "250900833285" },
        { sim: "6681644178", vehiculo: "NISSAN ESTACA", empresa: "CONSTRUCTORA GUSA SA DE CV (LOS MOCHIS MENSUAL)", transID: "250900833293" },
        { sim: "6681644028", vehiculo: "NISSAN VERSA", empresa: "CONSTRUCTORA GUSA SA DE CV (LOS MOCHIS MENSUAL)", transID: "250900833294" },
        { sim: "6681644126", vehiculo: "OR-005", empresa: "CONSTRUCTORA GUSA SA DE CV (LOS MOCHIS MENSUAL)", transID: "250900833298" },
        { sim: "6681641082", vehiculo: "OR-6", empresa: "MEZTA CORPORATIVO", transID: "250900833302" },
        { sim: "6681378607", vehiculo: "PIPA 12", empresa: "MK URBANIZACIONES", transID: "250900833307" },
        { sim: "8111783121", vehiculo: "RE-064", empresa: "CONSTRUCTORA GUSA SA DE CV (LOS CABOS MENSUAL)", transID: "250900833313" },
        { sim: "6681397219", vehiculo: "SAVEIRO", empresa: "MARIO ALBERTO VERDUZCO COTA (MARVER)", transID: "250900833320" },
        { sim: "6681639476", vehiculo: "SFA - TRACTOR 6603 - OPERADOR", empresa: "SPLENDID FARMS", transID: "250900833323" },
        { sim: "6681639485", vehiculo: "SFA - TRACTOR 7610S", empresa: "SPLENDID FARMS", transID: "250900833326" },
        { sim: "6681634625", vehiculo: "SILVERADO 2023 IZAEL", empresa: "AGRÍCOLA MUGA", transID: "250900833331" },
        { sim: "8114906062", vehiculo: "TC-011", empresa: "CONSTRUCTORA GUSA SA DE CV (LOS CABOS MENSUAL)", transID: "250900833336" },
        { sim: "6681641824", vehiculo: "TCS-005 (67AM9W)", empresa: "TRANSPORTADORA CARDINAL S.A. DE C.V. (CONYMAT)", transID: "250900833340" },
        { sim: "6683967543", vehiculo: "TCS-008 (15AM9W)", empresa: "TRANSPORTADORA CARDINAL S.A. DE C.V. (CONYMAT)", transID: "250900833344" },
        { sim: "6681516275", vehiculo: "TRA 22", empresa: "TRANAPAC S.A. DE C.V. (AGROBO)", transID: "250900833350" },
        { sim: "6682520643", vehiculo: "U-364 RAM 1200", empresa: "GRANJAS AVÍCOLAS RANCHO GRANDE S.P.R DE R.L", transID: "250900833352" },
        { sim: "6681247164", vehiculo: "UD 238 HINO", empresa: "EQUIPOS Y PRODUCTOS QUÍMICOS DEL NOROESTE S.A. DE C.V.", transID: "250900833357" },
        { sim: "6682459695", vehiculo: "UNIDAD 46", empresa: "AGROPECUARIA RANCHO GRANDE", transID: "250900833360" },
        { sim: "6681685679", vehiculo: "UNIDAD 539", empresa: "MENDOZA REDONDO TRANSPORTES REFRIGERADOS Y GRÚAS S.A. DE C.V.", transID: "250900833367" },
        { sim: "6683230845", vehiculo: "V-13 LA CIMA", empresa: "LA CIMA PRODUCE, S.P.R. DE R.L.", transID: "250900833371" },
        { sim: "6681634935", vehiculo: "Y013 PANCHO RMZ", empresa: "DECISIONES INTELIGENTES EN TRANSPORTE (LUIS FRANCISCO RUIZ SOTO)", transID: "250900833372" }
    ];

    // Crear cola auxiliar con estructura universal
    const colaAuxiliar = transacciones.map((tx, index) => ({
        // ID único
        id: `aux_${Date.now() + index}_${Math.random().toString(36).substr(2, 5)}`,
        
        // Datos del dispositivo
        sim: tx.sim,
        vehiculo: tx.vehiculo,
        empresa: tx.empresa,
        
        // Datos de la transacción
        transID: tx.transID,
        proveedor: "TAECEL",
        provider: "TAECEL",
        
        // ESTRUCTURA UNIVERSAL - NUEVOS CAMPOS
        tipo: "gps_recharge",           // Tipo específico de recarga
        tipoServicio: "GPS",            // Servicio (GPS/VOZ/ELIOT)
        monto: 10,                      // Monto de la recarga
        diasVigencia: 8,                // Días de vigencia a agregar
        
        // Respuesta del webservice
        webserviceResponse: {
            transId: tx.transID,
            monto: 10,
            folio: tx.transID,
            saldoFinal: "N/A",
            carrier: "TELCEL",
            fecha: "2025-09-12"
        },
        
        // Control de estado
        status: "webservice_success_pending_db",
        timestamp: Date.now() + index,
        addedAt: Date.now() + index
    }));

    // Escribir cola auxiliar
    const queuePath = path.join(__dirname, 'data/auxiliary_queue.json');
    await fs.writeFile(queuePath, JSON.stringify(colaAuxiliar, null, 2));
    
    console.log(`✅ Cola auxiliar universal creada con ${colaAuxiliar.length} transacciones GPS`);
    console.log('📝 Nuevos campos universales agregados:');
    console.log('   - tipoServicio: "GPS"');
    console.log('   - diasVigencia: 8');
    console.log('   - tipo: "gps_recharge"');
    console.log('');
    console.log('🧪 Lista para testing del sistema universal');
}

// Ejecutar si se llama directamente
if (require.main === module) {
    createTestQueue();
}

module.exports = { createTestQueue };