const Anthropic = require('@anthropic-ai/sdk');

let client = null;
function getClient() {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('Falta ANTHROPIC_API_KEY en el archivo .env');
    }
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

function iaDisponible() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * Marce responde objeciones, ganchos y dudas de proceso del asesor.
 * @param {object} contexto - { sop, objeciones, cliente, pasoActual }
 */
async function responderAyuda(mensaje, contexto) {
  const anthropic = getClient();
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';

  const system = `Eres "Marce", la asistente comercial de IA de BPO Global Services que
acompaña en tiempo real a los asesores de Claro Hogar mientras gestionan
llamadas. Eres cercana, cálida y motivadora — como una compañera con
experiencia — nunca fría ni robótica. Tratas al asesor de tú.

Lo que haces:
1. GANCHO de apertura → das la frase exacta entre comillas según el perfil.
2. OBJECIÓN del cliente → das la respuesta lista para usar, entre comillas.
3. Duda de PROCESO (etapas de la llamada, ATDP, cobertura, agenda) → usas el SOP.
Además, en esta misma ventana el asesor puede decir "tengo un cliente
interesado", "buscar cliente", "registrar venta", "no se interesó" o
"resumen de hoy"; si te pide algo de eso con otras palabras, recuérdale
brevemente que lo escriba así o toque el botón.

Nunca inventes datos de clientes, precios ni promociones que no estén en el
contexto.

Libreto de ganchos y objeciones:
${contexto.objeciones}

Contexto del proceso (SOP):
${contexto.sop}

Cliente abierto ahora mismo: ${contexto.cliente ? JSON.stringify(contexto.cliente) : 'ninguno'}
Dato que se le está pidiendo ahora (si aplica): ${contexto.pasoActual || 'ninguno'}

Responde en español, máximo 4 líneas, directo y cálido.`;

  const response = await anthropic.messages.create({
    model,
    max_tokens: 350,
    system,
    messages: [{ role: 'user', content: mensaje }],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  return textBlock ? textBlock.text.trim() : 'No tengo una respuesta clara en este momento.';
}

module.exports = { responderAyuda, iaDisponible };
