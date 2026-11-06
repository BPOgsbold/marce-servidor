-- Histórico del embudo: resumen pequeño por día y campaña (lo calcula el servidor una sola vez)
alter table marce_ocm_dia add column if not exists resumen jsonb;
