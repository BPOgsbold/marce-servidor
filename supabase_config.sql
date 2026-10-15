-- Interruptores que el back office prende/apaga desde el panel.
-- Ej.: 'ventas_fecha_anterior' = permitir registrar ventas de días anteriores.
create table if not exists marce_config (
  clave text primary key,
  valor jsonb,
  por text,
  actualizado timestamptz default now()
);
alter table marce_config enable row level security;
