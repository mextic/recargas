#!/usr/bin/env node

/**
 * Test directo de animaciones de progreso
 * Simula el procesamiento de dispositivos GPS, VOZ y ELIoT
 */

const { ProgressFactory } = require('./lib/utils/progressBar');

async function testProgressAnimations() {
    console.log('🚀 Probando animaciones de barras de progreso\n');

    // Test GPS
    console.log('🟢 GPS: Simulando procesamiento de dispositivos...');
    const gpsBar = ProgressFactory.createServiceProgressBar('GPS', 10, 'Procesando dispositivos GPS');

    for (let i = 0; i < 10; i++) {
        gpsBar.update(i, `🔍 GPS ${6681625000 + i} - Dispositivo ${i + 1}`);
        await sleep(800); // Simular tiempo de procesamiento
    }
    gpsBar.complete('✅ GPS Completado: 10 exitosos, 0 errores en 8s');

    await sleep(1000);

    // Test VOZ
    console.log('\n🔵 VOZ: Simulando procesamiento de paquetes...');
    const vozBar = ProgressFactory.createServiceProgressBar('VOZ', 5, 'Procesando paquetes VOZ');

    for (let i = 0; i < 5; i++) {
        vozBar.update(i, `📱 Procesando SIM ${5534567000 + i} - Paquete ${i + 1}`);
        await sleep(1200); // VOZ es más lento
    }
    vozBar.complete('✅ VOZ Completado: 5 exitosos, 0 errores en 6s');

    await sleep(1000);

    // Test ELIoT
    console.log('\n🟡 ELIoT: Simulando procesamiento de dispositivos IoT...');
    const eliotBar = ProgressFactory.createServiceProgressBar('ELIOT', 7, 'Procesando dispositivos ELIoT');

    for (let i = 0; i < 7; i++) {
        eliotBar.update(i, `🌐 ELIoT IOT_DEVICE_${String(i + 1).padStart(3, '0')} - Dispositivo ${i + 1}`);
        await sleep(600); // ELIoT intermedio
    }
    eliotBar.complete('✅ ELIoT Completado: 7 exitosos, 0 errores en 4s');

    console.log('\n✅ Test de animaciones completado exitosamente!');
    console.log('\n🎯 Características probadas:');
    console.log('  • Barras de progreso con colores distintivos por servicio');
    console.log('  • ETA calculado dinámicamente');
    console.log('  • Velocidad de procesamiento (items/min)');
    console.log('  • Hora estimada de finalización');
    console.log('  • Mensaje descriptivo del dispositivo actual');
    console.log('  • Resumen final con estadísticas');
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Ejecutar test
testProgressAnimations().catch(console.error);