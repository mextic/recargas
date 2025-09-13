const mongoose = require('mongoose');

let isConnected = false;

async function connectMongoDB() {
    if (isConnected) {
        return;
    }

    try {
        const mongoUrl = process.env.MONGODB_URL || 'mongodb://localhost:27017/metrics';
        await mongoose.connect(mongoUrl);
        isConnected = true;
        console.log('✅ Conectado a MongoDB para métricas');
    } catch (error) {
        console.error('❌ Error conectando a MongoDB:', error);
        throw error;
    }
}

async function disconnectMongoDB() {
    if (isConnected) {
        await mongoose.disconnect();
        isConnected = false;
        console.log('🔌 Desconectado de MongoDB');
    }
}

module.exports = {
    mongoose,
    connectMongoDB,
    disconnectMongoDB
};