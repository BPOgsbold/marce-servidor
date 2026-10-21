-- Usuarios del panel (con perfil) e historial de cambios. Se corre UNA sola vez.
create table if not exists panel_usuarios (
  usuario text primary key,
  nombre text not null,
  perfil text not null default 'backoffice',   -- admin | supervisor | backoffice | torre | consulta
  hash text not null,
  activo boolean not null default true,
  ultimo_ingreso timestamptz,
  creado timestamptz default now(),
  actualizado timestamptz default now()
);
alter table panel_usuarios enable row level security;

create table if not exists panel_historial (
  id bigint generated always as identity primary key,
  fecha timestamptz default now(),
  usuario text,
  nombre text,
  perfil text,
  accion text,
  registro text,
  detalle jsonb
);
alter table panel_historial enable row level security;
create index if not exists idx_historial_fecha on panel_historial (fecha desc);
