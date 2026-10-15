import { HttpError } from '../db.js';
import { lambda, json, identifier, type Operation } from '../shared/http.js';
import { queryAll, str, useDynamo } from '../shared/dynamo.js';

// DynamoDB: PRODUCT#<id> trae META (con reseñas y relacionados precalculados) y sus VARIANT#.
async function productDynamo(key: string) {
  const items = await queryAll({
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': `PRODUCT#${key}` },
  });
  const p = items.find((i) => i.SK === 'META');
  if (!p || p.status !== 'active') {
    throw new HttpError(404, 'Producto no disponible');
  }
  return {
    id: String(p.productId),
    name: str(p.name),
    description: str(p.description),
    base_price_cents: str(p.basePriceCents),
    category_id: str(p.categoryId),
    category_name: str(p.categoryName),
    brand_name: str(p.brandName),
    seller_name: str(p.sellerName),
    variants: items
      .filter((i) => String(i.SK).startsWith('VARIANT#'))
      .map((v) => ({
        id: String(v.variantId),
        sku: str(v.sku),
        color: str(v.color),
        size: str(v.size),
        price_cents: str(v.priceCents),
        available_units: String(Math.max(0, Number(v.stock ?? 0))),
      })),
    // Los mapas de DynamoDB no conservan el orden de claves: se reconstruye igual que en SQL.
    reviews: ((p.reviews as Record<string, unknown>[] | undefined) ?? []).map((r) => ({
      id: String(r.id),
      rating: r.rating ?? null,
      title: r.title ?? null,
      body: r.body ?? null,
      author: r.author ?? null,
    })),
    related: ((p.related as Record<string, unknown>[] | undefined) ?? []).map((r) => ({
      id: String(r.id),
      name: r.name ?? null,
      base_price_cents: str(r.base_price_cents),
    })),
  };
}

export const execute: Operation = async (event, { pool }) => {
  const key = identifier(event.pathParameters?.id);
  if (useDynamo()) {
    return json({ data: await productDynamo(key) });
  }
  const product = await pool.query(
    "SELECT p.id,p.name,p.description,p.base_price_cents,p.category_id,c.name AS category_name,b.name AS brand_name,s.name AS seller_name FROM products p JOIN categories c ON c.id=p.category_id JOIN brands b ON b.id=p.brand_id JOIN sellers s ON s.id=p.seller_id WHERE p.id=$1 AND p.status='active'",
    [key],
  );
  if (!product.rows[0]) {
    throw new HttpError(404, 'Producto no disponible');
  }
  const [variants, reviews, related] = await Promise.all([
    pool.query(
      'SELECT v.id,v.sku,v.color,v.size,v.price_cents,coalesce(sum(greatest(i.quantity-i.reserved,0)),0)::text AS available_units FROM product_variants v LEFT JOIN inventory i ON i.variant_id=v.id WHERE v.product_id=$1 GROUP BY v.id ORDER BY v.id',
      [key],
    ),
    pool.query(
      'SELECT r.id,r.rating,r.title,r.body,u.full_name AS author FROM reviews r JOIN users u ON u.id=r.user_id WHERE r.product_id=$1 ORDER BY r.created_at DESC,r.id DESC LIMIT 12',
      [key],
    ),
    pool.query(
      "SELECT id,name,base_price_cents FROM products WHERE category_id=$1 AND id<>$2 AND status='active' ORDER BY id LIMIT 4",
      [product.rows[0].category_id, key],
    ),
  ]);
  return json({
    data: {
      ...product.rows[0],
      variants: variants.rows,
      reviews: reviews.rows,
      related: related.rows,
    },
  });
};
export const handler = lambda('get-product', execute);
