// Script para probar la lógica GPS corregida
const moment = require('moment-timezone');

console.log('🧪 PRUEBA DE LÓGICA GPS CORREGIDA');
console.log('=================================');

// Configuración de zona horaria
const timezone = 'America/Mazatlan';
const now = moment.tz(timezone);

console.log(`📅 Fecha/Hora actual: ${now.format('YYYY-MM-DD HH:mm:ss')} (${timezone})`);
console.log(`⏰ Unix timestamp actual: ${now.unix()}`);

// Definir timestamps para pruebas
const ahora = Math.floor(Date.now() / 1000);
const fin_dia_hoy = moment.tz(timezone).endOf("day").unix();

console.log(`\n🔍 TIMESTAMPS DE REFERENCIA:`);
console.log(`   Ahora: ${ahora} (${moment.unix(ahora).tz(timezone).format('YYYY-MM-DD HH:mm:ss')})`);
console.log(`   Fin día hoy: ${fin_dia_hoy} (${moment.unix(fin_dia_hoy).tz(timezone).format('YYYY-MM-DD HH:mm:ss')})`);

// Casos de prueba para unix_saldo
const testCases = [
    // Caso 1: unix_saldo NULL
    {
        nombre: "Dispositivo sin fecha",
        unix_saldo: null,
        minutos_sin_reportar: 15,
        dias_sin_reportar: 2,
        esperado: "IGNORAR - sin fecha"
    },

    // Caso 2: Saldo ya vencido, reportando recientemente
    {
        nombre: "Vencido pero reportando",
        unix_saldo: ahora - 3600, // Hace 1 hora
        minutos_sin_reportar: 5,
        dias_sin_reportar: 1,
        esperado: "PERÍODO DE GRACIA - optimizando inversión"
    },

    // Caso 3: Saldo ya vencido, sin reportar por mucho tiempo
    {
        nombre: "Vencido y sin reportar",
        unix_saldo: ahora - 3600, // Hace 1 hora
        minutos_sin_reportar: 15,
        dias_sin_reportar: 2,
        esperado: "RECARGAR - vencido y sin reportar"
    },

    // Caso 4: Vence hoy, reportando recientemente
    {
        nombre: "Vence hoy pero reportando",
        unix_saldo: fin_dia_hoy - 1800, // Vence hoy
        minutos_sin_reportar: 3,
        dias_sin_reportar: 0.5,
        esperado: "PERÍODO DE GRACIA - vence hoy pero reportando"
    },

    // Caso 5: Vence hoy, sin reportar
    {
        nombre: "Vence hoy y sin reportar",
        unix_saldo: fin_dia_hoy - 1800, // Vence hoy
        minutos_sin_reportar: 15,
        dias_sin_reportar: 1,
        esperado: "RECARGAR - vence hoy y sin reportar"
    },

    // Caso 6: Dispositivo inactivo (muchos días sin reportar)
    {
        nombre: "Dispositivo abandonado",
        unix_saldo: ahora - 7200, // Vencido hace 2 horas
        minutos_sin_reportar: 180,
        dias_sin_reportar: 20, // Más de 14 días
        esperado: "IGNORAR - dispositivo inactivo"
    },

    // Caso 7: Vigente y reportando
    {
        nombre: "Vigente y activo",
        unix_saldo: fin_dia_hoy + 86400, // Vence mañana
        minutos_sin_reportar: 2,
        dias_sin_reportar: 0.1,
        esperado: "ESTABLE - vigente y reportando"
    }
];

console.log(`\n🔬 ANÁLISIS DE CASOS DE PRUEBA:`);
console.log('==========================================');

const GPS_MINUTOS_SIN_REPORTAR = 10;
const GPS_DIAS_SIN_REPORTAR = 14;

testCases.forEach((caso, index) => {
    console.log(`\n${index + 1}. ${caso.nombre}:`);

    // Validación unix_saldo NULL
    if (!caso.unix_saldo || caso.unix_saldo === null) {
        console.log(`   ❌ unix_saldo NULL → ${caso.esperado}`);
        return;
    }

    const unix_saldo = parseInt(caso.unix_saldo);

    // Clasificar estado del saldo
    const estaVencido = unix_saldo < ahora;
    const vencePorVencer = unix_saldo >= ahora && unix_saldo <= fin_dia_hoy;
    const esVigente = unix_saldo > fin_dia_hoy;

    let estadoSaldo;
    if (estaVencido) estadoSaldo = 'vencido';
    else if (vencePorVencer) estadoSaldo = 'por_vencer';
    else estadoSaldo = 'vigente';

    console.log(`   📅 Estado saldo: ${estadoSaldo}`);
    console.log(`   ⏱️  Minutos sin reportar: ${caso.minutos_sin_reportar}`);
    console.log(`   📊 Días sin reportar: ${caso.dias_sin_reportar}`);

    // Aplicar lógica corregida
    let decision;

    if (esVigente) {
        decision = "ESTABLE - vigente y reportando";
    } else if (estaVencido || vencePorVencer) {
        // Verificar si dispositivo está activo
        if (caso.dias_sin_reportar < GPS_DIAS_SIN_REPORTAR) {
            // Dispositivo activo - evaluar minutos
            if (caso.minutos_sin_reportar >= GPS_MINUTOS_SIN_REPORTAR) {
                decision = "RECARGAR - necesita recarga inmediata";
            } else {
                decision = "PERÍODO DE GRACIA - optimizando inversión";
            }
        } else {
            decision = "IGNORAR - dispositivo inactivo";
        }
    }

    console.log(`   🎯 Decisión: ${decision}`);
    console.log(`   ✅ Esperado: ${caso.esperado}`);

    const esCorrecta = decision.includes(caso.esperado.split(' - ')[0]);
    console.log(`   ${esCorrecta ? '✅' : '❌'} ${esCorrecta ? 'CORRECTO' : 'ERROR EN LÓGICA'}`);
});

console.log(`\n🎯 RESUMEN DE LA LÓGICA CORREGIDA:`);
console.log('===================================');
console.log('✅ unix_saldo NULL → IGNORAR (no procesar)');
console.log('✅ Más de 14 días sin reportar → IGNORAR (inactivo)');
console.log('✅ Vencido/Por vencer + <10min sin reportar → PERÍODO DE GRACIA');
console.log('✅ Vencido/Por vencer + >10min sin reportar + <14 días → RECARGAR');
console.log('✅ Vigente → ESTABLE (no necesita recarga)');

console.log(`\n💰 OPTIMIZACIÓN DE INVERSIÓN:`);
console.log('============================');
console.log('• Período de gracia aprovecha transmisión ocasional de Telcel sin saldo');
console.log('• No se recarga dispositivos inactivos (ahorro significativo)');
console.log('• Recarga preventiva solo cuando realmente se necesita');
console.log('• Validación estricta de fechas evita errores de procesamiento');