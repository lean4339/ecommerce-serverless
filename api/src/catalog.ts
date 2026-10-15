import { HttpError, id } from './db.js';
export interface CatalogQuery {
  q?: string;
  category_id?: string;
  brand_id?: string;
  sort?: string;
  page?: number;
  limit?: number;
  min_cents?: string;
  max_cents?: string;
  min_rating?: number;
  in_stock?: boolean;
}
export function catalogQuery(q: CatalogQuery) {
  const values: unknown[] = [];
  const where = ["p.status='active'"];
  const metricWhere: string[] = [];
  const bind = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };
  if (q.q?.trim()) {
    const search = bind(`%${q.q.trim().replace(/[\\%_]/g, '\\$&')}%`);
    where.push(`(p.name ILIKE ${search} OR p.description ILIKE ${search})`);
  }
  if (q.category_id) {
    where.push(
      `p.category_id IN (WITH RECURSIVE descendants AS (SELECT id,ARRAY[id] AS path FROM categories WHERE id=${bind(id(q.category_id))} UNION ALL SELECT c.id,d.path||c.id FROM categories c JOIN descendants d ON c.parent_id=d.id WHERE NOT c.id=ANY(d.path)) SELECT id FROM descendants)`,
    );
  }
  if (q.brand_id) {
    where.push(`p.brand_id=${bind(id(q.brand_id))}`);
  }
  for (const field of ['min_cents', 'max_cents'] as const) {
    if (q[field] !== undefined) {
      id(q[field], true);
      metricWhere.push(
        `coalesce(v.price_cents,p.base_price_cents) ${field === 'min_cents' ? '>=' : '<='} ${bind(q[field])}`,
      );
    }
  }
  if (q.min_cents && q.max_cents && BigInt(q.min_cents) > BigInt(q.max_cents)) {
    throw new HttpError(400, 'El precio mínimo supera al máximo');
  }
  if (q.min_rating !== undefined) {
    metricWhere.push(`coalesce(r.rating,0)>=${bind(q.min_rating)}`);
  }
  if (q.in_stock) {
    metricWhere.push('coalesce(v.available_units,0)>0');
  }
  const sort = q.sort ?? 'popular';
  const limit = q.limit ?? 24;
  const page = q.page ?? 1;
  const order: Record<string, string> = {
    popular: 'sold_units DESC,id',
    trending: 'views DESC,id',
    price_asc: 'price_cents ASC,id',
    price_desc: 'price_cents DESC,id',
    rating: 'rating DESC NULLS LAST,review_count DESC,id',
    newest: 'created_at DESC,id',
  };
  if (!order[sort]) {
    throw new HttpError(400, 'Orden inválido');
  }
  const needed = {
    stock:
      sort.startsWith('price_') ||
      q.in_stock ||
      q.min_cents !== undefined ||
      q.max_cents !== undefined,
    ratings: sort === 'rating' || q.min_rating !== undefined,
    sales: sort === 'popular',
    activity: sort === 'trending',
  };
  const limitBind = bind(limit);
  const offsetBind = bind((page - 1) * limit);
  const aggregates = {
    stock: (scope: string) =>
      `SELECT v.product_id,min(v.price_cents) AS price_cents,sum(greatest(coalesce(i.quantity-i.reserved,0),0)) AS available_units FROM product_variants v JOIN ${scope} x ON x.id=v.product_id LEFT JOIN inventory i ON i.variant_id=v.id GROUP BY v.product_id`,
    ratings: (scope: string) =>
      `SELECT r.product_id,round(avg(r.rating),2) AS rating,count(*) AS review_count FROM reviews r JOIN ${scope} x ON x.id=r.product_id GROUP BY r.product_id`,
    sales: (scope: string) =>
      `SELECT v.product_id,sum(i.quantity) AS sold_units FROM order_items i JOIN orders o ON o.id=i.order_id AND o.status IN ('paid','shipped','delivered') JOIN product_variants v ON v.id=i.variant_id JOIN ${scope} x ON x.id=v.product_id GROUP BY v.product_id`,
    activity: (scope: string) =>
      `SELECT a.product_id,count(*) AS views FROM browsing_events a JOIN ${scope} x ON x.id=a.product_id WHERE a.event_type='view' GROUP BY a.product_id`,
  };
  // Candidates sólo guarda IDs: el total exacto no materializa nombres ni todas las métricas.
  const candidateColumns = [
    'p.id',
    ...(needed.stock ? ['p.base_price_cents'] : []),
    ...(sort === 'newest' ? ['p.created_at'] : []),
  ].join(',');
  const ctes = [
    `candidates AS MATERIALIZED (SELECT ${candidateColumns} FROM products p WHERE ${where.join(' AND ')})`,
  ];
  for (const key of Object.keys(aggregates) as (keyof typeof aggregates)[]) {
    if (needed[key]) {
      ctes.push(`${key}_rank AS MATERIALIZED (${aggregates[key]('candidates')})`);
    }
  }
  const joins = [
    needed.stock ? 'LEFT JOIN stock_rank v ON v.product_id=p.id' : '',
    needed.ratings ? 'LEFT JOIN ratings_rank r ON r.product_id=p.id' : '',
    needed.sales ? 'LEFT JOIN sales_rank s ON s.product_id=p.id' : '',
    needed.activity ? 'LEFT JOIN activity_rank a ON a.product_id=p.id' : '',
  ].join(' ');
  const rankColumns: Record<string, string> = {
    popular: 'coalesce(s.sold_units,0) AS sold_units',
    trending: 'coalesce(a.views,0) AS views',
    price_asc: 'coalesce(v.price_cents,p.base_price_cents) AS price_cents',
    price_desc: 'coalesce(v.price_cents,p.base_price_cents) AS price_cents',
    rating: 'r.rating,coalesce(r.review_count,0) AS review_count',
    newest: 'p.created_at',
  };
  ctes.push(
    `eligible AS MATERIALIZED (SELECT p.id,${rankColumns[sort]} FROM candidates p ${joins} ${metricWhere.length ? 'WHERE ' + metricWhere.join(' AND ') : ''})`,
  );
  ctes.push(
    `paged AS MATERIALIZED (SELECT * FROM eligible ORDER BY ${order[sort]} LIMIT ${limitBind} OFFSET ${offsetBind})`,
  );
  for (const key of Object.keys(aggregates) as (keyof typeof aggregates)[]) {
    ctes.push(
      `${key}_page AS (${needed[key] ? `SELECT m.* FROM ${key}_rank m JOIN paged x ON x.id=m.product_id` : aggregates[key]('paged')})`,
    );
  }
  ctes.push(
    `details AS (SELECT p.id,p.name,p.created_at,p.category_id,c.name AS category_name,b.name AS brand_name,coalesce(v.price_cents,p.base_price_cents) AS price_cents,coalesce(v.available_units,0) AS available_units,r.rating,coalesce(r.review_count,0) AS review_count,coalesce(s.sold_units,0) AS sold_units,coalesce(a.views,0) AS views FROM paged x JOIN products p ON p.id=x.id JOIN categories c ON c.id=p.category_id JOIN brands b ON b.id=p.brand_id LEFT JOIN stock_page v ON v.product_id=p.id LEFT JOIN ratings_page r ON r.product_id=p.id LEFT JOIN sales_page s ON s.product_id=p.id LEFT JOIN activity_page a ON a.product_id=p.id)`,
  );
  return {
    sql: `WITH ${ctes.join(',\n')} SELECT details.*,totals.total FROM (SELECT count(*)::text AS total FROM eligible) totals LEFT JOIN details ON true ORDER BY ${order[sort]}`,
    values,
    page,
    limit,
  };
}
