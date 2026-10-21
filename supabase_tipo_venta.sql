-- Tipo de venta (In Hogar, Out Hogar, Recuperacion…). Se corre UNA sola vez.
alter table ventas add column if not exists tipo_venta text;
