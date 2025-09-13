require('dotenv').config();

module.exports = {
    GPS_DB: {
        host: process.env.GPS_DB_HOST || 'localhost',
        user: process.env.GPS_DB_USER || 'root',
        password: process.env.GPS_DB_PASSWORD,
        database: process.env.GPS_DB_NAME || 'gps_db'
    },
    ELIOT_DB: {
        host: process.env.ELIOT_DB_HOST || 'localhost',
        user: process.env.ELIOT_DB_USER || 'root',
        password: process.env.ELIOT_DB_PASSWORD,
        database: process.env.ELIOT_DB_NAME || 'eliot_db'
    },
    REDIS: {
        host: process.env.REDIS_HOST || '10.8.0.1',
        port: parseInt(process.env.REDIS_PORT) || 6379
    },
    MONGODB: {
        url: process.env.MONGODB_URL || 'mongodb://localhost:27017/metrics'
    },
    // Configuración de proveedores
    TAECEL: {
        url: process.env.TAECEL_URL || "https://taecel.com/app/api",
        key: process.env.TAECEL_KEY,
        nip: process.env.TAECEL_NIP
    },
    MST: {
        url: process.env.MST_URL || "https://www.ventatelcel.com/ws/index.php?wsdl",
        usuario: process.env.MST_USER,
        clave: process.env.MST_PASSWORD
    }
};
