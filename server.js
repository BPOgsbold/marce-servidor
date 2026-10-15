require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');

const db = require('./supabase');
const { responderAyuda, iaDisponible } = require('./claude');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const leer = (archivo) => fs.readFileSync(path.join(__dirname, archivo), 'utf8');
// Se leen en cada mensaje: si editas los archivos de config no hace falta reiniciar.
const CAMPOS = () => JSON.parse(leer('campos.json'));

// ---------------------------------------------------------------------------
// Sesiones (una por ventana de chat). Viven en memoria del servidor.
// ---------------------------------------------------------------------------
const sesiones = new Map();
function nuevaSesion() {
  return {
    modo: 'libre', // 'libre' | 'captura' | 'buscar' | 'seleccion' | 'duplicado'
    captura: null, // { tipo, campos, paso, datos }
    cliente: null, // cliente abierto (fila de "interesados" + venta)
    resultados: [], // resultados de la última búsqueda
    accionPendiente: null, // acción a ejecutar cuando se elija un cliente
  };
}

// ---------------------------------------------------------------------------
// Utilidades de texto
// ---------------------------------------------------------------------------
const norm = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();

const OP = {
  NUEVO: 'Tengo un cliente interesado',
  BUSCAR: 'Buscar cliente',
  RESUMEN: 'Resumen de hoy',
  RESUMEN_EQUIPO: 'Resumen del equipo',
  VENTA: 'Registrar venta',
  NO_VENTA: 'No se interesó',
  COBERTURA: 'Actualizar cobertura',
  CANCELAR: 'Cancelar',
  HOY: 'Mis clientes de hoy',
};
const MENU = [OP.NUEVO, OP.BUSCAR, OP.HOY, OP.RESUMEN];

const INTENCIONES = [
  ['cancelar', /^(cancelar|cancela|salir|olvidalo|reiniciar|empezar de nuevo)$/],
  ['menu', /^(nuevo|nueva|menu|opciones|ayuda|inicio|hola|que puedes hacer|que haces|\+ ?nuevo)[.!?]*$/],
  ['hoy', /clientes\s+de\s+hoy|mis\s+clientes|mis\s+interesados|interesados\s+de\s+hoy|los\s+de\s+hoy|registrados\s+hoy|lista\s+de\s+(hoy|clientes)/],
  ['resumen_equipo', /resumen\s+(del|de\s+todo\s+el)\s+equipo|como\s+va\s+el\s+equipo|numeros\s+del\s+equipo/],
  ['resumen', /resumen|consolid|como\s+voy|mis\s+numeros|cuant[oa]s\s+(llevo|tengo|van|ventas|interesados)/],
  ['venta', /registrar\s+(la\s+|una\s+)?venta|(es|fue|hubo|cerre|cerramos|se\s+hizo)\s+(una\s+)?venta|^venta$|ya\s+compro|acepto\s+la\s+oferta/],
  ['no_venta', /no\s+se\s+intereso|no\s+le\s+intereso|no\s+(esta|estuvo)\s+interesad|^no\s+venta$|no\s+quiso|rechazo/],
  ['cobertura', /(actualizar|cambiar|corregir)\s+(la\s+)?cobertura/],
  ['nuevo', /(tengo|hay|tenemos)\s+(un|una)?\s*(cliente|persona|prospecto)?\s*(interesad|nuev)|cliente\s+interesad|nuevo\s+(interesado|prospecto|cliente)|registrar\s+(un\s+)?interesado/],
  ['buscar', /^(buscar|busca|buscame|consultar|consulta)\b|buscar\s+(a|al|el|la)?\s*cliente|(info|informacion|datos|estado|ficha)\s+(de|del)\s+|como\s+va\s+(el|la)?\s*cliente|ya\s+(fue|esta)\s+(registrad|atendid)/],
];
function detectarIntencion(texto) {
  const t = norm(texto);
  for (const [nombre, re] of INTENCIONES) if (re.test(t)) return nombre;
  return null;
}

// "buscar a maría gómez" → "maría gómez"
function extraerTermino(texto) {
  let t = String(texto || '').trim();
  const quitar = [
    /^por\s+favor\s+/i,
    /^(buscar|busca|búscame|buscame|consultar|consulta|dame|traeme|tráeme|quiero|necesito)\s+/i,
    /^(la|el)\s+/i,
    /^(info|información|informacion|datos|estado|ficha)\s+/i,
    /^(de la|del|de|al|a|el|la)\s+/i,
    /^(cliente|clienta|señor|señora|sr\.?|sra\.?)(\s+|$)/i,
  ];
  for (let i = 0; i < 2; i++) for (const re of quitar) t = t.replace(re, '').trim();
  t = t.replace(/[?¿!¡.]+$/g, '').trim();
  return t.length >= 3 ? t : null;
}

const esCelular = (t) => /^3\d{9}$/.test(String(t).replace(/\D/g, '')) && String(t).replace(/[\d\s-]/g, '') === '';
const esCedula = (t) => /^\d{6,10}$/.test(String(t).replace(/[\s.]/g, ''));

// ---------------------------------------------------------------------------
// Tarjetas y textos
// ---------------------------------------------------------------------------
const ESTADOS = { en_gestion: 'En gestión', venta: 'Venta', no_venta: 'No se interesó' };

// Lo que el back office dijo sobre la cobertura (auditoría desde el panel).
function textoAuditoria(c) {
  if (c.auditoria_cobertura === 'confirmada') return ' · ✅ auditada';
  if (c.auditoria_cobertura === 'sin_cobertura') return ' · ❌ auditoría: sin cobertura';
  return '';
}

function tarjetaDe(c) {
  const fecha = c.created_at
    ? new Date(c.created_at).toLocaleString('es-CO', { timeZone: 'America/Bogota', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
    : '';
  const cob = norm(c.cobertura_validada);
  const detalles = [
    ['Teléfono', c.telefono],
    ['Dirección', [c.direccion, c.ciudad].filter(Boolean).join(' · ')],
    ['Cobertura', (cob === 'si' ? 'Sí' : cob === 'no' ? 'No' : 'Sin validar') + textoAuditoria(c)],
    ['Registrado', [fecha, c.asesor].filter(Boolean).join(' · ')],
  ];
  if (c.venta) {
    const v = c.venta;
    detalles.push(['Cédula', v.cedula], ['Plan', v.plan], ['OT', v.numero_ot], ['Cuenta', v.numero_cuenta]);
    detalles.push(['Instalación', [v.fecha_agenda, v.hora_agenda].filter(Boolean).join(' · ')]);
  }
  if (c.resultado === 'no_venta' && c.motivo_no_interes) detalles.push(['Motivo', c.motivo_no_interes]);
  if (c.observaciones && norm(c.observaciones) !== 'ninguna') detalles.push(['Observaciones', c.observaciones]);
  const estado = c.resultado || 'en_gestion';
  const horaCorta = c.created_at
    ? new Date(c.created_at).toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: 'numeric', minute: '2-digit' })
    : '';
  return {
    id: c.id,
    horaCorta,
    nombre: c.nombre_cliente || 'Sin nombre',
    estado,
    estadoTexto: ESTADOS[estado] || estado,
    detalles: detalles.filter(([, v]) => v).map(([label, valor]) => ({ label, valor: String(valor) })),
  };
}

function accionesPara(c) {
  if (!c) return MENU;
  const sinCobertura = norm(c.cobertura_validada) === 'no';
  if (c.resultado === 'venta') return [OP.BUSCAR, OP.NUEVO];
  if (c.resultado === 'no_venta') return [OP.VENTA, OP.COBERTURA, OP.BUSCAR];
  if (sinCobertura) return [OP.COBERTURA, OP.NO_VENTA, OP.NUEVO];
  return [OP.VENTA, OP.NO_VENTA, OP.COBERTURA];
}

function preguntar(campo, cap) {
  const resp = {
    reply: campo.prompt,
    progreso: { actual: cap.paso + 1, total: cap.campos.length, titulo: TITULOS[cap.tipo] },
  };
  const ops = campo.opciones || campo.opcionesSugeridas;
  if (ops) resp.opciones = [...ops];
  return resp;
}
const TITULOS = { interesado: 'Nuevo interesado', venta: 'Registro de venta', no_venta: 'No se interesó', cobertura: 'Cobertura' };

const conCliente = (sesion) => (sesion.cliente ? ` de ${sesion.cliente.nombre_cliente}` : '');

// ---------------------------------------------------------------------------
// Capturas (interesado, venta, no venta, cobertura)
// ---------------------------------------------------------------------------
function iniciarCaptura(sesion, tipo, datosPrevios = {}) {
  const campos = CAMPOS()[tipo];
  const cap = { tipo, campos, paso: 0, datos: { ...datosPrevios } };
  while (cap.paso < campos.length && campos[cap.paso].id in cap.datos) cap.paso += 1;
  sesion.modo = 'captura';
  sesion.captura = cap;
  return preguntar(campos[cap.paso], cap);
}

function validar(campo, crudo) {
  let v = String(crudo || '').trim();
  if (campo.normalizar === 'solo_numeros') v = v.replace(/\D/g, '');
  if (campo.opciones) {
    const op = campo.opciones.find((o) => norm(o) === norm(v) || norm(o).startsWith(norm(v)) && norm(v).length >= 2);
    return op ? { ok: true, valor: op } : { ok: false };
  }
  if (campo.regex && !new RegExp(campo.regex, 'i').test(v)) return { ok: false };
  return { ok: Boolean(v), valor: v };
}

async function responderCaptura(sesion, asesor, texto) {
  const cap = sesion.captura;
  const campo = cap.campos[cap.paso];
  const r = validar(campo, texto);
  if (!r.ok) {
    const msg = campo.opciones ? `Elige una de las opciones 👇` : `⚠️ ${campo.errorMessage || 'Revisa ese dato.'}`;
    const p = preguntar(campo, cap);
    return { ...p, reply: `${msg}\n\n${p.reply}` };
  }
  cap.datos[campo.id] = r.valor;
  cap.paso += 1;

  // Al tener el teléfono de un interesado nuevo, revisamos si ya existe.
  if (cap.tipo === 'interesado' && campo.id === 'telefono') {
    try {
      const previos = await db.buscarPorTelefono(r.valor);
      if (previos.length) {
        sesion.modo = 'duplicado';
        sesion.resultados = previos;
        return {
          reply: `👀 Ojo: ese celular ya está registrado. ¿Es el mismo cliente?`,
          tarjetas: previos.map(tarjetaDe),
          opciones: ['Sí, es el mismo', 'No, es otro cliente'],
        };
      }
    } catch (e) {
      console.error('No pude revisar duplicados:', e.message);
    }
  }

  while (cap.paso < cap.campos.length && cap.campos[cap.paso].id in cap.datos) cap.paso += 1;
  if (cap.paso < cap.campos.length) return preguntar(cap.campos[cap.paso], cap);
  return finalizarCaptura(sesion, asesor);
}

async function finalizarCaptura(sesion, asesor) {
  const { tipo, datos } = sesion.captura;
  sesion.modo = 'libre';
  sesion.captura = null;
  try {
    if (tipo === 'interesado') {
      const creado = await db.crearInteresado(asesor, { ...datos, cobertura: norm(datos.cobertura) === 'si' ? 'sí' : 'no' });
      sesion.cliente = { ...creado, venta: null };
      const conCob = norm(datos.cobertura) === 'si';
      return {
        reply: conCob
          ? '✅ ¡Interesado registrado con cobertura! Sigue con la oferta — si pone una objeción, escríbemela y te ayudo.'
          : '✅ Interesado registrado. Quedó marcado **sin cobertura**; si después se valida, toca "Actualizar cobertura".',
        tarjetas: [tarjetaDe(sesion.cliente)],
        opciones: accionesPara(sesion.cliente),
      };
    }
    const c = sesion.cliente;
    if (tipo === 'venta') {
      await db.guardarVenta(asesor, c, datos);
      await db.actualizarInteresado(c.id, { resultado: 'venta', ciudad: datos.ciudad || c.ciudad || null });
      sesion.cliente = await db.obtenerCliente(c.id);
      return {
        reply: '🎉 ¡Venta registrada! Excelente trabajo, así se hace.',
        tarjetas: [tarjetaDe(sesion.cliente)],
        opciones: [OP.NUEVO, OP.RESUMEN],
        celebrar: true,
      };
    }
    if (tipo === 'no_venta') {
      sesion.cliente = {
        ...(await db.actualizarInteresado(c.id, {
          resultado: 'no_venta',
          motivo_no_interes: datos.motivo_no_interes,
          observaciones: datos.observaciones,
        })),
        venta: c.venta,
      };
      return {
        reply: 'Listo, quedó registrado. Ánimo, ¡el siguiente es tuyo! 💪',
        tarjetas: [tarjetaDe(sesion.cliente)],
        opciones: [OP.NUEVO, OP.BUSCAR, OP.RESUMEN],
      };
    }
    if (tipo === 'cobertura') {
      const valor = norm(datos.cobertura) === 'si' ? 'sí' : 'no';
      sesion.cliente = { ...(await db.actualizarInteresado(c.id, { cobertura_validada: valor })), venta: c.venta };
      return {
        reply: `✅ Cobertura actualizada a **${valor === 'sí' ? 'Sí' : 'No'}**.`,
        tarjetas: [tarjetaDe(sesion.cliente)],
        opciones: accionesPara(sesion.cliente),
      };
    }
  } catch (e) {
    console.error('Error guardando:', e);
    return {
      reply: `No pude guardar en la base de datos (${e.message}). Los datos no se perdieron en esta ventana; avisa a soporte.`,
      error: true,
      opciones: MENU,
    };
  }
  return { reply: 'Listo.', opciones: MENU };
}

// ---------------------------------------------------------------------------
// Búsqueda
// ---------------------------------------------------------------------------
async function ejecutarBusqueda(sesion, termino) {
  let resultados;
  try {
    resultados = await db.buscarClientes(termino);
  } catch (e) {
    console.error('Error buscando:', e);
    sesion.modo = 'libre';
    return { reply: `No pude consultar la base de datos (${e.message}). Intenta de nuevo en un momento.`, error: true };
  }
  if (!resultados.length) {
    sesion.modo = 'libre';
    sesion.accionPendiente = null;
    return {
      reply: `No encontré clientes con "${termino}". Revisa cómo está escrito, o si es nuevo regístralo.`,
      opciones: [OP.NUEVO, OP.BUSCAR],
    };
  }
  if (resultados.length === 1) return abrirCliente(sesion, resultados[0]);
  sesion.modo = 'seleccion';
  sesion.resultados = resultados;
  return {
    reply: `Encontré ${resultados.length} clientes con "${termino}". ¿Cuál es?`,
    tarjetas: resultados.map((c, i) => ({ ...tarjetaDe(c), compacta: true, elegir: `${i + 1}. ${c.nombre_cliente || 'Sin nombre'}` })),
    opciones: resultados.map((c, i) => `${i + 1}. ${c.nombre_cliente || 'Sin nombre'}`).concat(OP.CANCELAR),
  };
}

function abrirCliente(sesion, cliente) {
  sesion.cliente = cliente;
  sesion.modo = 'libre';
  sesion.resultados = [];
  const pendiente = sesion.accionPendiente;
  sesion.accionPendiente = null;
  if (pendiente) {
    const inicio = arrancarAccion(sesion, pendiente);
    return { ...inicio, tarjetas: [tarjetaDe(cliente)], reply: inicio.reply };
  }
  return {
    reply: `Este es el cliente${cliente.resultado === 'venta' ? ' — ya tiene venta registrada ✅' : ''}. ¿Qué hacemos?`,
    tarjetas: [tarjetaDe(cliente)],
    opciones: accionesPara(cliente),
  };
}

function arrancarAccion(sesion, accion) {
  const c = sesion.cliente;
  if (accion === 'venta') {
    if (c.resultado === 'venta') return { reply: 'Este cliente ya tiene una venta registrada ✅.', opciones: [OP.NUEVO, OP.BUSCAR] };
    if (norm(c.cobertura_validada) === 'no') {
      return { reply: 'Este cliente está marcado **sin cobertura**. Si ya se validó que sí tiene, actualízala primero.', opciones: [OP.COBERTURA, OP.NO_VENTA] };
    }
    return iniciarCaptura(sesion, 'venta', c.ciudad ? { ciudad: c.ciudad } : {});
  }
  if (accion === 'no_venta') return iniciarCaptura(sesion, 'no_venta');
  if (accion === 'cobertura') return iniciarCaptura(sesion, 'cobertura');
  return { reply: '¿Qué hacemos?', opciones: accionesPara(c) };
}

// ---------------------------------------------------------------------------
// Mis clientes de hoy (para elegir sin tener el teléfono)
// ---------------------------------------------------------------------------
async function clientesDeHoy(sesion, asesor) {
  let lista;
  try {
    lista = await db.clientesDeHoy(asesor);
  } catch (e) {
    console.error('Error listando clientes de hoy:', e);
    return { reply: `No pude traer la lista (${e.message}).`, error: true };
  }
  if (!lista.length) {
    sesion.modo = 'libre';
    return { reply: 'Hoy todavía no has registrado clientes. ¡A darle! 💪', opciones: [OP.NUEVO, OP.BUSCAR] };
  }
  sesion.modo = 'seleccion';
  sesion.resultados = lista;
  return {
    reply: `Tus ${lista.length} cliente(s) de hoy, del más reciente al más antiguo. Toca el que necesitas 👇 (o escribe parte del nombre).`,
    tarjetas: lista.map((c, i) => ({ ...tarjetaDe(c), compacta: true, elegir: `${i + 1}. ${c.nombre_cliente || 'Sin nombre'}` })),
    opciones: [OP.CANCELAR],
  };
}

// ---------------------------------------------------------------------------
// Resumen
// ---------------------------------------------------------------------------
async function resumen(asesor, equipo) {
  try {
    const r = await db.resumenDeHoy(equipo ? null : asesor);
    const efect = r.interesados ? Math.round((r.ventas / r.interesados) * 100) : 0;
    const quien = equipo ? 'del equipo' : asesor ? `de ${asesor.split(' ')[0]}` : '';
    let reply = `📊 Así va el día ${quien}:`;
    if (!r.interesados && !r.ventas) reply = `📊 Hoy todavía no hay registros ${quien}. ¡A darle! 💪`;
    else if (r.enGestion) reply += `\n\nTienes **${r.enGestion}** interesado(s) todavía en gestión — búscalos para cerrarlos.`;
    return {
      reply,
      resumen: {
        titulo: `Hoy · ${new Date().toLocaleDateString('es-CO', { timeZone: 'America/Bogota', weekday: 'long', day: 'numeric', month: 'long' })}`,
        items: [
          { label: 'Interesados', valor: r.interesados },
          { label: 'Ventas', valor: r.ventas, destacado: true },
          { label: 'Efectividad', valor: `${efect}%` },
          { label: 'Con cobertura', valor: r.conCobertura },
          { label: 'Sin cobertura', valor: r.sinCobertura },
          { label: 'No se interesó', valor: r.noVenta },
        ],
      },
      opciones: equipo ? [OP.RESUMEN, OP.NUEVO] : [OP.RESUMEN_EQUIPO, OP.NUEVO, OP.BUSCAR],
    };
  } catch (e) {
    console.error('Error en resumen:', e);
    return { reply: `No pude traer el resumen (${e.message}).`, error: true };
  }
}

// ---------------------------------------------------------------------------
// Ayuda con IA (objeciones, ganchos, proceso)
// ---------------------------------------------------------------------------
async function ayuda(sesion, texto) {
  if (!iaDisponible()) {
    return {
      reply:
        'Puedo ayudarte a registrar interesados, buscar clientes, registrar ventas y darte el resumen del día. ' +
        '(Para ayudarte con objeciones necesito que configuren la clave de IA en el servidor.)',
      opciones: MENU,
    };
  }
  try {
    const campo = sesion.modo === 'captura' ? sesion.captura.campos[sesion.captura.paso] : null;
    const respuesta = await responderAyuda(texto, {
      sop: leer('sop.md'),
      objeciones: leer('objeciones.md'),
      cliente: sesion.cliente
        ? { nombre: sesion.cliente.nombre_cliente, cobertura: sesion.cliente.cobertura_validada, estado: sesion.cliente.resultado }
        : null,
      pasoActual: campo?.prompt,
    });
    return { reply: respuesta };
  } catch (e) {
    console.error('Error IA:', e.message);
    return { reply: 'Ahora mismo no pude pensar la respuesta 😅. Intenta de nuevo en un momento.', error: true };
  }
}

// ---------------------------------------------------------------------------
// Cerebro del chat
// ---------------------------------------------------------------------------
async function manejar(sesion, asesor, texto) {
  const t = String(texto || '').trim();
  const n = norm(t);
  const nombre = asesor ? asesor.split(' ')[0] : '';

  if (t === '__inicio__') {
    return {
      reply:
        `¡Hola${nombre ? `, ${nombre}` : ''}! Soy **Marce**, tu asistente comercial 🙌. ` +
        'Cuando tengas un interesado dime "tengo un cliente interesado" y lo registramos. ' +
        'También puedo buscar un cliente (por nombre, celular o cédula), registrar la venta, ' +
        'ayudarte con objeciones o darte el resumen del día.',
      opciones: MENU,
    };
  }
  if (t === '__nuevo__') {
    Object.assign(sesion, nuevaSesion());
    return { ...iniciarCaptura(sesion, 'interesado'), reply: '¡Vamos! 🙌 ' + CAMPOS().interesado[0].prompt };
  }

  const intencion = detectarIntencion(t);

  if (intencion === 'cancelar') {
    const habia = sesion.modo !== 'libre';
    sesion.modo = 'libre';
    sesion.captura = null;
    sesion.accionPendiente = null;
    return { reply: habia ? 'Listo, lo dejamos ahí. ¿Qué sigue?' : '¿En qué te ayudo?', opciones: sesion.cliente ? accionesPara(sesion.cliente) : MENU };
  }

  // --- Respondiendo un formulario ---
  if (sesion.modo === 'captura') {
    const cap = sesion.captura;
    const campo = cap.campos[cap.paso];
    const esOpcion = (campo.opciones || campo.opcionesSugeridas || []).some((o) => norm(o) === n);
    // Saltos explícitos de flujo (solo frases claras, para no confundir datos con comandos)
    if (!esOpcion && ['resumen', 'resumen_equipo', 'buscar', 'nuevo', 'hoy', 'menu'].includes(intencion) && n.split(' ').length <= 6) {
      const titulo = TITULOS[cap.tipo];
      return {
        reply: `Estamos en medio de "${titulo}". ¿Lo dejamos y seguimos con lo otro?`,
        opciones: [OP.CANCELAR, 'Seguir donde iba'],
      };
    }
    if (n === 'seguir donde iba') return preguntar(campo, cap);
    if (!esOpcion && /\?\s*$/.test(t)) {
      const a = await ayuda(sesion, t);
      const p = preguntar(campo, cap);
      return { ...p, reply: `${a.reply}\n\n➡️ ${p.reply}` };
    }
    return responderCaptura(sesion, asesor, t);
  }

  // --- Posible duplicado ---
  if (sesion.modo === 'duplicado') {
    if (/^si/.test(n)) {
      sesion.captura = null;
      return abrirCliente(sesion, sesion.resultados[0]);
    }
    if (/^no/.test(n)) {
      sesion.modo = 'captura';
      const cap = sesion.captura;
      while (cap.paso < cap.campos.length && cap.campos[cap.paso].id in cap.datos) cap.paso += 1;
      if (cap.paso < cap.campos.length) return { ...preguntar(cap.campos[cap.paso], cap), reply: 'Ok, sigamos. ' + cap.campos[cap.paso].prompt };
      return finalizarCaptura(sesion, asesor);
    }
    return { reply: '¿Es el mismo cliente?', opciones: ['Sí, es el mismo', 'No, es otro cliente'] };
  }

  // --- Eligiendo entre varios resultados ---
  if (sesion.modo === 'seleccion') {
    const num = parseInt(n, 10);
    let elegido = Number.isInteger(num) ? sesion.resultados[num - 1] : null;
    if (!elegido) elegido = sesion.resultados.find((c) => norm(c.nombre_cliente) === n || (c.telefono && c.telefono === t.replace(/\D/g, '')));
    if (!elegido && !intencion && n.length >= 3) {
      const parecidos = sesion.resultados.filter((c) => norm(c.nombre_cliente).includes(n) || norm(c.direccion).includes(n));
      if (parecidos.length === 1) elegido = parecidos[0];
    }
    if (elegido) return abrirCliente(sesion, elegido);
    if (!intencion) return ejecutarBusqueda(sesion, t); // escribió otro término
    sesion.modo = 'libre';
  }

  // --- Esperando el término de búsqueda ---
  if (sesion.modo === 'buscar' && !intencion) {
    return ejecutarBusqueda(sesion, t);
  }

  // --- Intenciones ---
  if (intencion === 'menu') {
    sesion.modo = 'libre';
    sesion.accionPendiente = null;
    return { reply: '¿Qué quieres hacer? 👇', opciones: MENU };
  }
  if (intencion === 'hoy') return clientesDeHoy(sesion, asesor);
  if (intencion === 'nuevo') {
    sesion.cliente = null;
    return { ...iniciarCaptura(sesion, 'interesado'), reply: '¡Bien! 🙌 Registremos al interesado. ' + CAMPOS().interesado[0].prompt };
  }
  if (intencion === 'resumen' || intencion === 'resumen_equipo') {
    sesion.modo = 'libre';
    return resumen(asesor, intencion === 'resumen_equipo');
  }
  if (intencion === 'buscar') {
    const termino = extraerTermino(t);
    if (termino && !/^cliente$/i.test(termino)) return ejecutarBusqueda(sesion, termino);
    sesion.modo = 'buscar';
    return {
      reply: 'Claro 🔎. Escríbeme el nombre, el celular o la cédula del cliente.\n\n¿No tienes el dato a la mano? Toca "Mis clientes de hoy" y lo eliges de la lista.',
      opciones: [OP.HOY, OP.CANCELAR],
    };
  }
  if (intencion === 'venta' || intencion === 'no_venta' || intencion === 'cobertura') {
    if (!sesion.cliente) {
      sesion.accionPendiente = intencion;
      sesion.modo = 'buscar';
      const que = { venta: 'registrar la venta', no_venta: 'registrar que no se interesó', cobertura: 'actualizar la cobertura' }[intencion];
      return { reply: `Listo, para ${que} primero dime de qué cliente: nombre, celular o cédula.`, opciones: [OP.CANCELAR] };
    }
    return arrancarAccion(sesion, intencion);
  }

  // --- Escribió directamente un celular o cédula: lo buscamos ---
  if (esCelular(t) || esCedula(t)) return ejecutarBusqueda(sesion, t);

  // --- Todo lo demás: objeciones, ganchos, dudas → IA ---
  const a = await ayuda(sesion, t);
  return a;
}

// ---------------------------------------------------------------------------
// Rutas
// ---------------------------------------------------------------------------
app.get('/api/health', (req, res) => res.json({ ok: true, ia: iaDisponible() }));

// ---------------------------------------------------------------------------
// Panel web (back office). Protegido con la clave PANEL_CLAVE de Render.
// ---------------------------------------------------------------------------
function exigirClave(req, res, next) {
  const clave = process.env.PANEL_CLAVE;
  if (!clave) return res.status(503).json({ error: 'Falta configurar PANEL_CLAVE en Render (Environment).' });
  if (req.get('x-panel-clave') !== clave) return res.status(401).json({ error: 'Clave incorrecta.' });
  next();
}

// Fecha "AAAA-MM-DD" (hora Colombia) → ISO
const isoColombia = (fecha, finDelDia) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fecha || ''))) return null;
  const d = new Date(`${fecha}T00:00:00-05:00`);
  if (finDelDia) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
};

app.get('/api/panel/login', exigirClave, (req, res) => res.json({ ok: true }));

app.get('/api/panel/datos', exigirClave, async (req, res) => {
  try {
    const hoy = new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
    const desde = isoColombia(req.query.desde || hoy, false);
    const hasta = isoColombia(req.query.hasta || hoy, true);
    if (!desde || !hasta) return res.status(400).json({ error: 'Fechas inválidas (usa AAAA-MM-DD).' });
    res.json(await db.panelDatos(desde, hasta));
  } catch (err) {
    console.error('Error panel/datos:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/panel/auditar', exigirClave, async (req, res) => {
  try {
    const { id, resultado, nota, auditor } = req.body || {};
    if (!id || !['confirmada', 'sin_cobertura', 'pendiente'].includes(resultado)) {
      return res.status(400).json({ error: 'Falta id o el resultado no es válido.' });
    }
    res.json({ ok: true, interesado: await db.auditarCobertura(id, { resultado, nota, auditor }) });
  } catch (err) {
    console.error('Error panel/auditar:', err);
    res.status(500).json({ error: err.message });
  }
});

// El estado de la conversación viaja con cada mensaje (lo guarda la extensión).
// Así, aunque Render reinicie o "duerma" el servidor, no se pierde el paso
// en el que iba el asesor.
function serializar(sesion) {
  const { captura, ...resto } = sesion;
  return {
    ...resto,
    captura: captura ? { tipo: captura.tipo, paso: captura.paso, datos: captura.datos } : null,
  };
}
function hidratar(estado) {
  if (!estado || typeof estado !== 'object') return null;
  const sesion = { ...nuevaSesion(), ...estado };
  if (sesion.captura) {
    const campos = CAMPOS()[sesion.captura.tipo];
    if (!campos) sesion.captura = null;
    else sesion.captura = { ...sesion.captura, campos, paso: Math.min(sesion.captura.paso || 0, campos.length - 1) };
  }
  if (sesion.modo === 'captura' && !sesion.captura) sesion.modo = 'libre';
  return sesion;
}

app.post('/api/chat', async (req, res) => {
  try {
    const { sessionId, asesor, message, estado } = req.body || {};
    if (!sessionId || !message) return res.status(400).json({ error: 'Falta sessionId o message' });
    const sesion = hidratar(estado) || sesiones.get(sessionId) || nuevaSesion();
    const respuesta = await manejar(sesion, asesor, message);
    sesiones.set(sessionId, sesion);
    if (sesiones.size > 2000) sesiones.delete(sesiones.keys().next().value);
    res.json({ ...respuesta, estado: serializar(sesion) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Error interno' });
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Marce · Asistente de Venta escuchando en http://localhost:${PORT}`);
  });
}

module.exports = { manejar, nuevaSesion };
