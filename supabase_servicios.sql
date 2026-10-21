-- Servicios vendidos y multiasistencia (se corre UNA sola vez).
alter table ventas add column if not exists servicios_vendidos text;
alter table ventas add column if not exists multiasistencia text;
alter table ventas add column if not exists multiasistencia_cual text;
