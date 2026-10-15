let faker;
export async function loadFaker() {
  ({ faker } = await import('@faker-js/faker'));
}
// Orden topológico: todas las referencias apuntan a tablas anteriores.
export const profiles = {
  tiny: { users: 12, products: 15, orders: 24, events: 50 },
  small: { users: 1000, products: 2000, orders: 10000, events: 50000 },
  million: { users: 100000, products: 100000, orders: 1000000, events: 5000000 },
  monster: { users: 10000000, products: 2000000, orders: 100000000, events: 1000000000 },
};
export function counts(b) {
  return {
    users: b.users,
    addresses: b.users * 2,
    sellers: Math.min(500, b.users),
    categories: Math.min(250, b.products),
    brands: Math.min(100, b.products),
    products: b.products,
    product_variants: b.products * 2,
    product_categories: b.products * 2,
    product_media: b.products * 2,
    warehouses: 5,
    inventory: b.products * 2,
    stock_movements: b.products * 4,
    carts: b.users,
    cart_items: b.users * 3,
    coupons: 100,
    orders: b.orders,
    order_items: b.orders * 3,
    order_status_history: b.orders * 3,
    payments: b.orders,
    shipments: b.orders,
    shipment_events: b.orders * 3,
    returns: Math.max(1, Math.floor(b.orders / 20)),
    refunds: Math.max(1, Math.floor(b.orders / 20)),
    reviews: b.products,
    wishlists: b.users,
    wishlist_items: b.users * 3,
    conversations: b.users,
    conversation_participants: b.users * 2,
    messages: b.users * 20,
    support_tickets: b.users,
    ticket_messages: b.users * 4,
    notifications: b.users * 5,
    browsing_sessions: b.users * 3,
    browsing_events: b.events,
    audit_logs: b.users * 5,
  };
}
const int = (max, min = 1) => faker.number.int({ min, max });
const choice = (xs) => faker.helpers.arrayElement(xs);
const mod = (i, n) => ((i - 1) % n) + 1;
const orderForItem = (i) => Math.floor((i - 1) / 3) + 1;
const customer = (o, c) => mod(o, c.users);
const itemPrice = (o, line) => 1000 + ((o * 37 + line * 101) % 90000);
const itemQty = (o, line) => 1 + ((o + line) % 3);
export const orderTotal = (o) => [0, 1, 2].reduce((s, l) => s + itemPrice(o, l) * itemQty(o, l), 0);
export const orderDate = (o) =>
  new Date(Date.UTC(2023, 0, 1) + (o % 1000000) * 60000).toISOString();
const later = (o, minutes) => new Date(Date.parse(orderDate(o)) + minutes * 60000).toISOString();
const date = () =>
  faker.date.between({ from: '2022-01-01T00:00:00Z', to: '2025-01-01T00:00:00Z' }).toISOString();
const txt = () => faker.lorem.paragraph();
const json = () =>
  JSON.stringify({
    source: choice(['web', 'app', 'campaign']),
    device: choice(['mobile', 'desktop']),
    notes: txt(),
  });
// Campos: nombre SQL / tipo SQL / función generadora. Los precios son centavos.
const col = (name, type, fn) => ({ name, type, fn });
const fk = (name, target, fn) =>
  col(name, `bigint NOT NULL REFERENCES ${target}(id)`, fn ?? ((i, c) => int(c[target])));
const text = (name, fn = txt) => col(name, 'text NOT NULL', fn);
const money = (name, fn = () => int(100000)) =>
  col(name, 'bigint NOT NULL CHECK (' + name + ' >= 0)', fn);
const time = (name, fn = date) => col(name, 'timestamptz NOT NULL', fn);
const num = (name, fn) => col(name, 'integer NOT NULL', fn);
const meta = () => text('metadata_text', json); // JSON deliberadamente guardado como TEXT.
const t = (name, ...columns) => ({
  name,
  columns: [col('id', 'bigint PRIMARY KEY', (i) => i), ...columns],
});
export const tables = [
  t(
    'users',
    text('email', (i) => `user${i}@example.test`),
    text('full_name', () => faker.person.fullName()),
    text('phone', () => faker.phone.number()),
    text('role', () => choice(['customer', 'customer', 'staff'])),
    time('created_at'),
    meta(),
  ),
  t(
    'addresses',
    fk('user_id', 'users', (i, c) => mod(i, c.users)),
    text('street', () => faker.location.streetAddress()),
    text('city', () => faker.location.city()),
    text('country', () => 'AR'),
    text('postal_code', () => faker.location.zipCode()),
  ),
  t(
    'sellers',
    fk('owner_id', 'users', (i) => i),
    text('name', () => faker.company.name()),
    text('description'),
    time('created_at'),
  ),
  t(
    'categories',
    col('parent_id', 'bigint REFERENCES categories(id)', (i) =>
      i <= 10 ? null : Math.floor((i - 1) / 10),
    ),
    text('name', (i) => `Categoría ${i} ${faker.commerce.department()}`),
    text('slug', (i) => `category-${i}`),
    text('description'),
  ),
  t(
    'brands',
    text('name', () => faker.company.name()),
    text('description'),
  ),
  t(
    'products',
    fk('seller_id', 'sellers'),
    fk('brand_id', 'brands'),
    fk('category_id', 'categories'),
    text('name', () => faker.commerce.productName()),
    text('description', () => faker.commerce.productDescription() + ' ' + txt()),
    money('base_price_cents'),
    text('status', () => choice(['active', 'active', 'archived'])),
    time('created_at'),
    meta(),
  ),
  t(
    'product_variants',
    fk('product_id', 'products', (i, c) => mod(i, c.products)),
    text('sku', (i) => `SKU-${i}`),
    text('color', () => faker.color.human()),
    text('size', () => choice(['S', 'M', 'L', 'XL'])),
    money('price_cents'),
    meta(),
  ),
  t(
    'product_categories',
    fk('product_id', 'products', (i, c) => mod(i, c.products)),
    fk('category_id', 'categories', (i, c) => mod(i, c.categories)),
  ),
  t(
    'product_media',
    fk('product_id', 'products', (i, c) => mod(i, c.products)),
    text('url', (i) => `https://assets.example.test/product/${i}.jpg`),
    text('alt_text', () => faker.commerce.productName()),
  ),
  t(
    'warehouses',
    text('name', (i) => `Depósito ${i}`),
    text('city', () => faker.location.city()),
  ),
  t(
    'inventory',
    fk('variant_id', 'product_variants', (i) => i),
    fk('warehouse_id', 'warehouses', (i, c) => mod(i, c.warehouses)),
    num('quantity', () => int(1000, 0)),
    num('reserved', () => 0),
    time('updated_at'),
  ),
  t(
    'stock_movements',
    fk('inventory_id', 'inventory', (i, c) => mod(i, c.inventory)),
    num('delta', () => int(50, -50)),
    text('reason', () => choice(['purchase', 'sale', 'adjustment'])),
    time('created_at'),
  ),
  t(
    'carts',
    fk('user_id', 'users', (i) => i),
    text('status', () => choice(['active', 'abandoned'])),
    time('updated_at'),
  ),
  t(
    'cart_items',
    fk('cart_id', 'carts', (i, c) => mod(i, c.carts)),
    fk('variant_id', 'product_variants'),
    num('quantity', () => int(5)),
  ),
  t(
    'coupons',
    text('code', (i) => `PROMO-${i}`),
    num('discount_percent', () => int(50)),
    time('expires_at', () => '2026-12-31T00:00:00Z'),
  ),
  t(
    'orders',
    fk('user_id', 'users', customer),
    fk('address_id', 'addresses', customer),
    col('coupon_id', 'bigint REFERENCES coupons(id)', () => null),
    text('status', () => 'delivered'),
    text('currency', () => 'ARS'),
    money('total_cents', orderTotal),
    text('customer_email_snapshot', (i, c) => `user${customer(i, c)}@example.test`),
    time('created_at', orderDate),
    meta(),
  ),
  t(
    'order_items',
    fk('order_id', 'orders', orderForItem),
    fk('variant_id', 'product_variants', (i, c) => mod(i, c.product_variants)),
    text('product_name_snapshot', () => faker.commerce.productName()),
    num('quantity', (i) => itemQty(orderForItem(i), (i - 1) % 3)),
    money('unit_price_cents', (i) => itemPrice(orderForItem(i), (i - 1) % 3)),
  ),
  t(
    'order_status_history',
    fk('order_id', 'orders', orderForItem),
    text('status', (i) => ['created', 'paid', 'delivered'][(i - 1) % 3]),
    time('created_at', (i) => later(orderForItem(i), [0, 5, 2880][(i - 1) % 3])),
  ),
  t(
    'payments',
    fk('order_id', 'orders', (i) => i),
    money('amount_cents', orderTotal),
    text('provider', () => choice(['mercadopago', 'stripe', 'bank'])),
    text('status', () => 'captured'),
    text('external_reference', (i) => `PAY-${i}`),
    time('created_at', (i) => later(i, 5)),
    meta(),
  ),
  t(
    'shipments',
    fk('order_id', 'orders', (i) => i),
    fk('warehouse_id', 'warehouses'),
    text('carrier', () => choice(['correo', 'andreani', 'oca'])),
    text('tracking_code', (i) => `TRACK-${i}`),
    text('status', () => 'delivered'),
    time('shipped_at', (i) => later(i, 1440)),
    time('delivered_at', (i) => later(i, 2880)),
  ),
  t(
    'shipment_events',
    fk('shipment_id', 'shipments', orderForItem),
    text('status', (i) => ['dispatched', 'in_transit', 'delivered'][(i - 1) % 3]),
    text('location', () => faker.location.city()),
    time('created_at', (i) => later(orderForItem(i), [1440, 2160, 2880][(i - 1) % 3])),
  ),
  t(
    'returns',
    fk('order_id', 'orders', (i) => i),
    fk('order_item_id', 'order_items', (i) => (i - 1) * 3 + 1),
    text('reason', () => choice(['damaged', 'wrong_size', 'changed_mind'])),
    text('status', () => 'refunded'),
    time('created_at', (i) => later(i, 4320)),
  ),
  t(
    'refunds',
    fk('return_id', 'returns', (i) => i),
    fk('payment_id', 'payments', (i) => i),
    money('amount_cents', (i) => itemPrice(i, 0) * itemQty(i, 0)),
    time('created_at', (i) => later(i, 5760)),
  ),
  t(
    'reviews',
    fk('user_id', 'users'),
    fk('product_id', 'products', (i) => i),
    num('rating', () => int(5)),
    text('title', () => faker.lorem.sentence()),
    text('body'),
    time('created_at'),
  ),
  t(
    'wishlists',
    fk('user_id', 'users', (i) => i),
    text('name', () => 'Favoritos'),
  ),
  t(
    'wishlist_items',
    fk('wishlist_id', 'wishlists', (i, c) => mod(i, c.wishlists)),
    fk('product_id', 'products'),
    time('created_at'),
  ),
  t(
    'conversations',
    fk('customer_id', 'users', (i) => i),
    fk('seller_id', 'sellers', (i, c) => mod(i, c.sellers)),
    text('subject', () => faker.lorem.sentence()),
    time('created_at', () => '2022-01-01T00:00:00Z'),
  ),
  t(
    'conversation_participants',
    fk('conversation_id', 'conversations', (i) => Math.ceil(i / 2)),
    fk('user_id', 'users', (i, c) => (i % 2 ? Math.ceil(i / 2) : mod(Math.ceil(i / 2), c.sellers))),
    text('role', (i) => (i % 2 ? 'customer' : 'seller')),
  ),
  t(
    'messages',
    fk('conversation_id', 'conversations', (i) => Math.ceil(i / 20)),
    fk('sender_id', 'users', (i, c) =>
      i % 2 ? Math.ceil(i / 20) : mod(Math.ceil(i / 20), c.sellers),
    ),
    text('body', (i, c, o) => faker.lorem.paragraphs(o.messageParagraphs)),
    col('read_at', 'timestamptz', () => null),
    time('created_at', (i) => new Date(Date.UTC(2022, 0, 1) + i * 1000).toISOString()),
    meta(),
  ),
  t(
    'support_tickets',
    fk('user_id', 'users', (i, c) => customer(mod(i, c.orders), c)),
    fk('order_id', 'orders', (i, c) => mod(i, c.orders)),
    text('subject', () => faker.lorem.sentence()),
    text('priority', () => choice(['low', 'normal', 'urgent'])),
    text('status', () => choice(['open', 'resolved'])),
    time('created_at', () => '2025-01-01T00:00:00Z'),
  ),
  t(
    'ticket_messages',
    fk('ticket_id', 'support_tickets', (i) => Math.ceil(i / 4)),
    fk('author_id', 'users', (i, c) => customer(mod(Math.ceil(i / 4), c.orders), c)),
    text('body'),
    time('created_at', (i) => new Date(Date.UTC(2025, 0, 1) + i * 1000).toISOString()),
  ),
  t(
    'notifications',
    fk('user_id', 'users', (i, c) => mod(i, c.users)),
    text('channel', () => choice(['email', 'push', 'sms'])),
    text('subject', () => faker.lorem.sentence()),
    text('body'),
    text('status', () => choice(['pending', 'sent'])),
    time('created_at'),
  ),
  t(
    'browsing_sessions',
    fk('user_id', 'users', (i, c) => mod(i, c.users)),
    text('device', () => choice(['mobile', 'desktop'])),
    text('ip', () => faker.internet.ipv4()),
    time('started_at', () => '2022-01-01T00:00:00Z'),
  ),
  t(
    'browsing_events',
    fk('session_id', 'browsing_sessions', (i, c) => mod(i, c.browsing_sessions)),
    fk('product_id', 'products'),
    text('event_type', () => choice(['view', 'search', 'add_to_cart', 'click'])),
    text('url', () => faker.internet.url()),
    time('created_at'),
    meta(),
  ),
  t(
    'audit_logs',
    fk('user_id', 'users'),
    text('entity_type', () => choice(['product', 'order', 'user'])),
    text('action', () => choice(['create', 'update', 'login'])),
    text('payload_text', (i, c, o) =>
      JSON.stringify({
        before: json(),
        after: json(),
        noise: faker.string.alphanumeric(o.payloadBytes),
      }),
    ),
    time('created_at'),
  ),
];
export function row(table, id, c, options) {
  // Cada fila tiene su propia semilla: reanudar y cambiar lote no altera los datos.
  const tableIndex = tables.indexOf(table) + 1;
  faker.seed([options.seed, tableIndex, id % 4294967296, Math.floor(id / 4294967296)]);
  return table.columns.map((column) => column.fn(id, c, options));
}
export const schema = `-- Laboratorio deliberadamente sin índices secundarios ni particiones.
-- Importes en centavos; PK y FK preservan integridad referencial.
BEGIN;
CREATE TABLE seed_runs (id integer PRIMARY KEY CHECK (id = 1), config jsonb NOT NULL);
CREATE TABLE seed_progress (table_name text PRIMARY KEY, last_id bigint NOT NULL);
${tables.map((t) => `CREATE TABLE ${t.name} (\n  ${t.columns.map((c) => `${c.name} ${c.type}`).join(',\n  ')}\n);`).join('\n\n')}
COMMIT;
`;
