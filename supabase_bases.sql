-- Gestión base de datos: bases preparadas por día y sub-base (archivo). Se corre UNA sola vez.
create table if not exists marce_base_dia (
  dia date not null,
  archivo text not null,
  fuente text,
  canal text,
  campana text,
  resumen jsonb not null default '{}'::jsonb,
  tels text not null default '',
  total integer,
  archivo_origen text,
  cargado_por text,
  actualizado timestamptz default now(),
  primary key (dia, archivo)
);
alter table marce_base_dia enable row level security;
-- Teléfonos marcados por OCM (para cruzarlos con las bases)
alter table marce_ocm_dia add column if not exists marcados text;
