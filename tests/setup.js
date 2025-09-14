// Test setup global configuration
require('dotenv').config();

// Mock environment variables para testing
process.env.NODE_ENV = 'test';
process.env.MONGODB_URL = 'mongodb://localhost:27017/test_metrics';
process.env.REDIS_HOST = 'localhost';
process.env.REDIS_PORT = '6379';
process.env.GPS_DB_PASSWORD = 'test_password';
process.env.ELIOT_DB_PASSWORD = 'test_password';

// Global test timeout
jest.setTimeout(30000);

// Setup and teardown hooks globales
beforeEach(() => {
    // Limpiar console mocks
    jest.clearAllMocks();
});

afterEach(() => {
    // Cleanup después de cada test
});

// Suprimir logs durante testing a menos que se específique
if (!process.env.TEST_VERBOSE) {
    console.log = jest.fn();
    console.error = jest.fn();
    console.warn = jest.fn();
}