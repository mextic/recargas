// Mock webservices para testing

const mockTaecelResponse = {
    success: {
        transId: '250900894447',
        monto: 10,
        folio: '572524',
        saldoFinal: '$96,170.00',
        carrier: 'Telcel',
        fecha: '2025-09-13 15:04:46',
        response: {
            Timeout: '1.86',
            IP: '187.137.101.185'
        },
        nota: ''
    },
    error: {
        error: 'Saldo insuficiente',
        code: 'INSUFFICIENT_BALANCE'
    }
};

const mockMstResponse = {
    success: {
        TransID: 'MST123456',
        Monto: 10,
        Folio: 'MST789',
        'Saldo Final': '$1.62',
        Carrier: 'Telcel',
        Timeout: '2.1',
        IP: '192.168.1.1'
    },
    error: {
        error: 'Servicio no disponible',
        code: 'SERVICE_UNAVAILABLE'
    }
};

const mockWebserviceClient = {
    // TAECEL methods
    getTaecelBalance: jest.fn().mockResolvedValue(96170),
    rechargeGPSTaecel: jest.fn().mockResolvedValue(mockTaecelResponse.success),
    rechargeVozTaecel: jest.fn().mockResolvedValue(mockTaecelResponse.success),
    rechargeELIoTTaecel: jest.fn().mockResolvedValue(mockTaecelResponse.success),
    
    // MST methods
    getMstBalance: jest.fn().mockResolvedValue(1.62),
    rechargeGPSMst: jest.fn().mockResolvedValue(mockMstResponse.success),
    rechargeVozMst: jest.fn().mockResolvedValue(mockMstResponse.success),
    rechargeELIoTMst: jest.fn().mockResolvedValue(mockMstResponse.success),
    
    // Helper methods
    simulateError: (service, errorType = 'INSUFFICIENT_BALANCE') => {
        const errorResponse = service === 'TAECEL' ? mockTaecelResponse.error : mockMstResponse.error;
        errorResponse.code = errorType;
        
        if (service === 'TAECEL') {
            mockWebserviceClient.rechargeGPSTaecel.mockRejectedValueOnce(new Error(errorResponse.error));
            mockWebserviceClient.rechargeVozTaecel.mockRejectedValueOnce(new Error(errorResponse.error));
            mockWebserviceClient.rechargeELIoTTaecel.mockRejectedValueOnce(new Error(errorResponse.error));
        } else {
            mockWebserviceClient.rechargeGPSMst.mockRejectedValueOnce(new Error(errorResponse.error));
            mockWebserviceClient.rechargeVozMst.mockRejectedValueOnce(new Error(errorResponse.error));
            mockWebserviceClient.rechargeELIoTMst.mockRejectedValueOnce(new Error(errorResponse.error));
        }
    },
    
    resetMocks: () => {
        // Clear all mocks
        jest.clearAllMocks();
        
        // Restore default implementations
        mockWebserviceClient.getTaecelBalance = jest.fn().mockResolvedValue(96170);
        mockWebserviceClient.rechargeGPSTaecel = jest.fn().mockResolvedValue(mockTaecelResponse.success);
        mockWebserviceClient.rechargeVozTaecel = jest.fn().mockResolvedValue(mockTaecelResponse.success);
        mockWebserviceClient.rechargeELIoTTaecel = jest.fn().mockResolvedValue(mockTaecelResponse.success);
        mockWebserviceClient.getMstBalance = jest.fn().mockResolvedValue(1.62);
        mockWebserviceClient.rechargeGPSMst = jest.fn().mockResolvedValue(mockMstResponse.success);
        mockWebserviceClient.rechargeVozMst = jest.fn().mockResolvedValue(mockMstResponse.success);
        mockWebserviceClient.rechargeELIoTMst = jest.fn().mockResolvedValue(mockMstResponse.success);
    }
};

module.exports = {
    mockTaecelResponse,
    mockMstResponse,
    mockWebserviceClient
};