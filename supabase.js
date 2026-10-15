const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

let client = null;
function getClient() {
  if (!client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error('Falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en el archivo .env');
    }
    client = createClient(url, key);
  }
  return client;
}

// Columnas fijas de cada tabla. Todo lo demás se guarda igual en "datos" (jsonb),
// así que agregar campos en config/campos.json nunca rompe el guardado.
const COLS_INTERESADO = {
  direccion: 'direccion',
  nombre_cliente: 'nombre_cliente',
  telefono: 'telefono',
  cobertura: 'cobertura_validada',
  ciudad: 'ciudad',
};
const COLS_VENTA = [
  'nombre_cliente', 'cedula', 'telefono', 'direccion', 'barrio', 'ciudad', 'plan',
  'numero_ot', 'numero_cuenta', 'fecha_agenda', 'hora_agenda', 'observaciones',
];

// Inicio del día de hoy en hora Colombia (UTC-5), en ISO.
function inicioDeHoy() {
  const ahora = new Date(Date.now() - 5 * 3600 * 1000);
  return `${ahora.toISOString().slice(0, 10)}T00:00:00-05:00`;
}

async function crearInteresado(asesor, datos) {
  const supabase = getClient();
  const row = { session_id: crypto.randomUUID(), asesor: asesor || null, datos };
  for (const [campo, col] of Object.entries(COLS_INTERESADO)) {
    if (campo in datos) row[col] = datos[campo];
  }
  const { data, error } = await supabase.from('interesados').insert(row).select().single();
  if (error) throw error;
  return data;
}

async function actualizarInteresado(id, cambios) {
  const supabase = getClient();
  const { data, error } = await supabase
    .from('interesados')
    .update({ ...cambios, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function guardarVenta(asesor, cliente, datos) {
  const supabase = getClient();
  const completo = {
    nombre_cliente: cliente.nombre_cliente,
    telefono: cliente.telefono,
    direccion: cliente.direccion,
    ...datos,
  };
  const row = {
    session_id: crypto.randomUUID(),
    asesor: asesor || null,
    interesado_id: cliente.id,
    datos: completo,
  };
  for (const col of COLS_VENTA) if (completo[col] != null) row[col] = completo[col];
  const { data, error } = await supabase.from('ventas').insert(row).select().single();
  if (error) throw error;
  return data;
}

// Le pega a cada cliente su venta más reciente (si tiene).
async function adjuntarVentas(clientes) {
  if (!clientes.length) return clientes;
  const supabase = getClient();
  const { data, error } = await supabase
    .from('ventas')
    .select('*')
    .in('interesado_id', clientes.map((c) => c.id))
    .order('created_at', { ascending: false });
  if (error) throw error;
  return clientes.map((c) => ({ ...c, venta: (data || []).find((v) => v.interesado_id === c.id) || null }));
}

async function obtenerCliente(id) {
  const supabase = getClient();
  const { data, error } = await supabase.from('interesados').select('*').eq('id', id).single();
  if (error) throw error;
  return (await adjuntarVentas([data]))[0];
}

/**
 * Busca clientes por nombre, teléfono, dirección o cédula (la cédula vive en
 * la tabla de ventas). Devuelve hasta 5, priorizando los que coinciden con
 * todas las palabras buscadas.
 */
async function buscarClientes(termino) {
  const supabase = getClient();
  const limpio = String(termino || '').replace(/[%,()]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!limpio) return [];
  const digitos = limpio.replace(/\D/g, '');
  const palabras = limpio.split(' ').filter((p) => p.length >= 2);

  const filtros = palabras.map((p) => `nombre_cliente.ilike.%${p}%`);
  filtros.push(`direccion.ilike.%${limpio}%`);
  if (digitos.length >= 6) filtros.push(`telefono.eq.${digitos}`);

  const { data, error } = await supabase
    .from('interesados')
    .select('*')
    .or(filtros.join(','))
    .order('created_at', { ascending: false })
    .limit(40);
  if (error) throw error;
  let filas = data || [];

  if (digitos.length >= 6) {
    const { data: vts, error: e2 } = await supabase.from('ventas').select('interesado_id').eq('cedula', digitos);
    if (e2) throw e2;
    const ids = (vts || []).map((v) => v.interesado_id).filter((id) => id && !filas.some((f) => f.id === id));
    if (ids.length) {
      const { data: extra, error: e3 } = await supabase.from('interesados').select('*').in('id', ids);
      if (e3) throw e3;
      filas = [...(extra || []), ...filas];
    }
  }

  const sinTildes = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const puntaje = (f) => {
    if (digitos.length >= 6 && f.telefono === digitos) return 100;
    const nombre = sinTildes(f.nombre_cliente);
    return palabras.filter((p) => nombre.includes(sinTildes(p))).length;
  };
  filas.sort((a, b) => puntaje(b) - puntaje(a));
  return adjuntarVentas(filas.slice(0, 5));
}

async function buscarPorTelefono(telefono) {
  const supabase = getClient();
  const { data, error } = await supabase
    .from('interesados')
    .select('*')
    .eq('telefono', telefono)
    .order('created_at', { ascending: false })
    .limit(3);
  if (error) throw error;
  return adjuntarVentas(data || []);
}

/** Clientes registrados hoy por el asesor (los más recientes primero). */
async function clientesDeHoy(asesor) {
  const supabase = getClient();
  let q = supabase.from('interesados').select('*').gte('created_at', inicioDeHoy()).order('created_at', { ascending: false }).limit(30);
  if (asesor) q = q.eq('asesor', asesor);
  const { data, error } = await q;
  if (error) throw error;
  return adjuntarVentas(data || []);
}

/** Rellamadas pendientes del asesor (de hoy, atrasadas y próximas), en orden de fecha. */
async function rellamadasPendientes(asesor) {
  const supabase = getClient();
  let q = supabase
    .from('interesados')
    .select('*')
    .eq('resultado', 'volver_llamar')
    .order('rellamar_fecha', { ascending: true })
    .limit(40);
  if (asesor) q = q.eq('asesor', asesor);
  const { data, error } = await q;
  if (error) throw error;
  return adjuntarVentas(data || []);
}

/** Números de hoy. Si se pasa asesor, solo los de ese asesor. */
async function resumenDeHoy(asesor) {
  const supabase = getClient();
  const desde = inicioDeHoy();

  let q1 = supabase.from('interesados').select('cobertura_validada,resultado').gte('created_at', desde);
  if (asesor) q1 = q1.eq('asesor', asesor);
  const { data: ints, error: e1 } = await q1;
  if (e1) throw e1;

  let q2 = supabase.from('ventas').select('id', { count: 'exact', head: true }).gte('created_at', desde);
  if (asesor) q2 = q2.eq('asesor', asesor);
  const { count: ventas, error: e2 } = await q2;
  if (e2) throw e2;

  const lista = ints || [];
  const esSi = (v) => /^s[ií]$/i.test(String(v || ''));
  return {
    interesados: lista.length,
    conCobertura: lista.filter((i) => esSi(i.cobertura_validada)).length,
    sinCobertura: lista.filter((i) => String(i.cobertura_validada || '').toLowerCase() === 'no').length,
    ventas: ventas || 0,
    noVenta: lista.filter((i) => i.resultado === 'no_venta').length,
    enGestion: lista.filter((i) => !i.resultado || i.resultado === 'en_gestion').length,
    porRellamar: lista.filter((i) => i.resultado === 'volver_llamar').length,
  };
}

// ---------------------------------------------------------------------------
// Panel web (back office)
// ---------------------------------------------------------------------------

/** Interesados (con su venta) y ventas creados entre dos fechas ISO. */
async function panelDatos(desde, hasta) {
  const supabase = getClient();
  const traer = async (tabla) => {
    let filas = [];
    for (let desdeFila = 0; desdeFila < 20000; desdeFila += 1000) {
      const { data, error } = await supabase
        .from(tabla)
        .select('*')
        .gte('created_at', desde)
        .lt('created_at', hasta)
        .order('created_at', { ascending: false })
        .range(desdeFila, desdeFila + 999);
      if (error) throw error;
      filas = filas.concat(data || []);
      if (!data || data.length < 1000) break;
    }
    return filas;
  };
  const [interesados, ventas] = await Promise.all([traer('interesados'), traer('ventas')]);
  // Ventas de cualquier fecha para los interesados del rango (para mostrar su estado completo).
  const conVenta = [];
  for (let i = 0; i < interesados.length; i += 300) {
    conVenta.push(...(await adjuntarVentas(interesados.slice(i, i + 300))));
  }
  const { data: rell, error: eR } = await supabase
    .from('interesados')
    .select('*')
    .eq('resultado', 'volver_llamar')
    .order('rellamar_fecha', { ascending: true })
    .limit(3000);
  if (eR) throw eR;
  const { data: esc, error: eE } = await supabase
    .from('interesados')
    .select('*')
    .not('escalamiento_tipo', 'is', null)
    .order('escalamiento_fecha', { ascending: false })
    .limit(3000);
  if (eE) throw eE;
  return { interesados: conVenta, ventas, rellamadas: rell || [], escalamientos: esc || [] };
}

/** Registra la auditoría de cobertura hecha por el back office. */
async function auditarCobertura(id, { resultado, nota, auditor }) {
  return actualizarInteresado(id, {
    auditoria_cobertura: resultado, // 'confirmada' | 'sin_cobertura' | 'pendiente'
    auditoria_nota: nota || null,
    auditoria_por: auditor || null,
    auditoria_fecha: resultado === 'pendiente' ? null : new Date().toISOString(),
  });
}

module.exports = {
  panelDatos,
  auditarCobertura,
  crearInteresado,
  actualizarInteresado,
  guardarVenta,
  obtenerCliente,
  buscarClientes,
  buscarPorTelefono,
  resumenDeHoy,
  clientesDeHoy,
  rellamadasPendientes,
};
