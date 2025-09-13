-- Configuración de base de datos
CREATE TABLE IF NOT EXISTS recargas_configuracion (
    id INT PRIMARY KEY AUTO_INCREMENT,
    tipo_recarga VARCHAR(20) NOT NULL,
    codigo_producto VARCHAR(20) NOT NULL,
    importe DECIMAL(10,2) NOT NULL,
    dias_vigencia INT NOT NULL,
    activo BOOLEAN DEFAULT 1,
    fecha_inicio DATE NOT NULL,
    fecha_fin DATE DEFAULT NULL,
    notas TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    INDEX idx_tipo_activo (tipo_recarga, activo)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Configuración inicial
INSERT INTO recargas_configuracion (tipo_recarga, codigo_producto, importe, dias_vigencia, fecha_inicio, notas)
VALUES ('GPS', 'TEL010', 10.00, 8, CURDATE(), 'Configuración inicial GPS - $10 por 8 días');

-- Tabla de métricas
CREATE TABLE IF NOT EXISTS recargas_metricas (
    id INT AUTO_INCREMENT PRIMARY KEY,
    process_type VARCHAR(20) NOT NULL,
    start_time TIMESTAMP NOT NULL,
    end_time TIMESTAMP NULL,
    records_processed INT DEFAULT 0,
    records_success INT DEFAULT 0,
    records_failed INT DEFAULT 0,
    total_amount DECIMAL(10,2) DEFAULT 0,
    provider VARCHAR(20),
    error_message TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    INDEX idx_metrics_type_date (process_type, start_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Tabla de locks
CREATE TABLE IF NOT EXISTS recargas_process_locks (
    id INT AUTO_INCREMENT PRIMARY KEY,
    lock_key VARCHAR(100) NOT NULL UNIQUE,
    lock_id VARCHAR(255) NOT NULL,
    pid INT,
    acquired_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NULL,
    
    INDEX idx_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Índices optimizados
CREATE INDEX IF NOT EXISTS idx_dispositivos_prepago_saldo 
ON dispositivos(prepago, unix_saldo, sim);


CREATE INDEX IF NOT EXISTS idx_prepagos_fecha_status 
ON prepagos_automaticos(fecha_expira_saldo, status, sim);

CREATE INDEX IF NOT EXISTS idx_detalle_recargas_daily 
ON detalle_recargas(sim, status, folio);
