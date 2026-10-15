import { lambda, json, type Operation } from '../shared/http.js';
import { useDynamo } from '../shared/dynamo.js';
import { filtersDynamo } from '../shared/dynamo-store.js';
export const execute: Operation = async (_event, { pool }) => {
  if (useDynamo()) {
    // Conteos y orden (collation de PostgreSQL) precalculados por la migración.
    const items = await filtersDynamo();
    const byRank = (a: Record<string, unknown>, b: Record<string, unknown>) =>
      Number(a.rank) - Number(b.rank);
    return json({
      categories: items
        .filter((i) => String(i.SK).startsWith('CAT#'))
        .sort(byRank)
        .map((c) => ({
          id: String(c.categoryId),
          name: c.name,
          parent_id: c.parentId === undefined ? null : String(c.parentId),
          products: String(c.products ?? '0'),
        })),
      brands: items
        .filter((i) => String(i.SK).startsWith('BRAND#') && Number(i.products ?? 0) > 0)
        .sort(byRank)
        .map((b) => ({ id: String(b.brandId), name: b.name, products: String(b.products) })),
    });
  }
  const [categories, brands] = await Promise.all([
    pool.query(
      "SELECT c.id,c.name,c.parent_id,count(p.id)::text AS products FROM categories c LEFT JOIN products p ON p.category_id=c.id AND p.status='active' GROUP BY c.id ORDER BY c.name",
    ),
    pool.query(
      "SELECT b.id,b.name,count(p.id)::text AS products FROM brands b JOIN products p ON p.brand_id=b.id AND p.status='active' GROUP BY b.id ORDER BY b.name",
    ),
  ]);
  return json({ categories: categories.rows, brands: brands.rows });
};
export const handler = lambda('get-filters', execute);
