-- Embudo de gestión: base diaria del marcador OCM (una fila por día y campaña)
create table if not exists marce_ocm_dia (
  dia date not null,
  campana text not null default '',
  cubo jsonb not null default '[]'::jsonb,
  filas jsonb not null default '[]'::jsonb,
  total integer,
  archivo text,
  cargado_por text,
  actualizado timestamptz default now(),
  primary key (dia, campana)
);
alter table marce_ocm_dia enable row level security;
