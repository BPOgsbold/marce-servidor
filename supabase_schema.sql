-- Ejecuta esto en el SQL Editor de Supabase (versión 3 · Marce).
-- Es seguro correrlo varias veces: solo crea o agrega lo que falte.
-- No borra datos.

-- 1) Interesados (lo que registra "Tengo un cliente interesado")
create table if not exists interesados (
  id uuid primary key default gen_random_uuid(),
  session_id text not null,
  asesor text,
  ciudad text,
  direccion text,
  cobertura_validada text, -- 'sí' | 'no'
  resultado text not null default 'en_gestion', -- 'en_gestion' | 'venta' | 'no_venta'
  motivo_no_interes text,
  observaciones text,
  datos jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table interesados add column if not exists nombre_cliente text;
alter table interesados add column if not exists telefono text;

-- 2) Ventas (lo que registra "Registrar venta", enlazado al interesado)
create table if not exists ventas (
  id uuid primary key default gen_random_uuid(),
  interesado_id uuid references interesados(id),
  session_id text not null,
  asesor text,
  nombre_cliente text,
  cedula text,
  telefono text,
  direccion text,
  barrio text,
  ciudad text,
  plan text,
  numero_ot text,
  numero_cuenta text,
  fecha_agenda text,
  hora_agenda text,
  observaciones text,
  datos jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- 3) Índices para que la búsqueda y el resumen sean rápidos
create index if not exists idx_interesados_asesor on interesados (asesor);
create index if not exists idx_interesados_telefono on interesados (telefono);
create index if not exists idx_interesados_created on interesados (created_at desc);
create index if not exists idx_interesados_resultado on interesados (resultado);
create index if not exists idx_ventas_interesado on ventas (interesado_id);
create index if not exists idx_ventas_cedula on ventas (cedula);
create index if not exists idx_ventas_created on ventas (created_at desc);
