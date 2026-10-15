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
  HOY: 'Mis clientes',
  RESUMEN_MES: 'Resumen del mes',
  RELLAMAR: 'Volver a llamar',
  RELLAMADAS: 'Mis volver a llamar',
  ESCALAMIENTOS: 'Mis escalamientos',
  VENTAS: 'Mis ventas',
  OT_ACTIVA: 'OT activa',
  MIS_OT: 'Mis OT activas',
  EDITAR: '✏️ Editar datos',
  ESCALAR: 'Escalamiento',
};
const MENU = [OP.NUEVO, OP.BUSCAR, OP.HOY, OP.RELLAMADAS, OP.RESUMEN];

const INTENCIONES = [
  ['cancelar', /^(cancelar|cancela|salir|olvidalo|reiniciar|empezar de nuevo)$/],
  ['menu', /^(nuevo|nueva|menu|opciones|ayuda|inicio|hola|que puedes hacer|que haces|\+ ?nuevo)[.!?]*$/],
  ['hoy', /clientes\s+de\s+hoy|mis\s+clientes|mis\s+interesados|interesados\s+de\s+hoy|los\s+de\s+hoy|registrados\s+hoy|lista\s+de\s+(hoy|clientes)/],
  ['resumen_mes', /resumen\s+del\s+mes|como\s+voy\s+(en\s+)?(el|este)\s+mes|numeros\s+del\s+mes|en\s+el\s+mes/],
  ['resumen_equipo', /resumen\s+(del|de\s+todo\s+el)\s+equipo|como\s+va\s+el\s+equipo|numeros\s+del\s+equipo/],
  ['resumen', /resumen|consolid|como\s+voy|mis\s+numeros|cuant[oa]s\s+(llevo|tengo|van|ventas|interesados)/],
  ['venta', /registrar\s+(la\s+|una\s+)?venta|(es|fue|hubo|cerre|cerramos|se\s+hizo)\s+(una\s+)?venta|^venta$|ya\s+compro|acepto\s+la\s+oferta/],
  ['no_venta', /no\s+se\s+intereso|no\s+le\s+intereso|no\s+(esta|estuvo)\s+interesad|^no\s+venta$|no\s+quiso|rechazo/],
  ['cobertura', /(actualizar|cambiar|corregir)\s+(la\s+)?cobertura/],
  ['misot', /mis\s+ot|ots?\s+activas|mis\s+ordenes|seguimiento\s+(de\s+)?ot/],
  ['ot_activa', /ot\s+activa|tiene\s+(una\s+)?ot\b|orden\s+(de\s+trabajo\s+)?activa|^ot$/],
  ['misventas', /mis\s+ventas|ventas\s+(del\s+mes|instaladas|pendientes)|como\s+van\s+mis\s+ventas|instalacion(es)?\s+pendientes/],
  ['escalamientos', /mis\s+escalamientos|escalamientos\s+pendientes|como\s+van\s+(mis\s+)?escalamientos/],
  ['escalar', /escalar|escalamiento|escalacion|crear\s+(la\s+)?direccion|validar\s+(la\s+)?cedula|cartera|factibilidad/],
  ['editar', /editar|corregir\s+(un\s+|el\s+|los\s+)?datos?|cambiar\s+(un\s+|el\s+|los\s+)?datos?|actualizar\s+(un\s+|el\s+|los\s+)?datos?|modificar|me\s+equivoque/],
  ['rellamadas', /mis\s+volver\s+a\s+llamar|mis\s+rellamadas|rellamadas\s+(de\s+hoy|pendientes)|a\s+quien\s+(debo|tengo\s+que)\s+(volver\s+a\s+)?llamar|^rellamadas$|pendientes\s+por\s+llamar/],
  ['rellamar', /volver\s+a\s+llamar|rellamar|reprogramar|agendar\s+(una\s+)?(llamada|rellamada)|llamar\s+(despues|mas\s+tarde|otro\s+dia|manana)/],
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
const ESTADOS = { en_gestion: 'En gestión', venta: 'Venta', no_venta: 'No se interesó', volver_llamar: 'Volver a llamar', escalado: 'Escalado', ot_activa: 'OT activa' };

// ---------------------------------------------------------------------------
// Fechas de rellamada (hora Colombia)
// ---------------------------------------------------------------------------
const hoyCO = () => new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
const sumarDias = (iso, n) => {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const DIAS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
function fechaBonita(iso) {
  if (!iso) return '';
  const hoy = hoyCO();
  if (iso === hoy) return 'hoy';
  if (iso === sumarDias(hoy, 1)) return 'mañana';
  return new Date(iso + 'T12:00:00Z').toLocaleDateString('es-CO', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'short' });
}
function textoRellamada(c) {
  return [fechaBonita(c.rellamar_fecha), c.rellamar_hora].filter(Boolean).join(' · ');
}
// "hoy", "mañana", "pasado mañana", "viernes", "18/10", "18/10/2026", "en 3 dias"
function validarFechaFutura(crudo) {
  const t = norm(crudo).replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
  const hoy = hoyCO();
  let iso = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) iso = t;
  else if (/^hoy\b/.test(t)) iso = hoy;
  else if (/^pasado\s*manana/.test(t)) iso = sumarDias(hoy, 2);
  else if (/^manana/.test(t)) iso = sumarDias(hoy, 1);
  else if (/^en\s+(\d{1,2})\s+dias?/.test(t)) iso = sumarDias(hoy, parseInt(t.match(/^en\s+(\d{1,2})/)[1], 10));
  else {
    const dia = DIAS.findIndex((d) => t.startsWith(d) || t.startsWith('el ' + d) || t.startsWith('este ' + d) || t.startsWith('proximo ' + d));
    if (dia >= 0) {
      const hoyDia = new Date(hoy + 'T12:00:00Z').getUTCDay();
      let n = (dia - hoyDia + 7) % 7;
      if (n === 0) n = 7;
      iso = sumarDias(hoy, n);
    } else {
      const m = t.match(/^(\d{1,2})\s*[\/-]\s*(\d{1,2})(?:\s*[\/-]\s*(\d{2,4}))?$/);
      if (m) {
        let anio = m[3] ? parseInt(m[3], 10) : parseInt(hoy.slice(0, 4), 10);
        if (anio < 100) anio += 2000;
        const cand = `${anio}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
        const d = new Date(cand + 'T12:00:00Z');
        if (!isNaN(d) && d.toISOString().slice(0, 10) === cand) iso = !m[3] && cand < hoy ? `${anio + 1}${cand.slice(4)}` : cand;
      }
    }
  }
  if (!iso) return { ok: false };
  if (iso < hoy) return { ok: false, mensaje: 'Esa fecha ya pasó. ¿Para cuándo quedó la nueva llamada?' };
  return { ok: true, valor: iso };
}

// Estado de instalación de una venta (lo marca el back office en el panel).
function textoInstalacion(v) {
  const fecha = v.instalacion_fecha
    ? ' · ' + new Date(v.instalacion_fecha).toLocaleDateString('es-CO', { timeZone: 'America/Bogota', day: 'numeric', month: 'short' })
    : '';
  if (v.estado_instalacion === 'instalada') return '✅ Instalada' + fecha;
  if (v.estado_instalacion === 'no_instalada') return '❌ No instalada' + fecha;
  return '⏳ Pendiente de instalación';
}

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
    ['Gestiona', c.asesor],
    ['Teléfono', c.telefono],
    ['Dirección', [c.direccion, c.ciudad].filter(Boolean).join(' · ')],
    ['Cobertura', (cob === 'si' ? 'Sí' : cob === 'no' ? 'No' : 'Sin validar') + textoAuditoria(c)],
    ['Registrado', fecha],
  ];
  if (c.venta) {
    const v = c.venta;
    detalles.push(['Cédula', v.cedula], ['Plan', v.plan], ['OT', v.numero_ot], ['Cuenta', v.numero_cuenta]);
    detalles.push(['Agenda', [v.fecha_agenda, v.hora_agenda].filter(Boolean).join(' · ')]);
    detalles.push(['Instalación', textoInstalacion(v)]);
    if (v.instalacion_nota) detalles.push(['Nota instalación', v.instalacion_nota]);
  }
  if (c.resultado === 'no_venta' && c.motivo_no_interes) detalles.push(['Motivo', c.motivo_no_interes]);
  if (c.ot_activa_numero) {
    const est = c.ot_activa_estado === 'liberada' ? '✅ liberada' : '⏳ activa';
    detalles.push(['🧾 OT activa', `${c.ot_activa_numero} · ${est}`]);
    if (c.ot_activa_respuesta) detalles.push(['Respuesta back', c.ot_activa_respuesta]);
  }
  if (c.escalamiento_tipo) {
    const est = c.escalamiento_estado === 'resuelto' ? '✅ resuelto' : '⏳ pendiente';
    detalles.push(['🛠 Escalamiento', `${c.escalamiento_tipo} · ${est}`]);
    if (c.escalamiento_detalle) detalles.push(['Detalle', c.escalamiento_detalle]);
    if (c.escalamiento_respuesta) detalles.push(['Respuesta back', c.escalamiento_respuesta]);
  }
  if (c.resultado === 'volver_llamar') {
    detalles.push(['📞 Volver a llamar', textoRellamada(c)]);
    if (c.rellamar_nota && norm(c.rellamar_nota) !== 'ninguna') detalles.push(['Nota', c.rellamar_nota]);
  }
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
  if (c.resultado === 'venta') return [OP.EDITAR, OP.BUSCAR, OP.NUEVO];
  if (c.resultado === 'no_venta') return [OP.VENTA, OP.RELLAMAR, OP.OT_ACTIVA, OP.ESCALAR, OP.COBERTURA, OP.EDITAR];
  if (sinCobertura) return [OP.COBERTURA, OP.ESCALAR, OP.NO_VENTA, OP.RELLAMAR, OP.EDITAR];
  return [OP.VENTA, OP.NO_VENTA, OP.RELLAMAR, OP.OT_ACTIVA, OP.ESCALAR, OP.COBERTURA, OP.EDITAR];
}

// ---------------------------------------------------------------------------
// Editar un dato de la ficha
// ---------------------------------------------------------------------------
// Datos que se pueden corregir: los del interesado siempre, los de la venta si tiene venta.
const EDITABLES_INTERESADO = ['nombre_cliente', 'telefono', 'direccion', 'ciudad'];
const EDITABLES_VENTA = ['cedula', 'barrio', 'plan', 'numero_ot', 'numero_cuenta', 'fecha_agenda', 'hora_agenda', 'observaciones'];
function campoEditable(id) {
  const todos = [...(CAMPOS().interesado || []), ...(CAMPOS().venta || [])];
  const def = todos.find((c) => c.id === id);
  if (!def) return null;
  return { ...def, prompt: `✏️ Escribe el nuevo dato de **${def.label.toLowerCase()}**:`, opcionesSugeridas: undefined };
}
function editablesPara(c) {
  const ids = [...EDITABLES_INTERESADO, ...(c?.venta ? EDITABLES_VENTA : [])];
  return ids.map(campoEditable).filter(Boolean);
}
function valorActual(c, id) {
  if (!c) return '';
  if (EDITABLES_VENTA.includes(id)) return c.venta?.[id] || '';
  return c[id] || '';
}
function pedirQueEditar(sesion) {
  const c = sesion.cliente;
  if (!c) return { reply: 'Primero abre la ficha del cliente (búscalo por nombre o celular).', opciones: [OP.BUSCAR, OP.HOY] };
  sesion.modo = 'editar_elegir';
  return {
    reply: `✏️ ¿Qué dato de **${c.nombre_cliente || 'este cliente'}** deseas actualizar?`,
    opciones: [...editablesPara(c).map((f) => f.label), OP.CANCELAR],
  };
}

function preguntar(campo, cap) {
  const resp = {
    reply: campo.prompt,
    progreso: { actual: cap.paso + 1, total: cap.campos.length, titulo: TITULOS[cap.tipo] },
  };
  const ops = campo.opciones || campo.opcionesSugeridas;
  if (ops) resp.opciones = [...ops];
  if (campo.entrada) resp.entrada = { tipo: campo.entrada, formato: campo.formato || 'iso' };
  return resp;
}
const TITULOS = { interesado: 'Nuevo interesado', venta: 'Registro de venta', no_venta: 'No se interesó', cobertura: 'Cobertura', rellamar: 'Volver a llamar', escalamiento: 'Escalamiento', ot_activa: 'OT activa', editar: 'Editar dato' };

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

// ---------------------------------------------------------------------------
// Ciudades / municipios de Colombia (1.119, fuente DANE). El asesor escribe y
// Marce la reconoce aunque venga sin tilde o con errores de digitación.
// ---------------------------------------------------------------------------
let MUNICIPIOS = null;
function municipios() {
  if (!MUNICIPIOS) {
    const lista = JSON.parse(leer('municipios.json'));
    const repetidos = new Set(lista.map((m) => m[0]).filter((n, i, a) => a.indexOf(n) !== i));
    MUNICIPIOS = lista.map(([nombre, depto]) => ({
      nombre,
      depto,
      etiqueta: repetidos.has(nombre) ? `${nombre} (${depto})` : nombre,
      llave: llaveCiudad(nombre),
    }));
  }
  return MUNICIPIOS;
}
function llaveCiudad(s) {
  return norm(s)
    .replace(/\b(d\.?\s?c\.?|distrito capital|distrito)\b/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
const ALIAS_CIUDAD = { bogota: 'Bogotá D.C.', bta: 'Bogotá D.C.', 'cartagena de indias': 'Cartagena', 'san jose de cucuta': 'Cúcuta', mede: 'Medellín', 'santafe de bogota': 'Bogotá D.C.',
  villavo: 'Villavicencio', bquilla: 'Barranquilla', 'b quilla': 'Barranquilla', bmanga: 'Bucaramanga', 'b manga': 'Bucaramanga',
  'santa fe de bogota': 'Bogotá D.C.', 'bogota dc': 'Bogotá D.C.' };
function distancia(a, b) {
  if (Math.abs(a.length - b.length) > 3) return 99;
  const f = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = f[0];
    f[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = f[j];
      f[j] = Math.min(f[j] + 1, f[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return f[b.length];
}
const DEJAR = '✍️ Dejar: ';
function validarMunicipio(crudo) {
  const texto = String(crudo || '').trim();
  if (texto.startsWith(DEJAR)) {
    const v = texto.slice(DEJAR.length).replace(/^"|"$/g, '').trim();
    return v.length >= 3 ? { ok: true, valor: v } : { ok: false };
  }
  const lista = municipios();
  // Botón elegido: "Granada (Meta)" o nombre exacto
  const porEtiqueta = lista.find((m) => norm(m.etiqueta) === norm(texto));
  if (porEtiqueta) return { ok: true, valor: porEtiqueta.etiqueta, extra: { departamento: porEtiqueta.depto } };
  const k = llaveCiudad(texto);
  if (k.length < 3) return { ok: false };
  const alias = ALIAS_CIUDAD[k];
  const exactos = alias ? lista.filter((m) => m.nombre === alias) : lista.filter((m) => m.llave === k);
  if (exactos.length === 1) return { ok: true, valor: exactos[0].etiqueta, extra: { departamento: exactos[0].depto } };
  if (exactos.length > 1) {
    return { ok: false, mensaje: `Hay varios municipios llamados "${exactos[0].nombre}". ¿Cuál es?`, sugerencias: exactos.map((m) => m.etiqueta) };
  }
  const candidatos = lista
    .map((m) => {
      let d = distancia(k, m.llave);
      if (m.llave.startsWith(k)) d = Math.min(d, 0.5);
      else if (k.length >= 4 && m.llave.includes(k)) d = Math.min(d, 1);
      return { m, d };
    })
    .filter((x) => x.d <= (k.length >= 7 ? 2 : 1))
    .sort((a, b) => a.d - b.d || a.m.nombre.length - b.m.nombre.length)
    .slice(0, 5);
  if (candidatos.length === 1 && candidatos[0].d <= 1 && !candidatos[0].m.llave.startsWith(k)) {
    // Un solo parecido muy cercano (ej. "medelin" → Medellín): lo tomamos de una.
    const m = candidatos[0].m;
    return { ok: true, valor: m.etiqueta, extra: { departamento: m.depto } };
  }
  return {
    ok: false,
    mensaje: candidatos.length
      ? `No encontré "${texto}" exacto. ¿Es alguna de estas?`
      : `No encontré "${texto}" entre los municipios de Colombia. Revisa cómo está escrito, o déjalo así si estás seguro.`,
    sugerencias: [...candidatos.map((x) => x.m.etiqueta), `${DEJAR}${texto}`],
  };
}

function validar(campo, crudo) {
  if (campo.tipo === 'municipio') return validarMunicipio(crudo);
  if (campo.tipo === 'fecha_futura') return validarFechaFutura(crudo);
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
  if (!r.ok && r.sugerencias) {
    return { reply: r.mensaje, opciones: r.sugerencias, progreso: preguntar(campo, cap).progreso };
  }
  if (!r.ok) {
    const msg = r.mensaje ? `⚠️ ${r.mensaje}` : campo.opciones ? `Elige una de las opciones 👇` : `⚠️ ${campo.errorMessage || 'Revisa ese dato.'}`;
    const p = preguntar(campo, cap);
    return { ...p, reply: `${msg}\n\n${p.reply}` };
  }
  cap.datos[campo.id] = r.valor;
  if (r.extra) Object.assign(cap.datos, r.extra);
  cap.paso += 1;

  // Al tener el teléfono de un interesado nuevo, revisamos si ya existe.
  if (cap.tipo === 'interesado' && campo.id === 'telefono') {
    try {
      const previos = await db.buscarPorTelefono(r.valor);
      if (previos.length) {
        sesion.modo = 'duplicado';
        sesion.resultados = previos;
        return {
          reply: avisoDuplicado(previos, asesor),
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
  const campoEditadoId = sesion.captura.campoId;
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
        opciones: [OP.NUEVO, OP.EDITAR, OP.RESUMEN],
        celebrar: true,
      };
    }
    if (tipo === 'no_venta') {
      sesion.cliente = {
        ...(await db.actualizarInteresado(c.id, {
          resultado: 'no_venta',
          motivo_no_interes: datos.motivo_no_interes || null,
          observaciones: datos.observaciones || null,
        })),
        venta: c.venta,
      };
      return {
        reply: 'Listo, quedó registrado. Ánimo, ¡el siguiente es tuyo! 💪',
        tarjetas: [tarjetaDe(sesion.cliente)],
        opciones: [OP.NUEVO, OP.BUSCAR, OP.RESUMEN],
      };
    }
    if (tipo === 'editar') {
      const id = campoEditadoId || Object.keys(datos)[0];
      const valor = datos[id];
      const etiqueta = (campoEditable(id)?.label || id).toLowerCase();
      if (EDITABLES_INTERESADO.includes(id)) await db.actualizarInteresado(c.id, { [id]: valor });
      if (c.venta && (EDITABLES_VENTA.includes(id) || EDITABLES_INTERESADO.includes(id))) await db.actualizarVenta(c.venta.id, { [id]: valor });
      sesion.cliente = await db.obtenerCliente(c.id);
      return {
        reply: `✅ Listo, actualicé **${etiqueta}**: ${valor}`,
        tarjetas: [tarjetaDe(sesion.cliente)],
        opciones: [OP.EDITAR, ...accionesPara(sesion.cliente).filter((o) => o !== OP.EDITAR)].slice(0, 6),
      };
    }
    if (tipo === 'ot_activa') {
      const actualizado = await db.actualizarInteresado(c.id, {
        resultado: 'ot_activa',
        ot_activa_numero: datos.ot_activa_numero,
        ot_activa_estado: 'activa',
        ot_activa_fecha: new Date().toISOString(),
        ot_activa_respuesta: null,
        ot_activa_por: null,
        ot_activa_liberada_fecha: null,
      });
      sesion.cliente = { ...actualizado, venta: c.venta };
      return {
        reply: `🧾 Listo, quedó registrado con **OT activa ${datos.ot_activa_numero}**. Lo ves en la pestaña "OT" para hacerle seguimiento; cuando el back office la marque como liberada te aviso.`,
        tarjetas: [tarjetaDe(sesion.cliente)],
        opciones: [OP.RELLAMAR, OP.NUEVO, OP.MIS_OT],
      };
    }
    if (tipo === 'escalamiento') {
      const actualizado = await db.actualizarInteresado(c.id, {
        resultado: 'escalado',
        escalamiento_tipo: datos.escalamiento_tipo,
        escalamiento_detalle: datos.escalamiento_detalle,
        escalamiento_estado: 'pendiente',
        escalamiento_respuesta: null,
        escalamiento_por: null,
        escalamiento_fecha: new Date().toISOString(),
      });
      sesion.cliente = { ...actualizado, venta: c.venta };
      return {
        reply: `🛠 Listo, quedó escalado: **${datos.escalamiento_tipo}**. El back office lo ve en el panel y la respuesta te aparece en la ficha del cliente.`,
        tarjetas: [tarjetaDe(sesion.cliente)],
        opciones: [OP.RELLAMAR, OP.NUEVO, OP.BUSCAR],
      };
    }
    if (tipo === 'rellamar') {
      const actualizado = await db.actualizarInteresado(c.id, {
        resultado: 'volver_llamar',
        rellamar_fecha: datos.rellamar_fecha,
        rellamar_hora: datos.rellamar_hora,
        rellamar_nota: datos.rellamar_nota,
        rellamar_veces: (c.rellamar_veces || 0) + 1,
      });
      sesion.cliente = { ...actualizado, venta: c.venta };
      return {
        reply: `📞 Listo, quedó para volver a llamar **${textoRellamada(sesion.cliente)}**. Te lo recuerdo en "Mis rellamadas".`,
        tarjetas: [tarjetaDe(sesion.cliente)],
        opciones: [OP.NUEVO, OP.RELLAMADAS, OP.BUSCAR],
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

// "Ojo: este cliente lo está gestionando Ana Torres…"
const mismoAsesor = (a, b) => norm(a) === norm(b);
function quienGestiona(c) {
  const fecha = c.created_at
    ? new Date(c.created_at).toLocaleDateString('es-CO', { timeZone: 'America/Bogota', day: 'numeric', month: 'short' })
    : '';
  const estado = (ESTADOS[c.resultado] || 'En gestión').toLowerCase();
  return `**${c.asesor || 'otro asesor'}**${fecha ? ` (lo registró el ${fecha})` : ''} · estado: ${estado}`;
}
function avisoDuplicado(previos, asesor) {
  const deOtros = previos.filter((c) => c.asesor && !mismoAsesor(c.asesor, asesor));
  if (!deOtros.length) return '👀 Ojo: ese celular ya lo registraste antes. ¿Es el mismo cliente?';
  const c = deOtros[0];
  let txt = `⚠️ Ojo: este cliente ya lo está gestionando ${quienGestiona(c)}.`;
  if (c.resultado === 'venta') txt += '\n\nYa tiene una **venta registrada** por ese asesor.';
  return txt + '\n\n¿Es el mismo cliente?';
}

async function abrirCliente(sesion, cliente) {
  sesion.cliente = cliente;
  sesion.modo = 'libre';
  sesion.resultados = [];
  const pendiente = sesion.accionPendiente;
  sesion.accionPendiente = null;
  if (pendiente) {
    const inicio = await arrancarAccion(sesion, pendiente);
    return { ...inicio, tarjetas: [tarjetaDe(cliente)], reply: inicio.reply };
  }
  const otro = cliente.asesor && asesorActual && !mismoAsesor(cliente.asesor, asesorActual);
  return {
    reply:
      (otro ? `⚠️ Este cliente lo está gestionando ${quienGestiona(cliente)}.\n\n` : '') +
      `Este es el cliente${cliente.resultado === 'venta' ? ' — ya tiene venta registrada ✅' : ''}. ¿Qué hacemos?`,
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
  if (accion === 'no_venta') {
    // Sin preguntas: si campos.json no tiene campos para "no_venta", se registra de una vez.
    if (!(CAMPOS().no_venta || []).length) {
      sesion.modo = 'captura';
      sesion.captura = { tipo: 'no_venta', campos: [], paso: 0, datos: {} };
      return finalizarCaptura(sesion, asesorActual);
    }
    return iniciarCaptura(sesion, 'no_venta');
  }
  if (accion === 'cobertura') return iniciarCaptura(sesion, 'cobertura');
  if (accion === 'escalar') return iniciarCaptura(sesion, 'escalamiento');
  if (accion === 'editar') return pedirQueEditar(sesion);
  if (accion === 'ot_activa') {
    if (c.resultado === 'venta') return { reply: 'Este cliente ya tiene una venta registrada ✅.', opciones: [OP.NUEVO, OP.BUSCAR] };
    return iniciarCaptura(sesion, 'ot_activa');
  }
  if (accion === 'rellamar') {
    if (c.resultado === 'venta') return { reply: 'Este cliente ya tiene una venta registrada ✅.', opciones: [OP.NUEVO, OP.BUSCAR] };
    return iniciarCaptura(sesion, 'rellamar');
  }
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
    return { reply: 'No has registrado clientes en los últimos 7 días. Si buscas uno más antiguo, usa "Buscar cliente".', opciones: [OP.NUEVO, OP.BUSCAR] };
  }
  sesion.modo = 'seleccion';
  sesion.resultados = lista;
  return {
    reply: `Tus ${lista.length} cliente(s) de los últimos 7 días, del más reciente al más antiguo. Toca el que necesitas 👇 (o escribe parte del nombre). Para uno más antiguo usa "Buscar cliente".`,
    tarjetas: lista.map((c, i) => ({
      ...tarjetaDe(c),
      compacta: true,
      horaCorta: new Date(c.created_at).toLocaleString('es-CO', { timeZone: 'America/Bogota', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }),
      elegir: `${i + 1}. ${c.nombre_cliente || 'Sin nombre'}`,
    })),
    opciones: [OP.CANCELAR],
  };
}

// ---------------------------------------------------------------------------
// Mis rellamadas (pendientes de hoy y vencidas, y las próximas)
// ---------------------------------------------------------------------------
async function misRellamadas(sesion, asesor) {
  let lista;
  try {
    lista = await db.rellamadasPendientes(asesor);
  } catch (e) {
    console.error('Error rellamadas:', e);
    return { reply: `No pude traer las rellamadas (${e.message}).`, error: true };
  }
  if (!lista.length) {
    sesion.modo = 'libre';
    return { reply: 'No tienes rellamadas pendientes 🙌.', opciones: [OP.NUEVO, OP.HOY] };
  }
  const hoy = hoyCO();
  const paraHoy = lista.filter((c) => c.rellamar_fecha <= hoy).length;
  sesion.modo = 'seleccion';
  sesion.resultados = lista;
  return {
    reply:
      (paraHoy ? `📞 Tienes **${paraHoy}** rellamada(s) para hoy o atrasadas` : '📞 No tienes rellamadas para hoy') +
      ` y ${lista.length - paraHoy} próxima(s). Toca la que vas a llamar 👇`,
    tarjetas: lista.map((c, i) => ({
      ...tarjetaDe(c),
      compacta: true,
      horaCorta: (c.rellamar_fecha < hoy ? '⚠ ' : '') + textoRellamada(c),
      elegir: `${i + 1}. ${c.nombre_cliente || 'Sin nombre'}`,
    })),
    opciones: [OP.CANCELAR],
  };
}

// Las ventas se muestran como "clientes" (con su venta adentro) para poder abrir la ficha.
const ventaComoCliente = (v) => ({
  id: v.interesado_id || v.id,
  nombre_cliente: v.nombre_cliente,
  telefono: v.telefono,
  direccion: v.direccion,
  ciudad: v.ciudad,
  asesor: v.asesor,
  created_at: v.created_at,
  resultado: 'venta',
  venta: v,
});

async function misVentas(sesion, asesor) {
  let ventas;
  try {
    ventas = await db.ventasDeAsesor(asesor);
  } catch (e) {
    return { reply: `No pude traer tus ventas (${e.message}).`, error: true };
  }
  if (!ventas.length) {
    sesion.modo = 'libre';
    return { reply: 'Todavía no tienes ventas registradas en los últimos 45 días. ¡La primera está cerca! 💪', opciones: MENU };
  }
  const inst = ventas.filter((v) => v.estado_instalacion === 'instalada').length;
  const pend = ventas.filter((v) => !v.estado_instalacion || v.estado_instalacion === 'pendiente').length;
  const lista = ventas.map(ventaComoCliente);
  sesion.modo = 'seleccion';
  sesion.resultados = lista;
  return {
    reply: `🎉 Tus ventas (últimos 45 días): **${ventas.length}** · ✅ ${inst} instalada(s) · ⏳ ${pend} pendiente(s). Toca una para ver la ficha 👇`,
    tarjetas: lista.map((c, i) => ({ ...tarjetaDe(c), compacta: true, horaCorta: textoInstalacion(c.venta), elegir: `${i + 1}. ${c.nombre_cliente || 'Sin nombre'}` })),
    opciones: [OP.CANCELAR],
  };
}

async function misOtActivas(sesion, asesor) {
  let lista;
  try {
    lista = await db.otActivasDeAsesor(asesor);
  } catch (e) {
    return { reply: `No pude traer las OT activas (${e.message}).`, error: true };
  }
  if (!lista.length) {
    sesion.modo = 'libre';
    return { reply: 'No tienes clientes con OT activa. 🙌', opciones: MENU };
  }
  const lib = lista.filter((c) => c.ot_activa_estado === 'liberada').length;
  sesion.modo = 'seleccion';
  sesion.resultados = lista;
  return {
    reply: `🧾 Tienes **${lista.length - lib}** cliente(s) con OT activa${lib ? ` y **${lib}** ya liberada(s) ✅ (puedes retomar la venta)` : ''}. Toca uno para abrir la ficha 👇`,
    tarjetas: lista.map((c, i) => ({ ...tarjetaDe(c), compacta: true, horaCorta: `OT ${c.ot_activa_numero} · ${c.ot_activa_estado === 'liberada' ? '✅ liberada' : '⏳ activa'}`, elegir: `${i + 1}. ${c.nombre_cliente || 'Sin nombre'}` })),
    opciones: [OP.CANCELAR],
  };
}

async function misEscalamientos(sesion, asesor) {
  let lista;
  try {
    lista = await db.escalamientosDeAsesor(asesor);
  } catch (e) {
    return { reply: `No pude traer los escalamientos (${e.message}).`, error: true };
  }
  if (!lista.length) {
    sesion.modo = 'libre';
    return { reply: 'No tienes escalamientos. 🙌', opciones: MENU };
  }
  const pend = lista.filter((c) => c.escalamiento_estado !== 'resuelto').length;
  sesion.modo = 'seleccion';
  sesion.resultados = lista;
  return {
    reply: `🛠 Tienes **${pend}** escalamiento(s) pendiente(s) y ${lista.length - pend} resuelto(s) recientemente. Toca uno para abrir la ficha 👇`,
    tarjetas: lista.map((c, i) => ({ ...tarjetaDe(c), compacta: true, horaCorta: c.escalamiento_estado === 'resuelto' ? '✅ resuelto' : '⏳ pendiente', elegir: `${i + 1}. ${c.nombre_cliente || 'Sin nombre'}` })),
    opciones: [OP.CANCELAR],
  };
}

// ---------------------------------------------------------------------------
// Resumen
// ---------------------------------------------------------------------------
async function resumen(asesor, equipo, periodo = 'hoy') {
  try {
    const r = await db.resumenDeHoy(equipo ? null : asesor, periodo);
    const efect = r.interesados ? Math.round((r.ventas / r.interesados) * 100) : 0;
    const quien = equipo ? 'del equipo' : asesor ? `de ${asesor.split(' ')[0]}` : '';
    const esMes = periodo === 'mes';
    let reply = esMes ? `📊 Así va el mes ${quien}:` : `📊 Así va el día ${quien}:`;
    if (!r.interesados && !r.ventas) reply = esMes ? `📊 Este mes todavía no hay registros ${quien}.` : `📊 Hoy todavía no hay registros ${quien}. ¡A darle! 💪`;
    else if (r.enGestion) reply += `\n\nTienes **${r.enGestion}** interesado(s) todavía en gestión — búscalos para cerrarlos.`;
    return {
      reply,
      resumen: {
        titulo: esMes
          ? `Este mes · ${new Date().toLocaleDateString('es-CO', { timeZone: 'America/Bogota', month: 'long', year: 'numeric' })}`
          : `Hoy · ${new Date().toLocaleDateString('es-CO', { timeZone: 'America/Bogota', weekday: 'long', day: 'numeric', month: 'long' })}`,
        items: [
          { label: 'Interesados', valor: r.interesados },
          { label: 'Ventas', valor: r.ventas, destacado: true },
          { label: 'Efectividad', valor: `${efect}%` },
          { label: 'Con cobertura', valor: r.conCobertura },
          { label: 'Sin cobertura', valor: r.sinCobertura },
          { label: 'No se interesó', valor: r.noVenta },
          { label: 'Por rellamar', valor: r.porRellamar ?? 0 },
        ],
      },
      opciones: esMes ? [OP.RESUMEN, OP.RESUMEN_EQUIPO, OP.VENTAS] : equipo ? [OP.RESUMEN, OP.RESUMEN_MES, OP.NUEVO] : [OP.RESUMEN_MES, OP.RESUMEN_EQUIPO, OP.VENTAS],
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
let asesorActual = '';
async function manejar(sesion, asesor, texto) {
  asesorActual = asesor;
  const t = String(texto || '').trim();
  const n = norm(t);
  const nombre = asesor ? asesor.split(' ')[0] : '';

  if (t === '__inicio__') {
    let aviso = '';
    try {
      const pend = (await db.rellamadasPendientes(asesor)).filter((c) => c.rellamar_fecha <= hoyCO()).length;
      if (pend) aviso = `\n\n📞 Ojo: tienes **${pend}** rellamada(s) para hoy. Mírala(s) en la pestaña "Volver a llamar".`;
      const hace2 = Date.now() - 2 * 86400000;
      const nuevas = (await db.ventasDeAsesor(asesor)).filter((v) => v.estado_instalacion === 'instalada' && new Date(v.instalacion_fecha).getTime() > hace2).length;
      const otLib = (await db.otActivasDeAsesor(asesor)).filter((c) => c.ot_activa_estado === 'liberada' && Date.now() - new Date(c.ot_activa_liberada_fecha).getTime() < 2 * 86400000).length;
      if (otLib) aviso += `\n\n🧾 **${otLib}** cliente(s) con OT activa ya quedaron **liberados**. Mira la pestaña "OT" y retoma la venta.`;
      if (nuevas) aviso += `\n\n🎉 ¡Buenas noticias! **${nuevas}** de tus ventas quedó(aron) **instalada(s)**. Mira la pestaña "Ventas".`;
    } catch (_) {}
    return {
      reply:
        `¡Hola${nombre ? `, ${nombre}` : ''}! Soy **Marce**, tu asistente comercial 🙌. ` +
        'Cuando tengas un interesado dime "tengo un cliente interesado" y lo registramos. ' +
        'También puedo buscar un cliente (por nombre, celular o cédula), registrar la venta, ' +
        'programar una rellamada, ayudarte con objeciones o darte el resumen del día.' + aviso,
      opciones: MENU,
    };
  }
  if (t === '__nuevo__') {
    Object.assign(sesion, nuevaSesion());
    return { ...iniciarCaptura(sesion, 'interesado'), reply: '¡Vamos! 🙌 ' + CAMPOS().interesado[0].prompt };
  }

  // Abrir un cliente directo (desde las pestañas "Volver a llamar" / "Escalamientos" de la ventana)
  if (t.startsWith('__abrir__:')) {
    try {
      const cliente = await db.obtenerCliente(t.slice('__abrir__:'.length));
      sesion.captura = null;
      return abrirCliente(sesion, cliente);
    } catch (e) {
      return { reply: `No pude abrir ese cliente (${e.message}).`, error: true, opciones: MENU };
    }
  }

  const intencion = detectarIntencion(t);

  if (intencion === 'cancelar') {
    const habia = sesion.modo !== 'libre';
    sesion.modo = 'libre';
    sesion.captura = null;
    sesion.accionPendiente = null;
    return { reply: habia ? 'Listo, lo dejamos ahí. ¿Qué sigue?' : '¿En qué te ayudo?', opciones: sesion.cliente ? accionesPara(sesion.cliente) : MENU };
  }

  // Formulario a medias que ya no existe (cambió la configuración): se descarta sin error.
  if (sesion.modo === 'captura' && !sesion.captura?.campos?.[sesion.captura.paso]) {
    sesion.modo = 'libre';
    sesion.captura = null;
  }

  // --- Respondiendo un formulario ---
  if (sesion.modo === 'captura') {
    const cap = sesion.captura;
    const campo = cap.campos[cap.paso];
    const esOpcion = (campo.opciones || campo.opcionesSugeridas || []).some((o) => norm(o) === n);
    // Saltos explícitos de flujo (solo frases claras, para no confundir datos con comandos)
    if (!esOpcion && ['resumen', 'resumen_equipo', 'resumen_mes', 'buscar', 'nuevo', 'hoy', 'menu', 'rellamadas', 'escalamientos', 'misventas', 'misot'].includes(intencion) && n.split(' ').length <= 6) {
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

  // --- Eligiendo qué dato editar ---
  if (sesion.modo === 'editar_elegir') {
    const campo = editablesPara(sesion.cliente).find((f) => norm(f.label) === n || (norm(f.label).startsWith(n) && n.length >= 3));
    if (campo) {
      sesion.modo = 'captura';
      sesion.captura = { tipo: 'editar', campoId: campo.id, campos: [campo], paso: 0, datos: {} };
      const actual = valorActual(sesion.cliente, campo.id);
      const p = preguntar(campo, sesion.captura);
      return { ...p, progreso: undefined, reply: (actual ? `Ahora dice: **${actual}**\n\n` : '') + p.reply };
    }
    if (!intencion) return { ...pedirQueEditar(sesion), reply: 'Elige uno de los datos 👇' };
    sesion.modo = 'libre';
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
  if (intencion === 'resumen' || intencion === 'resumen_equipo' || intencion === 'resumen_mes') {
    sesion.modo = 'libre';
    return resumen(asesor, intencion === 'resumen_equipo', intencion === 'resumen_mes' ? 'mes' : 'hoy');
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
  if (intencion === 'rellamadas') return misRellamadas(sesion, asesor);
  if (intencion === 'escalamientos') return misEscalamientos(sesion, asesor);
  if (intencion === 'misventas') return misVentas(sesion, asesor);
  if (intencion === 'misot') return misOtActivas(sesion, asesor);
  if (intencion === 'venta' || intencion === 'no_venta' || intencion === 'cobertura' || intencion === 'rellamar' || intencion === 'escalar' || intencion === 'ot_activa' || intencion === 'editar') {
    if (!sesion.cliente) {
      sesion.accionPendiente = intencion;
      sesion.modo = 'buscar';
      const que = { venta: 'registrar la venta', no_venta: 'registrar que no se interesó', cobertura: 'actualizar la cobertura', rellamar: 'programar la rellamada', escalar: 'hacer el escalamiento', ot_activa: 'registrar la OT activa', editar: 'editar los datos' }[intencion];
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

// Pestañas de la ventana: "Volver a llamar" y "Escalamientos" del asesor.
app.get('/api/mis-pendientes', async (req, res) => {
  try {
    const asesor = String(req.query.asesor || '').trim();
    if (!asesor) return res.status(400).json({ error: 'Falta el asesor' });
    const [rell, escs, vts, ots] = await Promise.all([db.rellamadasPendientes(asesor), db.escalamientosDeAsesor(asesor), db.ventasDeAsesor(asesor), db.otActivasDeAsesor(asesor)]);
    const hoy = hoyCO();
    const corto = (c) => ({
      id: c.id,
      nombre: c.nombre_cliente || 'Sin nombre',
      telefono: c.telefono,
      direccion: [c.direccion, c.ciudad].filter(Boolean).join(' · '),
    });
    res.json({
      hoy,
      rellamadas: rell.map((c) => ({
        ...corto(c),
        fecha: c.rellamar_fecha,
        cuando: textoRellamada(c),
        nota: c.rellamar_nota && norm(c.rellamar_nota) !== 'ninguna' ? c.rellamar_nota : '',
        grupo: c.rellamar_fecha < hoy ? 'atrasada' : c.rellamar_fecha === hoy ? 'hoy' : 'proxima',
      })),
      escalamientos: escs.map((c) => ({
        ...corto(c),
        tipo: c.escalamiento_tipo,
        detalle: c.escalamiento_detalle,
        estado: c.escalamiento_estado === 'resuelto' ? 'resuelto' : 'pendiente',
        respuesta: c.escalamiento_respuesta,
        por: c.escalamiento_por,
        fecha: c.escalamiento_fecha,
      })),
      otActivas: ots.map((c) => ({
        ...corto(c),
        ot: c.ot_activa_numero,
        estado: c.ot_activa_estado === 'liberada' ? 'liberada' : 'activa',
        respuesta: c.ot_activa_respuesta,
        por: c.ot_activa_por,
        fecha: c.ot_activa_fecha,
        liberadaReciente: c.ot_activa_estado === 'liberada' && Date.now() - new Date(c.ot_activa_liberada_fecha).getTime() < 2 * 86400000,
      })),
      ventas: vts.map((v) => ({
        id: v.interesado_id || v.id,
        nombre: v.nombre_cliente || 'Sin nombre',
        telefono: v.telefono,
        direccion: [v.direccion, v.ciudad].filter(Boolean).join(' · '),
        plan: v.plan,
        ot: v.numero_ot,
        agenda: [v.fecha_agenda, v.hora_agenda].filter(Boolean).join(' · '),
        estado: v.estado_instalacion || 'pendiente',
        estadoTexto: textoInstalacion(v),
        nota: v.instalacion_nota,
        instaladaReciente: v.estado_instalacion === 'instalada' && Date.now() - new Date(v.instalacion_fecha).getTime() < 2 * 86400000,
        fecha: v.created_at,
      })),
    });
  } catch (err) {
    console.error('Error mis-pendientes:', err);
    res.status(500).json({ error: err.message });
  }
});

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

app.post('/api/panel/ot', exigirClave, async (req, res) => {
  try {
    const { id, estado, respuesta, auditor } = req.body || {};
    if (!id || !['liberada', 'activa'].includes(estado)) return res.status(400).json({ error: 'Falta id o el estado no es válido.' });
    const interesado = await db.actualizarInteresado(id, {
      ot_activa_estado: estado,
      ot_activa_respuesta: respuesta || null,
      ot_activa_por: estado === 'liberada' ? auditor || null : null,
      ot_activa_liberada_fecha: estado === 'liberada' ? new Date().toISOString() : null,
    });
    res.json({ ok: true, interesado });
  } catch (err) {
    console.error('Error panel/ot:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/panel/instalacion', exigirClave, async (req, res) => {
  try {
    const { id, estado, nota, auditor } = req.body || {};
    if (!id || !['instalada', 'no_instalada', 'pendiente'].includes(estado)) return res.status(400).json({ error: 'Falta id o el estado no es válido.' });
    const venta = await db.actualizarVenta(id, {
      estado_instalacion: estado,
      instalacion_nota: nota || null,
      instalacion_por: estado === 'pendiente' ? null : auditor || null,
      instalacion_fecha: estado === 'pendiente' ? null : new Date().toISOString(),
    });
    res.json({ ok: true, venta });
  } catch (err) {
    console.error('Error panel/instalacion:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/panel/escalamiento', exigirClave, async (req, res) => {
  try {
    const { id, estado, respuesta, auditor } = req.body || {};
    if (!id || !['resuelto', 'pendiente'].includes(estado)) return res.status(400).json({ error: 'Falta id o el estado no es válido.' });
    const interesado = await db.actualizarInteresado(id, {
      escalamiento_estado: estado,
      escalamiento_respuesta: respuesta || null,
      escalamiento_por: estado === 'resuelto' ? auditor || null : null,
      escalamiento_resuelto_fecha: estado === 'resuelto' ? new Date().toISOString() : null,
    });
    res.json({ ok: true, interesado });
  } catch (err) {
    console.error('Error panel/escalamiento:', err);
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
    captura: captura ? { tipo: captura.tipo, paso: captura.paso, datos: captura.datos, campoId: captura.campoId } : null,
  };
}
function hidratar(estado) {
  if (!estado || typeof estado !== 'object') return null;
  const sesion = { ...nuevaSesion(), ...estado };
  if (sesion.captura) {
    const campos = sesion.captura.tipo === 'editar'
      ? [campoEditable(sesion.captura.campoId)].filter(Boolean)
      : CAMPOS()[sesion.captura.tipo];
    // Si el formulario cambió o quedó vacío (ej. "no_venta" ya no pide datos), se descarta.
    if (!Array.isArray(campos) || !campos.length) sesion.captura = null;
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
