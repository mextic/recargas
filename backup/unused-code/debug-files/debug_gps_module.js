// Script simple para debuggear GPSRechargeProcessor
console.log('🔍 Debugging GPSRechargeProcessor...');

try {
    // Intentar cargar el módulo
    console.log('📦 Cargando módulo...');
    const moduleExports = require('./lib/processors/GPSRechargeProcessor');
    console.log('✅ Módulo cargado exitosamente');
    console.log('🔑 Exports keys:', Object.keys(moduleExports));

    // Verificar la clase
    const { GPSRechargeProcessor } = moduleExports;
    console.log('🏭 Clase GPS encontrada:', !!GPSRechargeProcessor);

    // Verificar el prototype
    console.log('🔧 Prototype methods:');
    const prototypeMethods = Object.getOwnPropertyNames(GPSRechargeProcessor.prototype);
    prototypeMethods.forEach(method => {
        console.log(`   - ${method}: ${typeof GPSRechargeProcessor.prototype[method]}`);
    });

    // Buscar específicamente el método
    const hasMethod = prototypeMethods.includes('insertBatchRechargesWithDuplicateHandling');
    console.log(`🎯 insertBatchRechargesWithDuplicateHandling found: ${hasMethod}`);

    if (hasMethod) {
        console.log('✅ Method exists in prototype!');
    } else {
        console.log('❌ Method NOT found in prototype!');
        console.log('🔍 Similar methods:');
        prototypeMethods.filter(m => m.includes('insert')).forEach(method => {
            console.log(`   - ${method}`);
        });
    }

} catch (error) {
    console.error('❌ Error loading module:', error.message);
    console.error('📍 Stack:', error.stack);
}