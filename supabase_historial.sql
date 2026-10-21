-- Historial de cambios propio de Marce (la tabla panel_historial ya existía y es de otra aplicación). Se corre UNA sola vez.
create table if not exists marce_historial (
  id bigint generated always as identity primary key,
  fecha timestamptz default now(),
  usuario text,
  nombre text,
  perfil text,
  accion text,
  registro text,
  detalle jsonb
);
alter table marce_historial enable row level security;
create index if not exists idx_marce_historial_fecha on marce_historial (fecha desc);
