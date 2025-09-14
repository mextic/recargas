// Mock database connections for testing

const mockSequelizeConnection = {
    querySequelize: jest.fn(),
    getSequelizeClient: jest.fn(() => ({
        QueryTypes: {
            INSERT: 'INSERT',
            UPDATE: 'UPDATE',
            SELECT: 'SELECT'
        },
        transaction: jest.fn(() => ({
            commit: jest.fn(),
            rollback: jest.fn()
        }))
    })),
    authenticate: jest.fn().mockResolvedValue(true),
    close: jest.fn().mockResolvedValue(true)
};

const mockRedisClient = {
    set: jest.fn().mockResolvedValue('OK'),
    get: jest.fn().mockResolvedValue(null),
    del: jest.fn().mockResolvedValue(1),
    exists: jest.fn().mockResolvedValue(0),
    expire: jest.fn().mockResolvedValue(1),
    ping: jest.fn().mockResolvedValue('PONG'),
    quit: jest.fn().mockResolvedValue('OK')
};

const mockMongoConnection = {
    connect: jest.fn().mockResolvedValue(true),
    disconnect: jest.fn().mockResolvedValue(true)
};

const mockMetrica = {
    findOne: jest.fn(),
    create: jest.fn(),
    estimatedDocumentCount: jest.fn().mockResolvedValue(0),
    collection: {
        indexes: jest.fn().mockResolvedValue([]),
        createIndex: jest.fn().mockResolvedValue(true)
    }
};

module.exports = {
    mockSequelizeConnection,
    mockRedisClient,
    mockMongoConnection,
    mockMetrica,
    
    // Helper para resetear todos los mocks
    resetAllMocks: () => {
        Object.values(mockSequelizeConnection).forEach(mock => {
            if (typeof mock.mockReset === 'function') mock.mockReset();
        });
        Object.values(mockRedisClient).forEach(mock => {
            if (typeof mock.mockReset === 'function') mock.mockReset();
        });
        Object.values(mockMongoConnection).forEach(mock => {
            if (typeof mock.mockReset === 'function') mock.mockReset();
        });
        Object.values(mockMetrica).forEach(mock => {
            if (typeof mock.mockReset === 'function') mock.mockReset();
        });
    }
};