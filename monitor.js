const orchestrator = require('./index');

async function monitor() {
    console.clear();
    console.log('📊 MONITOR DE SISTEMA - RECARGAS v2.0');
    console.log('=====================================\n');
    
    const status = await orchestrator.getStatus();
    
    console.log('Presiona Ctrl+C para salir\n');
    
    // Actualizar cada 5 segundos
    setInterval(async () => {
        console.clear();
        console.log('📊 MONITOR DE SISTEMA - RECARGAS v2.0');
        console.log('=====================================\n');
        
        const newStatus = await orchestrator.getStatus();
        console.log(`\nÚltima actualización: ${new Date().toLocaleString()}`);
    }, 5000);
}

monitor();
