#!/bin/bash

# ========================================
# GENERADOR DE CERTIFICADOS SSL DASHBOARD
# ========================================

CERTS_DIR="./certs"
DAYS=365
COUNTRY="MX"
STATE="Sinaloa"
CITY="Culiacan"
ORG="Sistema Recargas"
CN="localhost"

echo "🔒 Generando certificados SSL para Dashboard..."

# Crear directorio de certificados
if [ ! -d "$CERTS_DIR" ]; then
    mkdir -p "$CERTS_DIR"
    echo "📁 Directorio $CERTS_DIR creado"
fi

# Generar certificado para development (self-signed)
echo "🛠️ Generando certificado self-signed..."
openssl req -x509 -newkey rsa:4096 \
    -keyout "$CERTS_DIR/dashboard-key.pem" \
    -out "$CERTS_DIR/dashboard-cert.pem" \
    -days $DAYS -nodes \
    -subj "/C=$COUNTRY/ST=$STATE/L=$CITY/O=$ORG/CN=$CN"

# Verificar que se crearon los archivos
if [ -f "$CERTS_DIR/dashboard-key.pem" ] && [ -f "$CERTS_DIR/dashboard-cert.pem" ]; then
    echo "✅ Certificados generados exitosamente:"
    echo "   🔑 Key: $CERTS_DIR/dashboard-key.pem"
    echo "   📜 Cert: $CERTS_DIR/dashboard-cert.pem"
    echo "   ⏰ Válido por: $DAYS días"
    echo ""
    echo "🚨 IMPORTANTE:"
    echo "   • Estos son certificados SELF-SIGNED para DESARROLLO"
    echo "   • Los navegadores mostrarán advertencia de seguridad"
    echo "   • Para producción, usar certificados de CA válida"
    echo ""
    echo "📝 Para usar SSL, configura estas variables:"
    echo "   export DASHBOARD_SSL_ENABLED=true"
    echo "   export DASHBOARD_SSL_KEY_PATH=$CERTS_DIR/dashboard-key.pem"
    echo "   export DASHBOARD_SSL_CERT_PATH=$CERTS_DIR/dashboard-cert.pem"
    echo ""
    echo "🌐 Dashboard estará disponible en: https://localhost:3000"
else
    echo "❌ Error generando certificados"
    exit 1
fi

# Generar también un certificado para IP local si se especifica
if [ ! -z "$1" ]; then
    IP="$1"
    echo ""
    echo "🌍 Generando certificado adicional para IP: $IP"

    openssl req -x509 -newkey rsa:4096 \
        -keyout "$CERTS_DIR/dashboard-ip-key.pem" \
        -out "$CERTS_DIR/dashboard-ip-cert.pem" \
        -days $DAYS -nodes \
        -subj "/C=$COUNTRY/ST=$STATE/L=$CITY/O=$ORG/CN=$IP"

    if [ -f "$CERTS_DIR/dashboard-ip-key.pem" ]; then
        echo "✅ Certificado para IP generado:"
        echo "   🌐 Dashboard disponible en: https://$IP:3000"
        echo ""
        echo "📝 Para usar este certificado:"
        echo "   export DASHBOARD_SSL_KEY_PATH=$CERTS_DIR/dashboard-ip-key.pem"
        echo "   export DASHBOARD_SSL_CERT_PATH=$CERTS_DIR/dashboard-ip-cert.pem"
    fi
fi

echo ""
echo "🔧 Ejemplo de configuración completa:"
echo "# .env"
echo "DASHBOARD_SSL_ENABLED=true"
echo "DASHBOARD_HOST=0.0.0.0"
echo "DASHBOARD_PORT=443"
echo "DASHBOARD_SSL_KEY_PATH=$CERTS_DIR/dashboard-key.pem"
echo "DASHBOARD_SSL_CERT_PATH=$CERTS_DIR/dashboard-cert.pem"