const { mongoose } = require("../database/mongoClient");

// Definir el esquema de Métrica
const metricaSchema = new mongoose.Schema({
  uuid: { type: String, required: true },
  fecha: { type: Number, required: true },
  offline: { type: Number, default: 0 },
  descripcion_agente: { type: String },
  fecha_formato: { type: Date },
  alarmas: { type: mongoose.Schema.Types.Mixed },
  gps: { type: mongoose.Schema.Types.Mixed },
  tab: { type: mongoose.Schema.Types.Mixed },
  punto_calculado: { type: mongoose.Schema.Types.Mixed },
  uuid_paquete: { type: String },
  appid: { type: String },
  bat: { type: Number },
  senial: { type: Number },
  payload: { type: mongoose.Schema.Types.Mixed },
  parametros: [{ type: mongoose.Schema.Types.Mixed }]
}, {
  collection: 'metricas',
  timestamps: false
});

// Verificar si el modelo ya ha sido compilado, si no, crearlo
const Metrica = mongoose.models.Metrica || mongoose.model('Metrica', metricaSchema);

// Función para consultar métrica más reciente por UUID
async function consultarMetricaPorUuid(uuid) {
  try {
    const resultado = await Metrica.findOne({ uuid: uuid })
      .sort({ fecha: -1 })
      .exec();

    console.log(`   📊 Consulta métrica UUID ${uuid}:`, resultado ? `última fecha ${resultado.fecha}` : 'sin datos');
    return resultado;
  } catch (error) {
    console.error(`   ❌ Error en consulta métrica UUID ${uuid}:`, error);
    throw error;
  }
}

// Función para verificar y crear los índices si no existen
async function ensureIndexMetricas() {
  try {
    // Verificar si la colección ya existe
    const count = await Metrica.estimatedDocumentCount();
    if (count === 0) {
      console.log("   🔧 Colección 'metricas' vacía. Insertando documento inicial.");
      await Metrica.create({
        uuid: "dummy",
        fecha: 0,
        offline: 0,
        parametros: [],
        descripcion_agente: "dummy",
      });
      console.log("   ✅ Documento inicial insertado en métricas.");
    }

    // Obtener índices existentes
    const indexes = await Metrica.collection.indexes();

    // Verificar índice uuid_1_fecha_-1
    const uuidFechaIndexExists = indexes.some(
      (index) => index.name === "uuid_1_fecha_-1"
    );

    // Verificar índice fecha_-1
    const fechaIndexExists = indexes.some(
      (index) => index.name === "fecha_-1"
    );

    // Crear índice uuid_1_fecha_-1 si no existe
    if (!uuidFechaIndexExists) {
      console.log("   🔧 Índice uuid_1_fecha_-1 no existe. Creando índice...");
      await Metrica.collection.createIndex(
        { uuid: 1, fecha: -1 },
        {
          background: true,
          name: "uuid_1_fecha_-1",
        }
      );
      console.log("   ✅ Índice uuid_1_fecha_-1 creado correctamente.");
    } else {
      console.log("   ✅ Índice uuid_1_fecha_-1 ya existe.");
    }

    // Crear índice fecha_-1 si no existe
    if (!fechaIndexExists) {
      console.log("   🔧 Índice fecha_-1 no existe. Creando índice...");
      await Metrica.collection.createIndex(
        { fecha: -1 },
        {
          background: true,
          name: "fecha_-1",
        }
      );
      console.log("   ✅ Índice fecha_-1 creado correctamente.");
    } else {
      console.log("   ✅ Índice fecha_-1 ya existe.");
    }

    console.log('✅ Verificación de índices de métricas completada correctamente');
  } catch (error) {
    console.error('❌ Error asegurando índices de métricas:', error);
  }
}

module.exports = {
  Metrica,
  consultarMetricaPorUuid,
  ensureIndexMetricas
};