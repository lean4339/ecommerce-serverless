WITH variant_stock AS (
   SELECT v.product_id,min(v.price_cents) AS price_cents,sum(greatest(coalesce(s.available_units,0),0)) AS available_units
   FROM product_variants v LEFT JOIN (SELECT variant_id,sum(greatest(quantity-reserved,0)) AS available_units FROM inventory GROUP BY variant_id) s ON s.variant_id=v.id GROUP BY v.product_id
  ), ratings AS (SELECT product_id,round(avg(rating),2) AS rating,count(*) AS review_count FROM reviews GROUP BY product_id),
  sales AS (SELECT v.product_id,sum(i.quantity) AS sold_units FROM order_items i JOIN orders o ON o.id=i.order_id AND o.status IN ('paid','shipped','delivered') JOIN product_variants v ON v.id=i.variant_id GROUP BY v.product_id),
  activity AS (SELECT product_id,count(*) AS views FROM browsing_events WHERE event_type='view' GROUP BY product_id),
  matched AS MATERIALIZED (
   SELECT p.id,p.name,p.created_at,p.category_id,c.name AS category_name,b.name AS brand_name,
   coalesce(v.price_cents,p.base_price_cents) AS price_cents,coalesce(v.available_units,0) AS available_units,
   r.rating,coalesce(r.review_count,0) AS review_count,coalesce(s.sold_units,0) AS sold_units,coalesce(a.views,0) AS views
   FROM products p JOIN categories c ON c.id=p.category_id JOIN brands b ON b.id=p.brand_id
   LEFT JOIN variant_stock v ON v.product_id=p.id LEFT JOIN ratings r ON r.product_id=p.id
   LEFT JOIN sales s ON s.product_id=p.id LEFT JOIN activity a ON a.product_id=p.id WHERE p.status='active'
  ), paged AS (SELECT * FROM matched ORDER BY sold_units DESC,id LIMIT $1 OFFSET $2)
  SELECT paged.*,totals.total FROM (SELECT count(*)::text AS total FROM matched) totals LEFT JOIN paged ON true ORDER BY sold_units DESC,id