-- Marce Móvil: cada interesado y venta queda marcado con su línea (hogar / movil)
alter table interesados add column if not exists linea text default 'hogar';
alter table ventas add column if not exists linea text default 'hogar';
